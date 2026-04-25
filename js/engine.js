// ============================================================
// engine.js - 计算引擎层
// 职责：市场状态、Lagrange 插值、PE 推算、权益计算、增降权推演、今日盈亏计算
// 纯函数，不含 DOM 操作，不含 localStorage 读写
// ============================================================

// ---- 市场状态机 ----
function getMarketState() {
  const n = new Date();
  const d = n.getDay(), t = n.getHours() * 60 + n.getMinutes();
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

// ---- Lagrange 三点插值，推算实时 PE ----
function getCurrentPE() {
  const peData = loadPe();
  if (!peData || !peData.bucketStr) return null;

  const [loStr, hiStr] = peData.bucketStr.split(',');
  const buyPct  = parseFloat(loStr) - SYS_CONFIG.DEAD_ZONE;
  const sellPct = parseFloat(hiStr) + SYS_CONFIG.DEAD_ZONE;

  let v = peData.peYest, isDynamic = false;

  if (window._rt_csi300_price && peData.priceAnchor && peData.priceBuy && peData.priceSell) {
    const x  = window._rt_csi300_price;
    const x1 = peData.priceBuy,    y1 = buyPct;
    const x2 = peData.priceAnchor, y2 = peData.peYest;
    const x3 = peData.priceSell,   y3 = sellPct;

    if (x === x2) {
      v = y2; isDynamic = true;
    } else if (x1 !== x2 && x2 !== x3 && x1 !== x3) {
      v = y1 * ((x-x2)*(x-x3)) / ((x1-x2)*(x1-x3))
        + y2 * ((x-x1)*(x-x3)) / ((x2-x1)*(x2-x3))
        + y3 * ((x-x1)*(x-x2)) / ((x3-x1)*(x3-x2));
      isDynamic = true;
    } else {
      const range = x3 - x1;
      if (range > 0) { v = y1 + ((x-x1)/range)*(y3-y1); isDynamic = true; }
    }
  }

  return {value: v, isDynamic, rawData: peData, bounds: {buyPct, sellPct}};
}

// ---- 当前档位目标权益 ----
function getDynamicTarget(mode) {
  const currentPE = getCurrentPE();
  if (!currentPE?.rawData?.bucketStr) return null;
  const lo  = parseFloat(currentPE.rawData.bucketStr.split(',')[0]);
  const idx = PE_EQUITY_TABLE.findIndex(x => lo >= x.lo && lo < x.hi);
  if (idx === -1) return null;
  if (mode === 'buy')  return PE_EQUITY_TABLE[Math.min(idx + 1, PE_EQUITY_TABLE.length - 1)].target;
  if (mode === 'sell') return PE_EQUITY_TABLE[Math.max(idx - 1, 0)].target;
  return PE_EQUITY_TABLE[idx].target;
}

// ---- 当前权益计算 ----
function calcCurrentEquity(holdings) {
  let total = 0, eq = 0;
  getActiveProducts().forEach(p => {
    const shares = holdings[p.code] || 0; if (!shares) return;
    const nav    = getNavByCode(p.code); if (nav == null) return;
    const val    = shares * nav;
    total += val; eq += val * p.equity;
  });
  return total > 0 ? {equity: eq / total * 100, total} : null;
}

// ---- 增权推演 ----
function calcBuyPlanDraft(holdings) {
  const eqResult = calcCurrentEquity(holdings);
  if (!eqResult) return null;
  const {total: totalVal, equity: currentEq} = eqResult;
  const targetEq = getDynamicTarget('buy');
  if (targetEq == null) return null;

  const buyAmt     = Math.max(0, totalVal * (targetEq - currentEq) / 100);
  const xqNav      = getNavByCode(SYS_CONFIG.CODE_XQ)   || 1.0;
  const a500cNav   = getNavByCode(SYS_CONFIG.CODE_A500)  || 1.0;
  const zz500cNav  = getNavByCode(SYS_CONFIG.CODE_ZZ500) || 1.0;
  const currA500CVal = (holdings[SYS_CONFIG.CODE_A500] || 0) * a500cNav;
  const a500cRoom  = Math.max(0, totalVal * SYS_CONFIG.LIMIT_A500C - currA500CVal);
  const allocA500C  = Math.min(buyAmt, a500cRoom);
  const allocZZ500C = buyAmt - allocA500C;

  return {totalVal, currentEq, targetEq, buyAmt, sellXqShares: buyAmt / xqNav, allocA500C, allocZZ500C, a500cNav, zz500cNav};
}

// ---- 降权推演 ----
function calcSellExecutionDraft(holdings, ratios, priorityCode) {
  const eqResult = calcCurrentEquity(holdings);
  if (!eqResult) return {error: true};
  const targetEq = getDynamicTarget('sell');
  if (targetEq == null) return {error: true};

  const {equity: currentEq, total: totalVal} = eqResult;
  let sellNeededEq = Math.max(0, totalVal * (currentEq - targetEq) / 100);

  const sellProducts = getActiveProducts().filter(p => p.equity > 0);
  const totalRatio   = sellProducts.filter(p => p.code !== priorityCode).reduce((s, p) => s + (ratios[p.code] || 0), 0);

  let afterEqVal = totalVal * currentEq / 100;
  let totalCashOut = 0, totalFriction = 0, hasAnySell = false;
  const results = {};

  // 优先卖出
  if (priorityCode) {
    const pPri = sellProducts.find(p => p.code === priorityCode);
    if (pPri) {
      const nav             = getNavByCode(pPri.code) || 1.0;
      const maxEqContribution = (holdings[pPri.code] || 0) * nav * pPri.equity;
      const actualEqToSell  = Math.min(sellNeededEq, maxEqContribution);
      results[pPri.code]    = {amt: actualEqToSell / pPri.equity, nav};
      sellNeededEq -= actualEqToSell;
    }
  }

  // 按比例分配剩余
  sellProducts.forEach(p => {
    if (p.code === priorityCode) return;
    const nav = getNavByCode(p.code) || 1.0;
    if (!totalRatio || !ratios[p.code]) { results[p.code] = {amt: 0, nav}; return; }
    const eqQuota    = sellNeededEq * (ratios[p.code] / totalRatio);
    const maxSellAmt = (holdings[p.code] || 0) * nav;
    results[p.code]  = {amt: Math.min(eqQuota / p.equity, maxSellAmt), nav};
  });

  // 计算摩擦与到账
  sellProducts.forEach(p => {
    const res = results[p.code];
    if (!res || !res.amt) return;
    hasAnySell = true;
    const feeAmt    = res.amt * SYS_CONFIG.FEE;
    const eqDropVal = res.amt * p.equity;
    afterEqVal    -= eqDropVal;
    totalCashOut  += res.amt - feeAmt;
    totalFriction += feeAmt;
    res.fee        = feeAmt;
    res.cashOut    = res.amt - feeAmt;
    res.eqDropPct  = eqDropVal / totalVal * 100;
    res.shares     = res.amt / res.nav;
  });

  return {totalVal, currentEq, targetEq, diffEqPct: Math.max(0, currentEq - targetEq), hasAnySell, totalCashOut, totalFriction, afterEqPct: afterEqVal / totalVal * 100, results};
}

// ---- 今日盈亏计算 ----
function calcTodayProfit(results, holdings, mktState, todayStr) {
  let totalProfit = 0, totalYestVal = 0, allUpdated = true, hasHoldings = false;
  let isWaitingForOpen = (mktState === 'PRE_MARKET');

  getActiveProducts().forEach(p => {
    const shares = holdings[p.code] || 0;
    if (shares <= 0) return;
    const f = results.find(r => r.code === p.code);
    if (!f || f.error) { allUpdated = false; return; }
    hasHoldings = true;

    const estD = f.estTime ? f.estTime.slice(0, 10) : '';
    const offD = f.offDate ? f.offDate.slice(0, 10) : '';
    const isOfficialUpdated = offD === todayStr
      || mktState === 'WEEKEND' || mktState === 'BEFORE_PRE'
      || (estD && offD && offD >= estD);

    if (!isOfficialUpdated) allUpdated = false;

    const nav = isOfficialUpdated ? parseFloat(f.offVal) : parseFloat(f.estVal);
    const pct = isOfficialUpdated ? parseFloat(f.offPct) : parseFloat(f.estPct);

    if (!isNaN(nav) && !isNaN(pct)) {
      const yestNav = nav / (1 + pct / 100);
      const yestVal = shares * yestNav;
      totalYestVal += yestVal;
      totalProfit  += yestVal * (pct / 100);
      if (!isOfficialUpdated && estD !== todayStr && (mktState === 'PRE_MARKET' || mktState === 'TRADING')) {
        isWaitingForOpen = true;
      }
    }
  });

  return {totalProfit, totalYestVal, allUpdated, hasHoldings, isWaitingForOpen};
}