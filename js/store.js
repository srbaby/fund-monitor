// ============================================================
// store.js - 存储层
// 职责：全局内存状态、localStorage 读写、口令备份恢复、公共工具函数
// 不含 DOM 操作，不含网络请求
// ============================================================

// ---- 全局内存状态 ----
let funds = [];
let _lastResults = [];

// ---- 纯工具（下沉至此层，供 data/engine/ui 共用）----
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- 公共工具 ----
// 核心逻辑重构：严格基于实时抓取数据，预置库仅作兜底
function getActiveProducts() {
  const equityMap = loadHoldingsEquity();
  const shortNameMap = loadShortNames();
  
  return funds.map((code) => {
    const preset = PRODUCTS.find((p) => p.code === code);
    const equity = equityMap[code] != null ? equityMap[code] : (preset?.equity ?? 0);
    
    // 获取线上实时抓取的全称（脱离本地预置依赖）
    const fetched = _lastResults.find((r) => r.code === code);
    const fetchedName = (fetched && !fetched.error && fetched.name) ? fetched.name : null;

    // 抽屉内名称优先级：
    // 1. 用户录入的自定义简称 (最高)
    // 2. config.js 预设简称 (历史兼容)
    // 3. 线上 API 实时抓取的官方全称 (代码驱动核心)
    // 4. config.js 预设全称兜底
    // 5. 纯代码数字兜底
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
  funds = c ? JSON.parse(c) : [...DEFAULT_CODES];
}
function saveFunds() {
  localStorage.setItem(STORE_CODES, JSON.stringify(funds));
}

// ---- PE 定锚 ----
function loadPe() {
  const s = localStorage.getItem(STORE_PE);
  return s ? JSON.parse(s) : null;
}
function savePe(dataObj) {
  localStorage.setItem(STORE_PE, JSON.stringify(dataObj));
}

// ---- 持仓份额 ----
// 存储结构 v2：{shares: {code: number}, equity: {code: number}, shortNames: {code: string}}
// 自动兼容旧结构（纯 {code: number}）：判断是否存在 shares/equity 键
// 内存缓存：同一帧内多次调用只解析一次 JSON，写入时清缓存
let _holdingsCache = null;

function _loadRaw() {
  if (_holdingsCache) return _holdingsCache;
  const c = localStorage.getItem(STORE_HOLDINGS);
  if (!c) return null;
  const raw = JSON.parse(c);
  
  if (raw && typeof raw === 'object' && !raw.shares && !raw.equity) {
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
  _holdingsCache = null; // 清缓存
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
  const holdingsRaw = localStorage.getItem(STORE_HOLDINGS);
  const data = {
    f: funds,
    h: holdingsRaw ? JSON.parse(holdingsRaw) : {},
    p: loadPe(),
    s: JSON.parse(localStorage.getItem(STORE_SELL_PLAN) || "{}"),
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
