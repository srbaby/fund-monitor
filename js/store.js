// ============================================================
// store.js - 存储层
// 职责：全局内存状态、localStorage 读写、口令备份恢复、公共工具函数
// 不含 DOM 操作，不含网络请求
// ============================================================

// ---- 全局内存状态 ----
let funds        = [];
let _lastResults = [];

// ---- 公共工具 ----
// name 优先级：用户录入简称 → PRODUCTS 预设名 → SHORT_NAMES → NAMES → 代码
// equity 优先级：用户录入 → PRODUCTS 预设 → 0
// PRODUCTS 不再做白名单过滤，所有关注基金均纳入
function getActiveProducts() {
  const equityMap    = loadHoldingsEquity();
  const shortNameMap = loadShortNames();
  return funds.map(code => {
    const preset = PRODUCTS.find(p => p.code === code);
    const equity = equityMap[code] != null ? equityMap[code] : (preset?.equity ?? 0);
    const name   = shortNameMap[code] || preset?.name || SHORT_NAMES[code] || NAMES[code] || code;
    return {code, name, equity};
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
// 自动兼容旧结构（纯 {code: number}）：若第一个值为 number 则视为旧版迁移
function _loadRaw() {
  const c = localStorage.getItem(STORE_HOLDINGS);
  if (!c) return null;
  const raw = JSON.parse(c);
  if (raw && typeof Object.values(raw)[0] === 'number') return {shares: raw, equity: {}, shortNames: {}};
  return raw;
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
  localStorage.setItem(STORE_HOLDINGS, JSON.stringify({shares, equity, shortNames}));
}

// ---- 口令备份与恢复（完整带 shortNames） ----
function exportSnapshot() {
  const holdingsRaw = localStorage.getItem(STORE_HOLDINGS);
  const data = {
    f: funds,
    h: holdingsRaw ? JSON.parse(holdingsRaw) : {},
    p: loadPe(),
    s: JSON.parse(localStorage.getItem(STORE_SELL_PLAN) || '{}')
  };
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

function importSnapshot(str) {
  try {
    const data = JSON.parse(decodeURIComponent(atob(str)));
    if (data.f && Array.isArray(data.f)) { funds = data.f; saveFunds(); }
    if (data.h) localStorage.setItem(STORE_HOLDINGS, JSON.stringify(data.h));
    if (data.p) savePe(data.p);
    if (data.s) localStorage.setItem(STORE_SELL_PLAN, JSON.stringify(data.s));
    return true;
  } catch(e) {
    return false;
  }
}
