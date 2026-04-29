// ============================================================
// engine.js - 计算引擎层 (v2.0 纯净版)
// 职责：纯粹的数学推演与业务计算。
// 铁律：不含任何 DOM 操作，不含 localStorage 读写，不调用 store/data 的函数。
// 所有依赖必须通过参数传入 (Dependency Injection)。
// ============================================================

function getMarketState(now = new Date()) {
  const d = now.getDay(),
    t = now.getHours() * 60 + now.getMinutes();
  if (d === 0 || d === 6) return "WEEKEND";
  if (t < SYS_CONFIG.T_PRE_MARKET) return "BEFORE_PRE";
  if (t < SYS_CONFIG.T_OPEN) return "PRE_MARKET";
  if (
    (t >= SYS_CONFIG.T_OPEN && t < SYS_CONFIG.T_MID_BREAK) ||
    (t >= SYS_CONFIG.T_AFTERNOON && t < SYS_CONFIG.T_CLOSE)
  )
    return "TRADING";
  if (t >= SYS_CONFIG.T_MID_BREAK && t < SYS_CONFIG.T_AFTERNOON)
    return "MID_BREAK";
  return "POST_MARKET";
}

function isEquityWrongDir(peVal, diff) {
  if (peVal == null || diff == null) return false;
  return (
    (peVal >= SYS_CONFIG.PE_HIGH_THRESHOLD &&
      diff < -SYS_CONFIG.EQUITY_DEV_LIMIT) ||
    (peVal < SYS_CONFIG.PE_HIGH_THRESHOLD &&
      diff > SYS_CONFIG.EQUITY_DEV_LIMIT)
  );
}

// [依赖注入]: 传入存储的 peData 和实时的 currentIdxPrice
function getCurrentPE(peData, currentIdxPrice) {
  if (!peData || !peData.bucketStr) return null;

  const [loStr, hiStr] = peData.bucketStr.split(",");
  const buyPct = parseFloat(loStr) - SYS_CONFIG.BUFFER_ZONE;
  const sellPct = parseFloat(hiStr) + SYS_CONFIG.BUFFER_ZONE;

  let v = peData.peYest,
    isDynamic = false;

  if (
    currentIdxPrice &&
    peData.priceAnchor &&
    peData.priceBuy &&
    peData.priceSell
  ) {
    const x = currentIdxPrice;
    const { priceBuy: x1, priceAnchor: x2, priceSell: x3 } = peData;
    const y1 = buyPct,
      y2 = peData.peYest,
      y3 = sellPct;

    if (x === x2) {
      v = y2;
      isDynamic = true;
    } else if (x1 !== x2 && x2 !== x3 && x1 !== x3) {
      v =
        (y1 * ((x - x2) * (x - x3))) / ((x1 - x2) * (x1 - x3)) +
        (y2 * ((x - x1) * (x - x3))) / ((x2 - x1) * (x2 - x3)) +
        (y3 * ((x - x1) * (x - x2))) / ((x3 - x1) * (x3 - x2));
      isDynamic = true;
    } else if (x3 !== x1) {
      v = y1 + ((x - x1) / (x3 - x1)) * (y3 - y1);
      isDynamic = true;
    }
  }

  return { value: v, isDynamic, rawData: peData, bounds: { buyPct, sellPct } };
}

// [依赖注入]: 传入档位字符串即可
function getDynamicTarget(mode, peBucketStr) {
  if (!peBucketStr) return null;
  const lo = parseFloat(peBucketStr.split(",")[0]);
  const idx = PE_EQUITY_TABLE.findIndex((x) => lo >= x.lo && lo < x.hi);
  if (idx === -1) return null;

  if (mode === "buy")
    return PE_EQUITY_TABLE[Math.min(idx + 1, PE_EQUITY_TABLE.length - 1)]
      .target;
  if (mode === "sell") return PE_EQUITY_TABLE[Math.max(idx - 1, 0)].target;
  return PE_EQUITY_TABLE[idx].target;
}

// [依赖注入]: 传入持仓、活跃产品列表、以及一个获取净值的回调函数 getNavFn
function calcCurrentEquity(holdings, activeProducts, getNavFn) {
  let total = 0,
    eq = 0;
  activeProducts.forEach((p) => {
    const shares = holdings[p.code] || 0;
    if (!shares) return;
    const nav = getNavFn(p.code);
    if (nav == null) return;
    const val = shares * nav;
    total += val;
    eq += val * p.equity;
  });
  return total > 0 ? { equity: (eq / total) * 100, total } : null;
}

// [依赖注入]: 组装推演参数
function calcBuyPlanDraft(holdings, activeProducts, getNavFn, targetEq) {
  const eqResult = calcCurrentEquity(holdings, activeProducts, getNavFn);
  if (!eqResult || targetEq == null) return null;

  const { total: totalVal, equity: currentEq } = eqResult;
  const buyAmt = Math.max(0, (totalVal * (targetEq - currentEq)) / 100);

  const xqNav = getNavFn(SYS_CONFIG.CODE_XQ) || 1.0;
  const a500cNav = getNavFn(SYS_CONFIG.CODE_A500) || 1.0;

  const currA500CVal = (holdings[SYS_CONFIG.CODE_A500] || 0) * a500cNav;
  const a500cRoom = Math.max(
    0,
    totalVal * SYS_CONFIG.LIMIT_A500C - currA500CVal,
  );

  const allocA500C = Math.min(buyAmt, a500cRoom);
  const allocZZ500C = buyAmt - allocA500C;

  const amtByCode = {
    [SYS_CONFIG.CODE_XQ]: buyAmt,
    [SYS_CONFIG.CODE_A500]: allocA500C,
    [SYS_CONFIG.CODE_ZZ500]: allocZZ500C,
  };
  let totalFriction = 0;
  activeProducts.forEach((p) => {
    const amt = amtByCode[p.code];
    if (amt && p.equity !== 0 && p.equity !== 1)
      totalFriction += amt * SYS_CONFIG.FEE;
  });

  return {
    totalVal,
    currentEq,
    targetEq,
    buyAmt,
    sellXqShares: buyAmt / xqNav,
    allocA500C,
    allocZZ500C,
    totalFriction,
  };
}

function calcSellExecutionDraft(
  holdings,
  activeProducts,
  getNavFn,
  targetEq,
  ratios,
  priorityCode,
) {
  const eqResult = calcCurrentEquity(holdings, activeProducts, getNavFn);
  if (!eqResult || targetEq == null) return { error: true };

  const { equity: currentEq, total: totalVal } = eqResult;
  let sellNeededEq = Math.max(0, (totalVal * (currentEq - targetEq)) / 100);

  const sellProducts = activeProducts.filter((p) => p.equity > 0);
  const totalRatio = sellProducts
    .filter((p) => p.code !== priorityCode)
    .reduce((s, p) => s + (ratios[p.code] || 0), 0);

  let afterEqVal = (totalVal * currentEq) / 100;
  let totalCashOut = 0,
    totalFriction = 0,
    hasAnySell = false;
  const results = {};

  if (priorityCode) {
    const pPri = sellProducts.find((p) => p.code === priorityCode);
    if (pPri) {
      const nav = getNavFn(pPri.code) || 1.0;
      const actualEqToSell = Math.min(
        sellNeededEq,
        (holdings[pPri.code] || 0) * nav * pPri.equity,
      );
      results[pPri.code] = {
        amt: pPri.equity > 0 ? actualEqToSell / pPri.equity : 0,
        nav,
      };
      sellNeededEq -= actualEqToSell;
    }
  }

  sellProducts.forEach((p) => {
    if (p.code === priorityCode) return;
    const nav = getNavFn(p.code) || 1.0;
    if (totalRatio <= 0 || !ratios[p.code]) {
      results[p.code] = { amt: 0, nav };
      return;
    }

    const eqQuota = sellNeededEq * (ratios[p.code] / totalRatio);
    results[p.code] = {
      amt: Math.min(eqQuota / p.equity, (holdings[p.code] || 0) * nav),
      nav,
    };
  });

  sellProducts.forEach((p) => {
    const res = results[p.code];
    if (!res || !res.amt) return;
    hasAnySell = true;
    const feeRate = p.equity === 0 || p.equity === 1 ? 0 : SYS_CONFIG.FEE;
    const feeAmt = res.amt * feeRate;
    const eqDropVal = res.amt * p.equity;

    afterEqVal -= eqDropVal;
    totalCashOut += res.amt - feeAmt;
    totalFriction += feeAmt;
    res.shares = res.amt / res.nav;
    res.eqDropPct = (eqDropVal / totalVal) * 100;
  });

  return {
    totalVal,
    currentEq,
    targetEq,
    hasAnySell,
    totalCashOut,
    totalFriction,
    results,
  };
}

function calcTodayProfit(
  results,
  holdings,
  activeProducts,
  mktState,
  todayStr,
) {
  let totalProfit = 0,
    totalYestVal = 0,
    allUpdated = true,
    hasHoldings = false;
  let isWaitingForOpen = mktState === "PRE_MARKET";

  activeProducts.forEach((p) => {
    const shares = holdings[p.code] || 0;
    if (shares <= 0) return;
    const f = results.find((r) => r.code === p.code);
    if (!f || f.error) {
      allUpdated = false;
      return;
    }
    hasHoldings = true;

    const estD = f.estTime ? f.estTime.slice(0, 10) : "";
    const offD = f.offDate ? f.offDate.slice(0, 10) : "";
    const isOfficialUpdated =
      offD === todayStr ||
      mktState === "WEEKEND" ||
      mktState === "BEFORE_PRE" ||
      (estD && offD && offD >= estD);

    if (!isOfficialUpdated) allUpdated = false;

    const nav = isOfficialUpdated ? parseFloat(f.offVal) : parseFloat(f.estVal);
    const pct = isOfficialUpdated ? parseFloat(f.offPct) : parseFloat(f.estPct);

    if (!isNaN(nav)) {
      let yestNav = null;
      const isBaseNavValid =
        f.baseNav &&
        f.baseDate &&
        ((isOfficialUpdated && f.baseDate < offD) ||
          (!isOfficialUpdated && f.baseDate < todayStr));

      if (isBaseNavValid) yestNav = f.baseNav;
      else if (!isNaN(pct)) yestNav = nav / (1 + pct / 100);
      else return;

      totalYestVal += shares * yestNav;
      totalProfit += shares * (nav - yestNav);

      if (
        !isOfficialUpdated &&
        estD !== todayStr &&
        (mktState === "PRE_MARKET" || mktState === "TRADING")
      ) {
        isWaitingForOpen = true;
      }
    }
  });

  return {
    totalProfit,
    totalYestVal,
    allUpdated,
    hasHoldings,
    isWaitingForOpen,
  };
}
