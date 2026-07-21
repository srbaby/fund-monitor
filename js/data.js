// ============================================================
// data.js - 数据获取层
// 职责：网络请求、数据标准化输出、更新 store 状态
// ============================================================

const officialBatchCache = {};
let _estGistReadTs = 0; // Gist 兜底读的节流时间戳，成败均推进（负缓存，见 D-018）

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
    : timeNum >= T_OFF_UPDATE
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

// 盘中估算链。**官方净值已不走这里**——它统一从采集器 KV 取（D-023 修订），
// 故本函数只产出 estimate 一条链。in-flight 去重保留：同一次刷新内若有并发调用只打一次上游。
const _txFundInflight = new Map();
async function _fetchTencentFunds(codes) {
  const key = codes.join(",");
  if (_txFundInflight.has(key)) return _txFundInflight.get(key);
  const promise = (async () => {
    const url = `${TX_BASE}/q=` + codes.map((c) => `jj${c}`).join(",");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_OFF_TIMEOUT);
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

// 字段布局（与 parsers.mjs parseTencentEstimates 一致）：
//   [1]名称 [2]估算净值 [3]估算% [4]估算时间 [5]官方净值 [7]官方% [8]官方日期
// 只取估算块 [2][3][4]；baseNav/baseDate 仍借 [5][8]（= 最新确认净值，估算的基数）。
// **官方块 [5][7][8] 不再产出条目**——官方净值统一走采集器 KV（D-023 修订），
// 这里再解析一份就是两条并存的取数路径，正是那次修订要消除的东西。
function _parseTencentFunds(text, codes) {
  const quotes = _parseTxAssignments(text);
  const estimate = new Map();
  for (const code of codes) {
    const fields = quotes.get(`jj${code}`);
    if (!fields || fields.length < 9) continue;
    const estimateNav = _txNum(fields[2]);
    const estimatePct = _txNum(fields[3]);
    const estimateAt = _txDate(fields[4]);
    if (estimateNav != null && estimateNav > 0 && estimatePct != null && estimateAt) {
      estimate.set(code, {
        code,
        name: fields[1] || NAMES[code] || null,
        estimateNav,
        estimatePct,
        estimateAt,
        baseNav: _txNum(fields[5]),
        baseDate: _txDate(fields[8]),
      });
    }
  }
  return { estimate };
}

// 指数直连：单请求覆盖全部指数。字段布局与 parsers.mjs parseTencentIndices 对齐：
//   [1]名称 [3]点位 [32]涨跌% [30]时间 [39]PE [45]市值
async function _fetchIndexGroupTencent() {
  const qqList = INDICES.map((idx) => TX_INDEX_QQ[idx.id]).filter(Boolean);
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

// 官方净值：**全站唯一来源是采集器 KV，不再看 DATA_MODE**（D-023 修订）。
// `DATA_MODE` 从此只管盘中数据（估算、指数）——官方净值那两条老链路已经删干净，
// 别再往这里加"直连兜底"：浏览器侧东财被 61136 拦、腾讯只有一路，兜不出第二个源，
// 加回来只是把已经收敛的取数路径重新摊开。KV 拿不到就走下面的 officialBatchCache。
//
// 每条自带 navSource / navAt =「谁先抢到 / 何时抢到」，透传到 fetchSingleFund，
// 表头与卡片的「腾讯 2」就是数它们算出来的。
//
// **不再要求 payload.date === 今天**：盘中 / 周末 / 节假日本来就没有「今日记录」，
// 读端点会回退到 nav:latest（上一交易日）。officialAt 取记录自带日期，
// 于是 getNavByCode 的市值口径与 calcTodayProfit 的收益口径各自照旧判新旧，无需感知回退。
let _navCollectorCache = { ts: 0, value: null };
async function _fetchNavCollector() {
  if (Date.now() - _navCollectorCache.ts < NAV_COLLECTOR_TTL)
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
          officialAt: payload.date,
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

  const group = (await _fetchNavCollector()) || _unavailable();
  if (group.source === "unavailable") {
    delete officialBatchCache[cacheKey];
    return group;
  }
  officialBatchCache[cacheKey] = { ts: Date.now(), value: group };
  return group;
}

// 盘中估算：直连模式带 localStorage 持久化 + Gist 跨设备兜底。
// 收盘后腾讯返回 0 → parse 滤空 → 回退缓存，避免估值列直接变"--"。
function fetchEstimates(codes) {
  const uniqueCodes = _normalizeCodes(codes);
  if (uniqueCodes.length === 0) {
    return Promise.resolve(_unavailable());
  }
  if (DATA_MODE === "direct") {
    return (async () => {
      const r = await _fetchTencentFunds(uniqueCodes);
      if (r && r.estimate.size) {
        saveEstCache(r.estimate);
        return { source: "tencent", data: r.estimate };
      }
      // 本次无新估算 → 回退本地缓存
      const lsCached = loadEstCache(uniqueCodes);
      if (lsCached) return { source: "cached", data: lsCached };
      // 本地无缓存 → Gist 跨设备兜底。节流且失败也推进时间戳：
      // 估算源断供时 fm_est.json 可能长期不存在，只在成功时节流等于没节流，
      // 会退化成每 60 秒一次注定 404 的认证请求，还串在刷新的 await 链上。
      if (Date.now() - _estGistReadTs < EST_GIST_READ_THROTTLE)
        return _unavailable();
      _estGistReadTs = Date.now();
      const { id, token } = loadGistConfig();
      if (!id || !token) return _unavailable();
      const gistData = await cloudReadEst(id, token);
      const gistMap = new Map(gistData?.data || []);
      const filtered = new Map();
      for (const code of uniqueCodes) {
        if (gistMap.has(code)) filtered.set(code, gistMap.get(code));
      }
      if (!filtered.size) return _unavailable();
      saveEstCache(filtered); // 落到本地，下次秒回
      return { source: "gist", data: filtered };
    })();
  }
  return _fetchGroup(
    "/v1/funds/estimate?codes=" + uniqueCodes.join(","),
    FETCH_EST_TIMEOUT,
  );
}

// Gist 快照：收盘后推一次当日最后的估算（fire-and-forget，不阻塞刷新）。
// **时机由 interact 的 refreshData 按 POST_MARKET 决定，不在这里判**——getMarketState 属
// engine 层，而 data 与 engine 平级互不依赖（docs/02 §2.2）。
// 旧实现挂在每次估算成功之后，推的是当日第一笔（09:31 开盘估算），与 D-014 的「收盘后」相悖。
// 标记改为推送成功后才落：先落会让一次失败吞掉当天仅有的机会。
function pushEstToGist() {
  const today = todayDateStr();
  if (loadEstGistDate() === today) return;
  const { id, token } = loadGistConfig();
  if (!id || !token) return;
  const entry = loadEstCacheEntry();
  if (!entry) return;
  setTimeout(async () => {
    const ok = await cloudUpdateEst(id, token, {
      date: today,
      updatedAt: new Date().toISOString(),
      data: entry.data,
    });
    if (ok) {
      markEstGistPushed();
      console.log("✅ 估算快照已同步 Gist");
    }
  }, 0);
}

// 涨跌幅一律规整到 2 位小数，**在数据入口统一，不留给渲染层**（D-023）。
// 上游精度本就不一致：东财 NAVCHGRT 给 2 位（"1.70"），腾讯给 4 位（"1.7039"）。
// 渲染层的 fp() 早就 toFixed(2)，所以**显示从来是一致的**——但原始值会漏进两处判断：
//   1. calcFlash 逐字比较 pr.offPct !== f.offPct → 源切换时 1.7039 ≠ 1.70 成立，
//      触发涨跌闪烁动画，可界面上数字纹丝未动（都是 1.70）。伪闪烁。
//   2. calcTodayProfit 直接拿 offPct 算收益 → 同一只基金的今日收益随源切换微跳。
// 统一到 2 位后两处自然消停。精度代价：单只最多 0.005%，10 万持仓约 5 元，
// 远小于净值本身 4 位小数的量化误差，可忽略。
function _pct2(value) {
  return value == null || !Number.isFinite(Number(value))
    ? null
    : Number(Number(value).toFixed(2));
}

function fetchSingleFund(code, official, estimate) {
  const key = String(code).trim().padStart(6, "0");
  const est = estimate.data.get(key) || null;
  const off = official.data.get(key) || null;
  // offSource 优先读条目自带的源（采集器逐只记账，官方列因此**可能混源**，
  // 与 D-002「整组同源」的差别见 D-023）；整组 source 只作没有逐条信息时的兜底。
  const sources = {
    estSource: estimate.source,
    offSource: off?.navSource || official.source,
  };
  if (!est && !off) return { code, error: true, ...sources };
  return {
    code,
    error: false,
    name: est?.name || NAMES[code] || off?.name || "基金 " + code,
    estPct: _pct2(est?.estimatePct),
    // 净值统一补足4位小数，否则 1.236 会当作 "1.236" 直接显示
    estVal: est?.estimateNav != null ? est.estimateNav.toFixed(4) : null,
    estTime: est?.estimateAt || null,
    offPct: _pct2(off?.officialPct),
    offVal: off?.officialNav != null ? off.officialNav.toFixed(4) : null,
    offDate: off?.officialAt || null,
    // 采集器抢到该只的时刻。ui 用它挑出「今晚最早那条」定标签名，直连补的条目没有此字段，
    // 自然不参与抢先计算（它本来也说不清是谁先）。
    offAt: off?.navAt || null,
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
  // direct 模式指数是**单源**：曾接过新浪备源，但 hq.sinajs.cn 不返回 CORS 头，
  // 浏览器 fetch 必失败，代码恒返回 null，已删（D-020 代价栏留了考证）。
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
function cloudReadEst(gistId, token) {
  return _cloudReadFile(gistId, token, GIST_FILE_EST);
}
function cloudUpdateEst(gistId, token, data) {
  return _cloudWriteFile(gistId, token, GIST_FILE_EST, data);
}
