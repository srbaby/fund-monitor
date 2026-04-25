// Jany 基金看板 - 全局状态与本地存储中心
// 职责：内存状态、localStorage 读写、口令备份恢复、公共工具函数

// 全局运行状态
let funds = [];
let _lastResults = [];

// 公共工具：获取当前激活的产品列表（全局复用，消除三处重复定义）
function getActiveProducts() {
  return funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);
}

// 基金列表
function loadFunds() {
  const c = localStorage.getItem(STORE_CODES);
  funds = c ? JSON.parse(c) : [...DEFAULT_CODES];
}
function saveFunds() {
  localStorage.setItem(STORE_CODES, JSON.stringify(funds));
}

// PE 定锚
function loadPe() {
  const s = localStorage.getItem(STORE_PE);
  return s ? JSON.parse(s) : null;
}
function savePe(dataObj) {
  localStorage.setItem(STORE_PE, JSON.stringify(dataObj));
}

// 持仓份额
function loadHoldings() {
  const c = localStorage.getItem(STORE_HOLDINGS);
  return c ? {...DEFAULT_HOLDINGS, ...JSON.parse(c)} : {...DEFAULT_HOLDINGS};
}
function saveHoldingsData(h) {
  localStorage.setItem(STORE_HOLDINGS, JSON.stringify(h));
}

// 口令备份与恢复
function exportSnapshot() {
  const data = {
    f: funds,
    h: loadHoldings(),
    p: loadPe(),
    s: JSON.parse(localStorage.getItem(STORE_SELL_PLAN) || '{}')
  };
  return btoa(encodeURIComponent(JSON.stringify(data)));
}
function importSnapshot(str) {
  try {
    const data = JSON.parse(decodeURIComponent(atob(str)));
    if (data.f && Array.isArray(data.f)) { funds = data.f; saveFunds(); }
    if (data.h) saveHoldingsData(data.h);
    if (data.p) savePe(data.p);
    if (data.s) localStorage.setItem(STORE_SELL_PLAN, JSON.stringify(data.s));
    return true;
  } catch(e) {
    return false;
  }
}