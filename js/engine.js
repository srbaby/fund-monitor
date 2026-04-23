// ==========================================
// Jany 基金看板 - 纯物理计算引擎与基础工具库
// 职责：时间状态机、格式化、以及纯数学计算（无任何存储副作用）
// ==========================================

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
// 2. 核心财务公式 (依赖 store.js 共享的 _lastResults 和 funds)
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
// 3. PE 拉格朗日定锚模型
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

// ==========================================
// 4. 交易预案推演纯粹数学引擎 (剥离自 UI 层)
// ==========================================
function calcBuyPlanDraft(holdings) {
  const eqResult = calcCurrentEquity(holdings);
  if (!eqResult) return null;
  const { total: totalVal, equity: currentEq } = eqResult;
  const targetEq = getDynamicTarget('buy') || 34.0;

  const currentEqVal = totalVal * currentEq / 100;
  const targetEqVal = totalVal * targetEq / 100;
  const buyAmt = Math.max(0, targetEqVal - currentEqVal);

  const xqNav = getNavByCode(SYS_CONFIG.CODE_XQ) || 1.0;
  const a500cNav = getNavByCode(SYS_CONFIG.CODE_A500) || 1.0;
  const zz500cNav = getNavByCode(SYS_CONFIG.CODE_ZZ500) || 1.0;

  const sellXqShares = buyAmt / xqNav;

  // 单品 20% 红线校验
  const currA500CVal = (holdings[SYS_CONFIG.CODE_A500] || 0) * a500cNav;
  const maxA500CVal = totalVal * SYS_CONFIG.LIMIT_A500C;
  const a500cRoom = Math.max(0, maxA500CVal - currA500CVal);

  const allocA500C = Math.min(buyAmt, a500cRoom);
  const allocZZ500C = buyAmt - allocA500C;

  return { totalVal, currentEq, targetEq, buyAmt, sellXqShares, allocA500C, allocZZ500C, a500cNav, zz500cNav };
}

function calcSellExecutionDraft(holdings, ratios, priorityCode) {
  const eqResult = calcCurrentEquity(holdings);
  if(!eqResult) return { error: true };

  const targetEq = getDynamicTarget('sell') || 25.0;
  const {equity: currentEq, total: totalVal} = eqResult;
  const currentEqVal = totalVal * currentEq / 100;
  const targetEqVal = totalVal * targetEq / 100;

  let sellNeededEq = Math.max(0, currentEqVal - targetEqVal);
  const sellProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(p => p && p.equity > 0);

  let totalRatio = 0;
  sellProducts.forEach(p => { if(p.code !== priorityCode) totalRatio += (ratios[p.code] || 0); });

  let afterEqVal = currentEqVal;
  let totalCashOut = 0;
  let totalFriction = 0;
  const results = {};
  let hasAnySell = false;

  // 1. 优先卖出额度抵扣
  if (priorityCode) {
    const pPri = sellProducts.find(p => p.code === priorityCode);
    if (pPri) {
      const nav = getNavByCode(pPri.code) || 1.0;
      const maxSellAmount = (holdings[pPri.code] || 0) * nav;
      const maxEqContribution = maxSellAmount * pPri.equity;
      const actualEqToSell = Math.min(sellNeededEq, maxEqContribution);
      const actualSellAmt = actualEqToSell / pPri.equity;

      results[pPri.code] = { amt: actualSellAmt, nav };
      sellNeededEq -= actualEqToSell;
    }
  }

  // 2. 剩余额度按比例分配
  sellProducts.forEach(p => {
    if (p.code === priorityCode) return;
    const nav = getNavByCode(p.code) || 1.0;

    if (!totalRatio || !(ratios[p.code])) {
      results[p.code] = { amt: 0, nav };
      return;
    }

    const eqQuota = sellNeededEq * (ratios[p.code] / totalRatio);
    const maxSellAmount = (holdings[p.code] || 0) * nav;
    const actualSellAmt = Math.min(eqQuota / p.equity, maxSellAmount);
    results[p.code] = { amt: actualSellAmt, nav };
  });

  // 3. 计算摩擦、到账、剩余权益
  sellProducts.forEach(p => {
    const res = results[p.code] || {amt: 0, nav: getNavByCode(p.code) || 1.0};
    if (!res.amt) return;

    hasAnySell = true;
    const feeAmt = res.amt * SYS_CONFIG.FEE;
    const cashOut = res.amt - feeAmt;
    const eqDropVal = res.amt * p.equity;

    afterEqVal -= eqDropVal;
    totalCashOut += cashOut;
    totalFriction += feeAmt;
    res.fee = feeAmt;
    res.cashOut = cashOut;
    res.eqDropPct = (eqDropVal / totalVal) * 100;
    res.shares = res.amt / res.nav;
  });

  const afterEqPct = afterEqVal / totalVal * 100;
  const diffEqPct = Math.max(0, currentEq - targetEq);

  return { totalVal, currentEq, targetEq, diffEqPct, hasAnySell, totalCashOut, totalFriction, afterEqPct, results };
}