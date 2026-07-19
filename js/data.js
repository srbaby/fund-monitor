// ============================================================
// data.js - 数据获取层
// 职责：网络请求、数据标准化输出、更新 store 状态
// ============================================================

const officialBatchCache = {};

function _fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: controller.signal,
  })
    .then((response) => {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .finally(() => clearTimeout(timer));
}

function _unavailable() {
  return { source: "unavailable", data: new Map() };
}

// 取一组网关数据。整组主备判定在网关内完成，前端只消费结果；
// 请求失败、ok=false 或结构不符一律降级为不可用整组，绝不把半组数据交给渲染层。
async function _fetchGroup(path, timeoutMs) {
  try {
    const payload = await _fetchJson(API_BASE + path, timeoutMs);
    if (!payload?.ok || !Array.isArray(payload.data)) return _unavailable();
    return {
      source: payload.status,
      data: new Map(payload.data.map((item) => [item.code, item])),
    };
  } catch (e) {
    return _unavailable();
  }
}

function _normalizeCodes(codes) {
  return [
    ...new Set(codes.map((code) => String(code).trim().padStart(6, "0"))),
  ].filter((code) => /^\d{6}$/.test(code));
}

function _officialCacheTtl(data) {
  const now = new Date();
  const timeNum = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  const dates = [...(data?.values?.() || [])]
    .map((item) => item?.officialAt)
    .filter(Boolean);
  const isTodayData =
    dates.length > 0 && dates.every((date) => date === todayDateStr());
  return isTodayData || day === 0 || day === 6
    ? 12 * 3600000
    : timeNum >= SYS_CONFIG.T_OFF_UPDATE
      ? 5 * 60000
      : 3600000;
}

async function fetchOfficialData(codes) {
  const uniqueCodes = _normalizeCodes(codes);
  if (uniqueCodes.length === 0) {
    return _unavailable();
  }

  const cacheKey = uniqueCodes.join(",");
  const cached = officialBatchCache[cacheKey];
  if (cached && Date.now() - cached.ts < _officialCacheTtl(cached.value.data)) {
    return cached.value;
  }

  const group = await _fetchGroup(
    "/v1/funds/official?codes=" + uniqueCodes.join(","),
    SYS_CONFIG.FETCH_OFF_TIMEOUT,
  );
  if (group.source === "unavailable") {
    delete officialBatchCache[cacheKey];
    return group;
  }
  officialBatchCache[cacheKey] = { ts: Date.now(), value: group };
  return group;
}

// 盘中估算不缓存：网关侧已有 15 秒缓存，前端再叠一层只会让估算滞后
function fetchEstimates(codes) {
  const uniqueCodes = _normalizeCodes(codes);
  if (uniqueCodes.length === 0) {
    return Promise.resolve(_unavailable());
  }
  return _fetchGroup(
    "/v1/funds/estimate?codes=" + uniqueCodes.join(","),
    SYS_CONFIG.FETCH_EST_TIMEOUT,
  );
}

function fetchSingleFund(code, official, estimate) {
  const key = String(code).trim().padStart(6, "0");
  const est = estimate.data.get(key) || null;
  const off = official.data.get(key) || null;
  const sources = { estSource: estimate.source, offSource: official.source };
  if (!est && !off) return { code, error: true, ...sources };
  return {
    code,
    error: false,
    name: est?.name || NAMES[code] || off?.name || "基金 " + code,
    estPct: est?.estimatePct ?? null,
    // 净值统一补足4位小数，否则 1.236 会当作 "1.236" 直接显示
    estVal: est?.estimateNav != null ? est.estimateNav.toFixed(4) : null,
    estTime: est?.estimateAt || null,
    offPct: off?.officialPct ?? null,
    offVal: off?.officialNav != null ? off.officialNav.toFixed(4) : null,
    offDate: off?.officialAt || null,
    ...sources,
    baseNav: est?.baseNav ?? null,
    baseDate: est?.baseDate || null,
  };
}

let _indicesPromise = null;

function _numberOrNaN(value) {
  if (value == null || value === "") return NaN;
  return Number(value);
}

function _isValidIndices(map) {
  return INDICES.every(({ id }) => {
    const d = map?.[id];
    return (
      d?.f12 === id &&
      Number.isFinite(d.f2) &&
      d.f2 > 0 &&
      Number.isFinite(d.f3)
    );
  });
}

function _latestQuoteAt(map) {
  const values = Object.values(map)
    .map((d) => d.quoteAt || d.f124)
    .filter(Boolean);
  values.sort();
  return values.length ? values[values.length - 1] : null;
}

async function _fetchIndexGroup() {
  const group = await _fetchGroup("/v1/indices", SYS_CONFIG.FETCH_INDEX_TIMEOUT);
  if (group.source === "unavailable") return null;
  const map = {};
  group.data.forEach((item, id) => {
    map[id] = {
      f2: _numberOrNaN(item.price),
      f3: _numberOrNaN(item.changePct),
      f12: id,
      f14: item.name || INDICES.find((idx) => idx.id === id)?.lbl || id,
      f124: item.quoteAt || null,
      quoteAt: item.quoteAt || null,
    };
  });
  if (!_isValidIndices(map)) return null;
  return { map, group };
}

function fetchIndices() {
  if (_indicesPromise) return _indicesPromise;
  _indicesPromise = (async () => {
    const result = await _fetchIndexGroup();
    if (!result) {
      setIndicesUnavailable();
      return;
    }
    setIndices(result.map, {
      mode: "live",
      source: result.group.source,
      receivedAt: Date.now(),
      quoteAt: _latestQuoteAt(result.map),
    });
    // 旁路PE引擎的 1.0 总市值路与 2.0 点位路，锚定沪深300 实时快照。
    // 备用线路只有点位、没有总市值，仍要写入：2.0 走点位照常可算，
    // 1.0 由 getEnginePE1 自己的 mcap>0 判据回落昨收，不在这里一刀切掉两路。
    const anchor = result.group.data.get(SYS_CONFIG.IDX_PE);
    if (anchor?.price > 0) {
      setQQIndex({
        price: anchor.price,
        ts: anchor.quoteAt || "",
        pe: anchor.pe,
        mcap: anchor.marketCap,
      });
    }
  })().finally(() => {
    _indicesPromise = null;
  });
  return _indicesPromise;
}

function getNavByCode(code) {
  const f = getLastResults().find((r) => r.code === code);
  if (!f) return null;
  const offD = f.offDate ? f.offDate.slice(0, 10) : "",
    estD = f.estTime ? f.estTime.slice(0, 10) : "";
  if (f.offVal && (!estD || offD >= estD)) return parseFloat(f.offVal);
  if (f.estVal) return parseFloat(f.estVal);
  return null;
}

async function _cloudReadFile(gistId, token, filename) {
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: { Authorization: `token ${token}` },
    });
    const data = await res.json();
    return JSON.parse(data.files[filename].content);
  } catch (e) {
    console.error("Cloud Pull Failed", filename, e);
    return null;
  }
}

async function _cloudWriteFile(gistId, token, filename, payload) {
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: { [filename]: { content: JSON.stringify(payload) } },
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("Cloud Push Failed", filename, e);
    return false;
  }
}

function cloudFetchPe(gistId, token) {
  return _cloudReadFile(gistId, token, GIST_FILE_PE);
}
function cloudFetchConfig(gistId, token) {
  return _cloudReadFile(gistId, token, GIST_FILE_CONFIG);
}
function cloudFetchPeEngine(gistId, token) {
  return _cloudReadFile(gistId, token, GIST_FILE_PE_ENGINE);
}
function cloudUpdatePe(gistId, token, peData) {
  return _cloudWriteFile(gistId, token, GIST_FILE_PE, peData);
}
function cloudUpdateConfig(gistId, token, payload) {
  return _cloudWriteFile(gistId, token, GIST_FILE_CONFIG, payload);
}
