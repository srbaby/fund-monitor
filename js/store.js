// ============================================================
// store.js - 存储层
// 职责：全局内存状态、localStorage 读写、口令备份恢复、公共工具函数
// 不含 DOM 操作，不含网络请求
// ============================================================

// ---- 全局内存状态 ----
let funds = [];
let _lastResults = [];

// ---- 纯工具 ----
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 防御性 JSON 解析
function safeParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

// 核心逻辑重构：严格基于实时抓取数据，预置库仅作兜底
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

// ---- 基金列表 ----
function loadFunds() {
  const c = localStorage.getItem(STORE_CODES);
  funds = c ? safeParse(c, [...DEFAULT_CODES]) : [...DEFAULT_CODES];
}
function saveFunds() {
  localStorage.setItem(STORE_CODES, JSON.stringify(funds));
}

// ---- PE 定锚 ----
function loadPe() {
  return safeParse(localStorage.getItem(STORE_PE), null);
}
function savePe(dataObj) {
  localStorage.setItem(STORE_PE, JSON.stringify(dataObj));
}

// ---- 持仓份额 ----
let _holdingsCache = null;

function _loadRaw() {
  if (_holdingsCache) return _holdingsCache;
  const raw = safeParse(localStorage.getItem(STORE_HOLDINGS), null);

  if (!raw) return null;
  if (typeof raw === "object" && !raw.shares && !raw.equity) {
    _holdingsCache = { shares: raw, equity: {}, shortNames: {} };
  } else {
    _holdingsCache = raw;
  }
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
}

// ---- 优先卖出品种 ----
function loadPrioritySell() {
  return localStorage.getItem(STORE_PRIORITY_SELL);
}
function savePrioritySell(code) {
  localStorage.setItem(STORE_PRIORITY_SELL, code);
}
function clearPrioritySell() {
  localStorage.removeItem(STORE_PRIORITY_SELL);
}

// ---- 口令备份与恢复 ----
function exportSnapshot() {
  const data = {
    f: funds,
    h: safeParse(localStorage.getItem(STORE_HOLDINGS), {}),
    p: loadPe(),
    s: safeParse(localStorage.getItem(STORE_SELL_PLAN), {}),
    pr: loadPrioritySell() || null,
  };
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

function importSnapshot(str) {
  try {
    const data = JSON.parse(decodeURIComponent(atob(str)));
    if (data.f && Array.isArray(data.f)) {
      funds = data.f;
      saveFunds();
    }
    if (data.h) {
      _holdingsCache = null;
      localStorage.setItem(STORE_HOLDINGS, JSON.stringify(data.h));
    }
    if (data.p) savePe(data.p);
    if (data.s) localStorage.setItem(STORE_SELL_PLAN, JSON.stringify(data.s));
    if (data.pr) savePrioritySell(data.pr);
    else clearPrioritySell();
    return true;
  } catch (e) {
    return false;
  }
}
