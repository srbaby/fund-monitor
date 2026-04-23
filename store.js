// ==========================================
// Jany 基金看板 - 全局状态与本地存储中心 (Store)
// 职责：统一管理所有的内存状态变量与 localStorage 读写
// ==========================================

// 1. 全局运行状态与缓存
let funds = [];
let _lastResults = [];

// 2. 本地存储 (LocalStorage) 抽象
function loadFunds(){ 
  const c = localStorage.getItem(STORE_CODES); 
  funds = (c && c !== '[]') ? JSON.parse(c) : [...DEFAULT_CODES]; 
}

function saveFunds(){ 
  localStorage.setItem(STORE_CODES, JSON.stringify(funds)); 
}

function loadPe(){ 
  const s = localStorage.getItem(STORE_PE); 
  return s ? JSON.parse(s) : null; 
}

function savePe(dataObj){ 
  localStorage.setItem(STORE_PE, JSON.stringify(dataObj)); 
  localStorage.setItem(STORE_PE_DATE, new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})); 
}

function loadHoldings(){ 
  const c = localStorage.getItem(STORE_HOLDINGS); 
  return c ? {...DEFAULT_HOLDINGS, ...JSON.parse(c)} : {...DEFAULT_HOLDINGS}; 
}

function saveHoldingsData(h){ 
  localStorage.setItem(STORE_HOLDINGS, JSON.stringify(h)); 
}