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

function _officialCacheTtl(data, codesCount) {
  const now = new Date();
  const timeNum = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  const dates = [...(data?.values?.() || [])]
    .map((item) => item?.officialAt)
    .filter(Boolean);
  const isTodayData =
    dates.length > 0 && dates.every((date) => date === todayDateStr());
  // 半成品（今日数据但没采全）→ 5min 短缓存等补采；采全或非交易日 → 12h。
  // 不假设固定时段（用户可能随时改 cron）。codesCount 来自 fetchOfficialData 入参，
  // data.size 是采集器端点返回的实际只数（已过滤 nav>0）。
  const isComplete = !codesCount || data?.size >= codesCount;
  return (isTodayData && isComplete) || day === 0 || day === 6
    ? 12 * 3600000
    : (isTodayData || timeNum >= T_OFF_UPDATE)
      ? 5 * 60000
      : 3600000;
}

// ============================================================
// 腾讯指数行情直连（DATA_MODE === "direct"）
// 返回 GBK，必须用 TextDecoder("gbk")，不能用 UTF-8（否则中文名乱码、字段错位）。
// 基金官方净值统一由采集器 KV 提供；已下线的基金估算接口不再请求。
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

// 指数直连：单请求覆盖 6 个可见指数和 4 个隐藏估算因子。字段布局与 parsers.mjs parseTencentIndices 对齐：
//   [1]名称 [3]点位 [32]涨跌% [30]时间 [39]PE [45]市值
async function _fetchIndexGroupTencent() {
  const allIndices = [...INDICES, ...HIDDEN_INDICES];
  const qqList = allIndices.map((idx) => TX_INDEX_QQ[idx.id]).filter(Boolean);
  if (qqList.length === 0) return null;
  const url = `${TX_BASE}/q=` + qqList.join(",");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_INDEX_TIMEOUT);
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
  for (const idx of allIndices) {
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

// 官方净值：**全站唯一来源是采集器 KV，不看 DATA_MODE**。
// `DATA_MODE` 只管盘中指数/ETF行情——官方净值的浏览器直连链路已经删干净，
// 别再往这里加"直连兜底"：浏览器侧东财被 61136 拦、腾讯只有一路，兜不出第二个源，
// 加回来只是把已经收敛的取数路径重新摊开。KV 拿不到就走下面的 officialBatchCache。
//
// 每条自带 navSource / navAt =「谁先抢到 / 何时抢到」，透传到 fetchSingleFund，
// 表头与卡片的「腾讯 2」就是数它们算出来的。
//
// **不再要求 payload.date === 今天**：盘中 / 周末 / 节假日本来就没有「今日记录」，
// 读端点会回退到最新已公布净值日。officialAt 取记录自带日期，
// 于是 getNavByCode 的市值口径与 calcTodayProfit 的收益口径各自照旧判新旧，无需感知回退。
let _navCollectorCache = { ts: 0, value: null };
async function _fetchNavCollector(force = false) {
  if (!force && Date.now() - _navCollectorCache.ts < NAV_COLLECTOR_TTL)
    return _navCollectorCache.value;
  let value = null;
  try {
    const payload = await _fetchJson(`${NAV_BASE}/v1/nav/today`, FETCH_OFF_TIMEOUT);
    if (payload?.ok && payload.funds && payload.date) {
      const data = new Map();
      for (const [code, item] of Object.entries(payload.funds)) {
        if (!(item?.nav > 0)) continue;
        data.set(code, {
          code,
          name: item.name || NAMES[code] || null,
          officialNav: item.nav,
          officialPct: item.pct,
          previousNav: item.previousNav ?? null,
          previousDate: item.previousDate || null,
          previousPct: item.previousPct ?? null,
          // 逐只用自己的 at 判日期，不用整份响应顶层的 date：端点可能为尚未披露的基金
          // 带回前一净值日条目，那种条目的真实日期比 payload.date 旧。
          officialAt: item.at ? item.at.slice(0, 10) : payload.date,
          navSource: item.src,
          navAt: item.at,
        });
      }
      if (data.size) value = { source: "collector", data };
    }
  } catch {
    value = null;
  }
  // 失败也写缓存（负缓存）：采集器未部署 / 请求失败时，
  // 不该每 60 秒都串一次注定失败的请求在刷新链上。
  _navCollectorCache = { ts: Date.now(), value };
  return value;
}

async function fetchOfficialData(codes, force = false) {
  const uniqueCodes = _normalizeCodes(codes);
  if (uniqueCodes.length === 0) {
    return _unavailable();
  }

  const cacheKey = uniqueCodes.join(",");
  if (!force) {
    const cached = officialBatchCache[cacheKey];
    if (cached && Date.now() - cached.ts < _officialCacheTtl(cached.value.data, uniqueCodes.length)) {
      return cached.value;
    }
  }

  const group = (await _fetchNavCollector(force)) || _unavailable();
  if (group.source === "unavailable") {
    delete officialBatchCache[cacheKey];
    return group;
  }
  officialBatchCache[cacheKey] = { ts: Date.now(), value: group };
  return group;
}

function fetchSingleFund(code, official) {
  const key = String(code).trim().padStart(6, "0");
  const off = official.data.get(key) || null;
  // offSource 优先读条目自带的源：采集器逐只记账，官方列因此可能混源；
  // 整组 source 只作没有逐条信息时的兜底。
  const sources = {
    estSource: "unavailable",
    offSource: off?.navSource || official.source,
  };
  if (!off) return { code, error: true, ...sources };
  return {
    code,
    error: false,
    name: NAMES[code] || off?.name || "基金 " + code,
    estPct: null,
    estVal: null,
    estTime: null,
    offPct: off?.officialPct ?? null,
    offVal: off?.officialNav != null ? off.officialNav.toFixed(4) : null,
    offDate: off?.officialAt || null,
    previousNav: off?.previousNav ?? null,
    previousDate: off?.previousDate || null,
    previousPct: off?.previousPct ?? null,
    // 采集器抢到该只的时刻。ui 用它挑出「今晚最早那条」定标签名，直连补的条目没有此字段，
    // 自然不参与抢先计算（它本来也说不清是谁先）。
    offAt: off?.navAt || null,
    ...sources,
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
  // direct 模式指数是**单源**：新浪接口不返回 CORS 头，浏览器 fetch 不可用。
  // 要恢复主备只能搬回网关（服务端无 CORS 限制）或换带 CORS 的源。
  if (DATA_MODE === "direct") return _fetchIndexGroupTencent();
  const group = await _fetchGroup("/v1/indices", FETCH_INDEX_TIMEOUT);
  if (group.source === "unavailable") return null;
  const map = {};
  group.data.forEach((item, id) => {
    map[id] = {
      f2: _numberOrNaN(item.price),
      f3: _numberOrNaN(item.changePct),
      f12: id,
      f14: item.name ||
        INDICES.find((idx) => idx.id === id)?.lbl ||
        HIDDEN_INDICES.find((idx) => idx.id === id)?.lbl ||
        id,
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
    const anchor = result.group.data.get(IDX_PE);
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
