// ============================================================
// store.js - 存储层 (v3.1 响应式状态中心)
// 职责：全局内存状态、localStorage、广播通知 (Observer)
// ============================================================

// ---- 全局内存状态 ----
let funds = [];
let _lastResults = [];
let _indicesMap = {};
let _prioritySellCode = null;

function getPrioritySellCode() {
  return _prioritySellCode;
}
function setPrioritySellCode(code) {
  _prioritySellCode = code;
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
function saveFunds(newFunds) {
  if (newFunds) funds = newFunds;
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

function loadSellPlan() {
  return safeParse(localStorage.getItem(STORE_SELL_PLAN), {});
}
function saveSellPlan(plan) {
  localStorage.setItem(STORE_SELL_PLAN, JSON.stringify(plan));
}

// ---- Gist 云同步配置 ----
function loadGistConfig() {
  return {
    id: localStorage.getItem(STORE_GIST_ID) || "",
    token: localStorage.getItem(STORE_GIST_TOKEN) || "",
  };
}
function saveGistConfig(id, token) {
  localStorage.setItem(STORE_GIST_ID, id);
  localStorage.setItem(STORE_GIST_TOKEN, token);
}
function clearGistConfig() {
  localStorage.removeItem(STORE_GIST_ID);
  localStorage.removeItem(STORE_GIST_TOKEN);
}
function isCloudConfigured() {
  const { id, token } = loadGistConfig();
  return !!(id && token);
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

function exportSnapshot() {
  const data = {
    f: funds,
    h: safeParse(localStorage.getItem(STORE_HOLDINGS), {}),
    p: loadPe(),
    s: loadSellPlan(),
    pr: loadPrioritySell() || null,
  };
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

function importSnapshot(str) {
  try {
    const data = JSON.parse(decodeURIComponent(atob(str)));
    if (data.f && Array.isArray(data.f)) saveFunds(data.f);
    if (data.h) {
      _holdingsCache = null;
      localStorage.setItem(STORE_HOLDINGS, JSON.stringify(data.h));
    }
    if (data.p) savePe(data.p);
    if (data.s) saveSellPlan(data.s);
    if (data.pr) savePrioritySell(data.pr);
    else clearPrioritySell();
    dispatchUpdate("FUNDS");
    dispatchUpdate("LOCAL_CONFIG");
    return true;
  } catch (e) {
    return false;
  }
}
