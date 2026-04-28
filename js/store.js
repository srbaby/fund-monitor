// ============================================================
// store.js - 存储层 (v3.1 架构师重构版 - 微任务防抖)
// 职责：全局内存状态、localStorage、广播通知 (Observer)
// 铁律：所有的外部数据修改必须通过此文件的封装方法进行
// ============================================================

let funds = [];
let _lastResults = [];
let _indicesMap = {};

// ---- 广播电台 (频道化 Observer & 防抖) ----
const _observers = {};
const _pendingUpdates = new Set();

function observeState(topic, fn) {
  if (!_observers[topic]) _observers[topic] = [];
  _observers[topic].push(fn);
}

// [架构师优化]：引入微任务防抖 (Microtask Debounce)，将同一事件循环内的多次同步触发合并为一次渲染，杜绝性能损耗
function dispatchUpdate(topic) {
  if (_pendingUpdates.has(topic)) return;
  _pendingUpdates.add(topic);
  Promise.resolve().then(() => {
    _pendingUpdates.delete(topic);
    if (_observers[topic]) _observers[topic].forEach((fn) => fn());
  });
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
function setIndices(map) {
  _indicesMap = map;
  dispatchUpdate("INDICES");
}

function loadFunds() {
  const c = localStorage.getItem(STORE_CODES);
  funds = c ? safeParse(c, [...DEFAULT_CODES]) : [...DEFAULT_CODES];
}

// [架构师优化]：封装对 funds 数组的修改，防止外部直写污染
function updateFundsList(newList) {
  funds = newList;
  saveFunds();
}

function saveFunds() {
  localStorage.setItem(STORE_CODES, JSON.stringify(funds));
  dispatchUpdate("FUNDS");
}

function loadPe() {
  return safeParse(localStorage.getItem(STORE_PE), null);
}
function savePe(dataObj) {
  localStorage.setItem(STORE_PE, JSON.stringify(dataObj));
  dispatchUpdate("LOCAL_CONFIG");
}

let _holdingsCache = null;
function _loadRaw() {
  if (_holdingsCache) return _holdingsCache;
  const raw = safeParse(localStorage.getItem(STORE_HOLDINGS), null);
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
  localStorage.setItem(
    STORE_HOLDINGS,
    JSON.stringify({ shares, equity, shortNames }),
  );
  dispatchUpdate("LOCAL_CONFIG");
}

function loadPrioritySell() {
  return localStorage.getItem(STORE_PRIORITY_SELL);
}
function savePrioritySell(code) {
  localStorage.setItem(STORE_PRIORITY_SELL, code);
  dispatchUpdate("LOCAL_CONFIG");
}
function clearPrioritySell() {
  localStorage.removeItem(STORE_PRIORITY_SELL);
  dispatchUpdate("LOCAL_CONFIG");
}

// [架构师优化]：封装预案读取与写入接口，堵死越权漏洞
function loadSellPlanConfig() {
  return safeParse(localStorage.getItem(STORE_SELL_PLAN), {});
}
function saveSellPlanConfig(planObj) {
  localStorage.setItem(STORE_SELL_PLAN, JSON.stringify(planObj));
}

// ---- 快照备份 ----
function exportSnapshot() {
  const data = {
    f: funds,
    h: safeParse(localStorage.getItem(STORE_HOLDINGS), {}),
    p: loadPe(),
    s: loadSellPlanConfig(),
    pr: loadPrioritySell() || null,
  };
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

function importSnapshot(str) {
  try {
    const data = JSON.parse(decodeURIComponent(atob(str)));
    // 防抖机制生效，以下代码不会引发连续多次的卡顿重绘
    if (data.f && Array.isArray(data.f)) {
      updateFundsList(data.f); 
    }
    if (data.h) {
      _holdingsCache = null;
      localStorage.setItem(STORE_HOLDINGS, JSON.stringify(data.h));
      dispatchUpdate("LOCAL_CONFIG");
    }
    if (data.p) savePe(data.p);
    if (data.s) saveSellPlanConfig(data.s);
    if (data.pr) savePrioritySell(data.pr);
    else clearPrioritySell();
    
    return true;
  } catch (e) {
    return false;
  }
}
