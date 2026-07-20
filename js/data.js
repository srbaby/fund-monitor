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

// ============================================================
// 腾讯行情直连（DATA_MODE === "direct"）
// 单域名、单请求覆盖「官方净值 + 盘中估算」两链（基金），指数单独单请求。
// 返回 GBK，必须用 TextDecoder("gbk")，不能用 UTF-8（否则中文名乱码、字段错位）。
// 字段布局与网关 parsers.mjs 的 parseTencent* 逐字段对齐，产物字段名与网关一致，
// 保证 fetchSingleFund / setIndices / setQQIndex 无需感知来源。
// ============================================================

function _txNum(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 日期/时间归一：接受 "YYYY-MM-DD" / "YYYY-MM-DD HH:MM:SS" / 14位 / 10~13位时间戳。
// 与网关 parsers.mjs formatQuoteAt 同口径。
function _txDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`;
  }
  if (/^\d{10,13}$/.test(text)) {
    const epoch = Number(text.length === 10 ? text + "000" : text);
    if (Number.isFinite(epoch)) {
      return new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
        .format(new Date(epoch))
        .replace(",", "");
    }
  }
  return /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(text) ? text : null;
}

// 解析腾讯 `v_xxx="...";` 赋值串，返回 code → ["~"分割字段] 的 Map。
function _parseTxAssignments(text) {
  const quotes = new Map();
  const pattern = /v_([^=\s]+)="([\s\S]*?)"\s*;/g;
  for (const m of text.matchAll(pattern)) quotes.set(m[1], m[2].split("~"));
  return quotes;
}

// 一次请求同时拆出官方净值链与盘中估算链。in-flight 去重保证同一次刷新内
// fetchOfficialData 与 fetchEstimates 并发只打一次上游（与网关 router.mjs inflight 同思路）。
const _txFundInflight = new Map();
async function _fetchTencentFunds(codes) {
  const key = codes.join(",");
  if (_txFundInflight.has(key)) return _txFundInflight.get(key);
  const promise = (async () => {
    const url = `${TX_BASE}/q=` + codes.map((c) => `jj${c}`).join(",");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYS_CONFIG.FETCH_OFF_TIMEOUT);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const buf = await res.arrayBuffer();
      const text = new TextDecoder("gbk").decode(buf);
      return _parseTencentFunds(text, codes);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => _txFundInflight.delete(key));
  _txFundInflight.set(key, promise);
  return promise;
}

// 字段布局（与 parsers.mjs parseTencentEstimates / 官方块一致）：
//   [1]名称 [2]估算净值 [3]估算% [4]估算时间 [5]官方净值 [7]官方% [8]官方日期
// 官方块走 [5][7][8]；估算块走 [2][3][4]，baseNav/baseDate 借 [5][8]（= 最新确认净值）。
function _parseTencentFunds(text, codes) {
  const quotes = _parseTxAssignments(text);
  const official = new Map();
  const estimate = new Map();
  for (const code of codes) {
    const fields = quotes.get(`jj${code}`);
    if (!fields || fields.length < 9) continue;
    const name = fields[1] || NAMES[code] || null;
    const officialNav = _txNum(fields[5]);
    const officialPct = _txNum(fields[7]);
    const officialAt = _txDate(fields[8]);
    if (officialNav != null && officialNav > 0 && officialPct != null && officialAt) {
      official.set(code, { code, name, officialNav, officialPct, officialAt });
    }
    const estimateNav = _txNum(fields[2]);
    const estimatePct = _txNum(fields[3]);
    const estimateAt = _txDate(fields[4]);
    if (estimateNav != null && estimateNav > 0 && estimatePct != null && estimateAt) {
      estimate.set(code, {
        code,
        name,
        estimateNav,
        estimatePct,
        estimateAt,
        baseNav: _txNum(fields[5]),
        baseDate: _txDate(fields[8]),
      });
    }
  }
  return { official, estimate };
}

// 指数直连：单请求覆盖全部指数。字段布局与 parsers.mjs parseTencentIndices 对齐：
//   [1]名称 [3]点位 [32]涨跌% [30]时间 [39]PE [45]市值
async function _fetchIndexGroupTencent() {
  const qqList = INDICES.map((idx) => TX_INDEX_QQ[idx.id]).filter(Boolean);
  if (qqList.length === 0) return null;
  const url = `${TX_BASE}/q=` + qqList.join(",");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYS_CONFIG.FETCH_INDEX_TIMEOUT);
  let text;
  try {
    const res = await fetch(url, { signal: controller.signal });
    const buf = await res.arrayBuffer();
    text = new TextDecoder("gbk").decode(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const quotes = _parseTxAssignments(text);
  const map = {};
  const dataMap = new Map();
  for (const idx of INDICES) {
    const fields = quotes.get(TX_INDEX_QQ[idx.id]);
    if (!fields || fields.length < 46) continue;
    const price = _txNum(fields[3]);
    const changePct = _txNum(fields[32]);
    if (price == null || price <= 0 || changePct == null) continue;
    const quoteAt = _txDate(fields[30]);
    map[idx.id] = {
      f2: price,
      f3: changePct,
      f12: idx.id,
      f14: fields[1] || idx.lbl,
      f124: quoteAt,
      quoteAt,
    };
    dataMap.set(idx.id, {
      price,
      quoteAt,
      pe: _txNum(fields[39]),
      marketCap: _txNum(fields[45]),
    });
  }
  if (!_isValidIndices(map)) return null;
  return { map, group: { source: "tencent", data: dataMap } };
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

  let group;
  if (DATA_MODE === "direct") {
    const r = await _fetchTencentFunds(uniqueCodes);
    group = r && r.official.size ? { source: "tencent", data: r.official } : _unavailable();
  } else {
    group = await _fetchGroup(
      "/v1/funds/official?codes=" + uniqueCodes.join(","),
      SYS_CONFIG.FETCH_OFF_TIMEOUT,
    );
  }
  if (group.source === "unavailable") {
    delete officialBatchCache[cacheKey];
    return group;
  }
  officialBatchCache[cacheKey] = { ts: Date.now(), value: group };
  return group;
}

// 盘中估算不缓存：网关侧已有 15 秒缓存，前端再叠一层只会让估算滞后。
// 直连模式同样不缓存（但 _fetchTencentFunds 的 in-flight 去重保证与官方链并发只打一次）。
function fetchEstimates(codes) {
  const uniqueCodes = _normalizeCodes(codes);
  if (uniqueCodes.length === 0) {
    return Promise.resolve(_unavailable());
  }
  if (DATA_MODE === "direct") {
    return _fetchTencentFunds(uniqueCodes).then((r) =>
      r && r.estimate.size
        ? { source: "tencent", data: r.estimate }
        : _unavailable(),
    );
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
  if (DATA_MODE === "direct") {
    return _fetchIndexGroupTencent();
  }
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
    // 网关退回的陈旧组走 mode:"stale"，复用 idx-bar 既有的「行情暂断 · 显示 HH:MM 数据」
    // 呈现；同时 setIndices 不会用陈旧数据覆盖本地快照，本地那份仍是网关够不着时的第二道防线。
    setIndices(result.map, {
      mode: result.group.source === "stale" ? "stale" : "live",
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
