// 全局运行状态与缓存
let funds = [];
let _lastResults = [];

// ==========================================
// 1. 基础工具与状态机
// ==========================================
function getMarketState() {
  const n = new Date(); const d = n.getDay(), t = n.getHours() * 60 + n.getMinutes();
  if (d === 0 || d === 6) return 'WEEKEND';
  if (t < SYS_CONFIG.T_PRE_MARKET) return 'BEFORE_PRE';
  if (t < SYS_CONFIG.T_OPEN) return 'PRE_MARKET';
  if ((t >= SYS_CONFIG.T_OPEN && t < SYS_CONFIG.T_MID_BREAK) || 
      (t >= SYS_CONFIG.T_AFTERNOON && t < SYS_CONFIG.T_CLOSE)) return 'TRADING';
  if (t >= SYS_CONFIG.T_MID_BREAK && t < SYS_CONFIG.T_AFTERNOON) return 'MID_BREAK';
  return 'POST_MARKET';
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmt(n, decimals=0) { return (n==null || isNaN(n)) ? '--' : n.toLocaleString('zh-CN',{minimumFractionDigits:decimals, maximumFractionDigits:decimals}); }
function fmtMoney(n) { return '¥' + fmt(n, 0); }
function getProductName(code) { return SHORT_NAMES[code] || (PRODUCTS.find(p=>p.code===code)?.name) || code; }

// ==========================================
// 2. 本地存储 (LocalStorage) 抽象
// ==========================================
function loadFunds(){ const c = localStorage.getItem(STORE_CODES); funds = (c && c !== '[]') ? JSON.parse(c) : [...DEFAULT_CODES]; }
function saveFunds(){ localStorage.setItem(STORE_CODES, JSON.stringify(funds)); }
function loadPe(){ const s = localStorage.getItem(STORE_PE); return s ? JSON.parse(s) : null; }
function savePe(dataObj){ localStorage.setItem(STORE_PE, JSON.stringify(dataObj)); localStorage.setItem(STORE_PE_DATE, new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})); }
function loadHoldings(){ const c = localStorage.getItem(STORE_HOLDINGS); return c ? {...DEFAULT_HOLDINGS, ...JSON.parse(c)} : {...DEFAULT_HOLDINGS}; }
function saveHoldingsData(h){ localStorage.setItem(STORE_HOLDINGS, JSON.stringify(h)); }

// ==========================================
// 3. 核心财务公式
// ==========================================
function getNavByCode(code){
  const f = _lastResults.find(r => r.code === code);
  if(!f) return null;
  const offD = f.offDate ? f.offDate.slice(0, 10) : '';
  const estD = f.estTime ? f.estTime.slice(0, 10) : '';
  // 优先用当日官方净值，否则回退估算
  if (f.offVal && (!estD || offD >= estD)) return parseFloat(f.offVal);
  if (f.estVal) return parseFloat(f.estVal);
  return f.offVal ? parseFloat(f.offVal) : null;
}

function calcCurrentEquity(holdings){
  let total = 0, eq = 0;
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);
  activeProducts.forEach(p => {
    const shares = holdings[p.code] || 0; if(!shares) return;
    const nav = getNavByCode(p.code); if(nav == null) return; 
    const val = shares * nav;
    total += val; eq += val * p.equity;
  });
  return total > 0 ? { equity: eq / total * 100, total } : null;
}

// ==========================================
// 4. PE 拉格朗日定锚模型
// ==========================================
function getCurrentPE() {
  const peData = loadPe();
  if(!peData || !peData.bucketStr) return null;
  
  let v = peData.peYest; 
  let isDynamic = false;
  const [loStr, hiStr] = peData.bucketStr.split(',');
  const buyPct = parseFloat(loStr) - SYS_CONFIG.DEAD_ZONE; 
  const sellPct = parseFloat(hiStr) + SYS_CONFIG.DEAD_ZONE; 
  
  if(window._rt_csi300_price && peData.priceAnchor && peData.priceBuy && peData.priceSell) {
    const x = window._rt_csi300_price;          
    const x1 = peData.priceBuy, y1 = buyPct;
    const x2 = peData.priceAnchor, y2 = peData.peYest;  
    const x3 = peData.priceSell, y3 = sellPct;
    
    if (x === x2) { v = y2; isDynamic = true; } 
    else if (x1 !== x2 && x2 !== x3 && x1 !== x3) {
      // 拉格朗日三点插值法
      v = y1 * ((x - x2) * (x - x3)) / ((x1 - x2) * (x1 - x3)) + 
          y2 * ((x - x1) * (x - x3)) / ((x2 - x1) * (x2 - x3)) + 
          y3 * ((x - x1) * (x - x2)) / ((x3 - x1) * (x3 - x2));
      isDynamic = true;
    } else {
      // 降级为线性映射
      const range = x3 - x1;
      if (range > 0) { v = y1 + ((x - x1) / range) * (y3 - y1); isDynamic = true; }
    }
  }
  return { value: v, isDynamic: isDynamic, rawData: peData, bounds: {buyPct, sellPct} };
}

function getDynamicTarget(mode) {
  const currentPE = getCurrentPE();
  if (!currentPE || !currentPE.rawData || !currentPE.rawData.bucketStr) return null;
  const lo = parseFloat(currentPE.rawData.bucketStr.split(',')[0]);
  const currentIndex = PE_EQUITY_TABLE.findIndex(x => lo >= x.lo && lo < x.hi);
  
  if (currentIndex === -1) return null;
  if (mode === 'buy') return PE_EQUITY_TABLE[Math.min(currentIndex + 1, PE_EQUITY_TABLE.length - 1)].target;
  else if (mode === 'sell') return PE_EQUITY_TABLE[Math.max(currentIndex - 1, 0)].target;
  else return PE_EQUITY_TABLE[currentIndex].target;
}