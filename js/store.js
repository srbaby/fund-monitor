// ============================================================
// store.js - 存储层 (v3.1 响应式状态中心)
// 职责：全局内存状态、localStorage、广播通知 (Observer)
// ============================================================

// ---- 全局内存状态 ----
let funds = [];
let _lastResults = [];
let _indicesMap = {};
let _indicesMeta = {
  mode: "empty",
  source: null,
  receivedAt: null,
  quoteAt: null,
};
let _prioritySellCode = null;
let _cloudStatus = { count: 0, ok: false }; // 已填字段数 / 填了的是否全部验证通过
const _INDICES_SNAPSHOT_KEY = "fm_indices_snapshot_v1";

function getPrioritySellCode() {
  return _prioritySellCode;
}
function setPrioritySellCode(code) {
  _prioritySellCode = code;
}
function getCloudStatus() {
  return _cloudStatus;
}
function setCloudStatus(s) {
  _cloudStatus = s;
}

// ---- 广播电台 (频道化 Observer) ----
const _observers = {};
function observeState(topic, fn) {
  if (!_observers[topic]) _observers[topic] = [];
  _observers[topic].push(fn);
}
function dispatchUpdate(topic) {
  if (_observers[topic]) _observers[topic].forEach((fn) => fn());
}

// ---- 纯工具 ----
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function safeParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

// iOS Safari 无痕/隐私浏览或存储受限时，localStorage.getItem/setItem 会抛 SecurityError。
// 裸调用会在初始化早期(updatePeBar 首读)抛异常，中断整条 init 链 → 整页卡在“系统初始化中”。
// 全部 localStorage 读写走以下安全外壳：抛错时降级为内存态(读返回 null、写静默失败)，看板照常运行、只是不落盘。
function _lsGet(k) {
  try {
    return window.localStorage.getItem(k);
  } catch (e) {
    return null;
  }
}
function _lsSet(k, v) {
  try {
    window.localStorage.setItem(k, v);
    return true;
  } catch (e) {
    return false;
  }
}
function _lsRemove(k) {
  try {
    window.localStorage.removeItem(k);
  } catch (e) {}
}

// ---- 核心获取业务产品 ----
function getActiveProducts() {
  const equityMap = loadHoldingsEquity();
  const shortNameMap = loadShortNames();
  return funds.map((code) => {
    const preset = PRODUCTS.find((p) => p.code === code);
    const equity =
      equityMap[code] != null ? equityMap[code] : (preset?.equity ?? 0);
    const fetched = _lastResults.find((r) => r.code === code);
    const fetchedName =
      fetched && !fetched.error && fetched.name ? fetched.name : null;
    const name =
      shortNameMap[code] ||
      SHORT_NAMES[code] ||
      fetchedName ||
      NAMES[code] ||
      code;
    return { code, name, equity };
  });
}

// ---- 数据读写与定向广播 ----
function getLastResults() {
  return _lastResults;
}
function setLastResults(res) {
  _lastResults = res;
  dispatchUpdate("FUNDS");
}

function getIndices() {
  return _indicesMap;
}
function getIndicesMeta() {
  return _indicesMeta;
}
function _loadIndicesSnapshot() {
  try {
    const snapshot = safeParse(
      _lsGet(_INDICES_SNAPSHOT_KEY),
      null,
    );
    if (!snapshot?.map || Object.keys(snapshot.map).length === 0) return null;
    return snapshot;
  } catch (e) {
    return null;
  }
}
function _saveIndicesSnapshot(snapshot) {
  try {
    _lsSet(_INDICES_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (e) {}
}
function setIndices(map, meta = {}) {
  _indicesMap = map;
  _indicesMeta = {
    mode: meta.mode || "live",
    source: meta.source || null,
    receivedAt: meta.receivedAt || Date.now(),
    quoteAt: meta.quoteAt || null,
  };
  if (_indicesMeta.mode === "live") {
    _saveIndicesSnapshot({ map: _indicesMap, ..._indicesMeta });
  }
  dispatchUpdate("INDICES");
}
function setIndicesUnavailable() {
  const snapshot = _loadIndicesSnapshot();
  const cachedMap =
    snapshot?.map ||
    (Object.keys(_indicesMap).length > 0 ? _indicesMap : null);
  if (cachedMap) {
    _indicesMap = cachedMap;
    _indicesMeta = {
      mode: "stale",
      source: "cache",
      receivedAt: snapshot?.receivedAt || _indicesMeta.receivedAt || null,
      quoteAt: snapshot?.quoteAt || _indicesMeta.quoteAt || null,
    };
  } else {
    _indicesMap = {};
    _indicesMeta = {
      mode: "empty",
      source: null,
      receivedAt: null,
      quoteAt: null,
    };
  }
  dispatchUpdate("INDICES");
}

function loadFunds() {
  const c = _lsGet(STORE_CODES);
  funds = c ? safeParse(c, [...DEFAULT_CODES]) : [...DEFAULT_CODES];
}
function saveFunds(newFunds) {
  if (newFunds) funds = newFunds;
  _lsSet(STORE_CODES, JSON.stringify(funds));
  bumpConfigVer();
  fmLog("saveFunds", { funds });
  dispatchUpdate("FUNDS");
}

function loadPe() {
  return safeParse(_lsGet(STORE_PE), null);
}
function savePe(dataObj) {
  _lsSet(STORE_PE, JSON.stringify(dataObj));
  fmLog("savePe", dataObj);
  dispatchUpdate("LOCAL_CONFIG");
}

// ---- 旁路PE引擎（Gist夜间数据 + 腾讯实时快照）----
let _qqIndex = null;
function getQQIndex() {
  return _qqIndex;
}
function setQQIndex(d) {
  _qqIndex = d;
  dispatchUpdate("INDICES");
}

let _peEngine; // undefined=未读, null=无数据
function loadPeEngine() {
  if (_peEngine === undefined)
    _peEngine = safeParse(_lsGet(STORE_PE_ENGINE), null);
  return _peEngine;
}
function setPeEngine(data) {
  if (!data || !Array.isArray(data.peSorted) || !data.peSorted.length) return;
  _peEngine = data;
  _lsSet(STORE_PE_ENGINE, JSON.stringify(data));
  dispatchUpdate("INDICES");
}

let _holdingsCache = null;
function _loadRaw() {
  if (_holdingsCache) return _holdingsCache;
  const raw = safeParse(_lsGet(STORE_HOLDINGS), null);
  if (!raw) return null;
  if (typeof raw === "object" && !raw.shares && !raw.equity)
    _holdingsCache = { shares: raw, equity: {}, shortNames: {} };
  else _holdingsCache = raw;
  return _holdingsCache;
}

function loadHoldings() {
  return _loadRaw()?.shares || {};
}
function loadHoldingsEquity() {
  return _loadRaw()?.equity || {};
}
function loadShortNames() {
  return _loadRaw()?.shortNames || {};
}

function saveHoldingsData(shares, equity, shortNames) {
  _holdingsCache = null;
  _lsSet(
    STORE_HOLDINGS,
    JSON.stringify({ shares, equity, shortNames }),
  );
  bumpConfigVer();
  fmLog("saveHoldingsData", { shares, equity, shortNames });
  dispatchUpdate("LOCAL_CONFIG");
}

function loadSellPlan() {
  return safeParse(_lsGet(STORE_SELL_PLAN), {});
}
function saveSellPlan(plan) {
  _lsSet(STORE_SELL_PLAN, JSON.stringify(plan));
  // s 属版本化配置。目前唯一调用点紧跟在会自增的 saveHoldingsData 之后，
  // 但版本自增不该依赖兄弟调用——单独调用本函数时同样必须收敛。
  bumpConfigVer();
  fmLog("saveSellPlan", plan);
}

// ---- 盘中估算缓存（直连模式收盘后保留最后估值，见 D-018）----
// 结构 { ts, data }。**刻意不存日期**——新旧一律由每条估算自带的 estimateAt 判定。
// 旧实现存了 date 且 Gist 兜底回写时无条件盖成今天，把隔周数据洗成"当日"，
// 配合当时缺失的陈旧标记，用户完全无从察觉。没有这个字段，那个 bug 就无处可藏。
// ts 只作整份丢弃的硬上限，不参与新旧判断。
function saveEstCache(estMap) {
  _lsSet(STORE_EST_CACHE, JSON.stringify({ ts: Date.now(), data: [...estMap] }));
}
function loadEstCacheEntry() {
  const entry = safeParse(_lsGet(STORE_EST_CACHE), null);
  if (!entry?.data || Date.now() - entry.ts > EST_CACHE_MAX_AGE)
    return null;
  return entry;
}
function loadEstCache(codes) {
  const entry = loadEstCacheEntry();
  if (!entry) return null;
  const cached = new Map(entry.data);
  const filtered = new Map();
  for (const code of codes) {
    if (cached.has(code)) filtered.set(code, cached.get(code));
  }
  return filtered.size ? filtered : null;
}
function loadEstGistDate() {
  return _lsGet(STORE_EST_GIST_DATE) || "";
}
function markEstGistPushed() {
  _lsSet(STORE_EST_GIST_DATE, todayDateStr());
}

// ---- Gist 云同步配置 ----
function loadGistConfig() {
  return {
    id: _lsGet(STORE_GIST_ID) || "",
    token: _lsGet(STORE_GIST_TOKEN) || "",
  };
}
function saveGistConfig(id, token) {
  _lsSet(STORE_GIST_ID, id);
  _lsSet(STORE_GIST_TOKEN, token);
}
function clearGistConfig() {
  _lsRemove(STORE_GIST_ID);
  _lsRemove(STORE_GIST_TOKEN);
}
function isCloudConfigured() {
  const { id, token } = loadGistConfig();
  return !!(id && token);
}

function loadPrioritySell() {
  return _lsGet(STORE_PRIORITY_SELL);
}
function savePrioritySell(code) {
  _lsSet(STORE_PRIORITY_SELL, code);
  bumpConfigVer();
  fmLog("savePrioritySell", { code });
  dispatchUpdate("LOCAL_CONFIG");
}
function clearPrioritySell() {
  _lsRemove(STORE_PRIORITY_SELL);
  bumpConfigVer();
  fmLog("clearPrioritySell", null);
  dispatchUpdate("LOCAL_CONFIG");
}

function loadConfigVer() {
  return _lsGet(STORE_CONFIG_VER) || "";
}
function bumpConfigVer() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const v = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  _lsSet(STORE_CONFIG_VER, v);
  return v;
}

// 只更新 PE 定锚；内容与本地相同时返回 false 跳过
function importPeSnapshot(p) {
  if (!p) return false;
  if (JSON.stringify(loadPe()) === JSON.stringify(p)) return false;
  _lsSet(STORE_PE, JSON.stringify(p));
  fmLog("importPeSnapshot", p);
  dispatchUpdate("LOCAL_CONFIG");
  return true;
}

function importSnapshot(data) {
  try {
    if (!data || !data.f) return false;
    const remoteV = data.v || "";
    if (remoteV <= loadConfigVer()) return false;
    if (Array.isArray(data.f)) {
      funds = data.f;
      _lsSet(STORE_CODES, JSON.stringify(funds));
    }
    if (data.h) {
      _holdingsCache = null;
      _lsSet(STORE_HOLDINGS, JSON.stringify(data.h));
    }
    if (data.s) _lsSet(STORE_SELL_PLAN, JSON.stringify(data.s));
    if (data.pr) _lsSet(STORE_PRIORITY_SELL, data.pr);
    else _lsRemove(STORE_PRIORITY_SELL);
    _lsSet(STORE_CONFIG_VER, remoteV);
    fmLog("importSnapshot", {
      v: remoteV,
      f: data.f,
      h: data.h,
      s: data.s,
      pr: data.pr,
    });
    dispatchUpdate("FUNDS");
    dispatchUpdate("LOCAL_CONFIG");
    return true;
  } catch (e) {
    return false;
  }
}
