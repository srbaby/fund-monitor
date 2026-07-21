// ============================================================
// engine.js - 计算引擎层
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
    t < SYS_CONFIG.T_MID_BREAK ||
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
    (peVal < SYS_CONFIG.PE_HIGH_THRESHOLD && diff > SYS_CONFIG.EQUITY_DEV_LIMIT)
  );
}

// engineResult: getAnchorPE() 的返回值，由调用方注入（依赖注入，engine 层不读 store）。
// peData 只承载 bucketStr（用户定的档位区间），PE 数值全部来自旁路引擎——
// 早年的"夜间录入三个点位 + 分段线性插值"已被引擎百分位取代，见 D-016。
// 引擎未就绪时 value 为 undefined，由 ui-pe.js 的 Number.isFinite 守卫落入"等待数据"。
function getCurrentPE(peData, engineResult) {
  if (!peData || !peData.bucketStr) return null;

  const [loStr, hiStr] = peData.bucketStr.split(",");
  const buyPct = parseFloat(loStr) - SYS_CONFIG.BUFFER_ZONE;
  const sellPct = parseFloat(hiStr) + SYS_CONFIG.BUFFER_ZONE;

  const isDynamic = !!(engineResult && engineResult.mode !== "close");
  return {
    value: engineResult?.pct,
    isDynamic,
    rawData: peData,
    bounds: { buyPct, sellPct },
  };
}

// 旁路2.0（点位路）：旁路参考展示（小字显示于主PE旁）
//   bypass2 (mode=price)：实时PE = 昨夜官方PE × (腾讯实时点位 / 昨收官方点位)   ← 天然含除权/调仓修正
//   百分位 = 全量历史排序数组二分查找（精确ECDF，与 hs300_daily 的 (pe<=x)/n 口径一致）
//   无实时点位时回落昨收（mode=close）
function getEnginePE(engineData, qqIdx) {
  if (
    !engineData ||
    !Array.isArray(engineData.peSorted) ||
    !engineData.peSorted.length ||
    engineData.peYest == null
  )
    return null;
  let pe = engineData.peYest,
    mode = "close";
  if (qqIdx && qqIdx.price > 0 && engineData.priceYest > 0) {
    pe = engineData.peYest * (qqIdx.price / engineData.priceYest);
    mode = "price";
  }
  const a = engineData.peSorted;
  let lo = 0,
    hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= pe) lo = mid + 1;
    else hi = mid;
  }
  return {
    pe,
    pct: (lo / a.length) * 100,
    mode,
    date: engineData.date || "",
  };
}

// 旁路1.0（总市值路）：PE 主路径（大号 PE / bar / 触发状态 / 权益判断）
//   bypass1 (mode=mcap)：实时PE = 昨夜官方PE × (腾讯实时总市值 / 昨收总市值)
//   无实时总市值时回落昨收（mode=close），与 getEnginePE 回落逻辑保持一致
function getEnginePE1(engineData, qqIdx) {
  if (
    !engineData ||
    !Array.isArray(engineData.peSorted) ||
    !engineData.peSorted.length ||
    engineData.peYest == null
  )
    return null;
  let pe = engineData.peYest, mode = "close";
  if (qqIdx && qqIdx.mcap > 0 && engineData.mcapYest > 0) {
    pe = engineData.peYest * (qqIdx.mcap / engineData.mcapYest);
    mode = "mcap";
  }
  const a = engineData.peSorted;
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= pe) lo = mid + 1;
    else hi = mid;
  }
  return { pe, pct: (lo / a.length) * 100, mode, date: engineData.date || "" };
}

// PE 锚定路径分发：全站 PE 的唯一入口，由 config 的 PE_ANCHOR 决定走哪条（D-017）。
// 收口在这里而不是各调用点自己选，是因为"哪条是主路径"这个知识一旦散落，
// 下次新增调用点必然再分叉一次——2026-07-21 之前 PE 栏走 1.0、持仓抽屉走 2.0 就是这么来的。
function getAnchorPE(engineData, qqIdx) {
  return PE_ANCHOR === "price"
    ? getEnginePE(engineData, qqIdx)
    : getEnginePE1(engineData, qqIdx);
}

// 参考路径：永远返回锚定路径之外的**另一条**，供 PE 栏小字并列展示。
// 与 getAnchorPE 互补，翻转 PE_ANCHOR 时主副自动对调，开关才真正可用。
function getRefPE(engineData, qqIdx) {
  return PE_ANCHOR === "price"
    ? getEnginePE1(engineData, qqIdx)
    : getEnginePE(engineData, qqIdx);
}

// 根据 PE 百分位反查对应的沪深300点位（用于 tooltip 显示买卖边界点位）
// buyPct/sellPct 均为 0–100 的百分位值
function getBoundaryPrices(engineData, buyPct, sellPct) {
  if (!engineData || !Array.isArray(engineData.peSorted) ||
      !engineData.peSorted.length || !engineData.peYest || !engineData.priceYest)
    return null;
  const a = engineData.peSorted, n = a.length;
  const peAtPct = (pct) => a[Math.min(Math.floor(pct / 100 * n), n - 1)];
  const buyPe = peAtPct(buyPct);
  const sellPe = peAtPct(sellPct);
  const ratio = engineData.priceYest / engineData.peYest;
  return {
    buyPrice: Math.round(buyPe * ratio),
    sellPrice: Math.round(sellPe * ratio),
  };
}

// 边界：最低档增权时 idx+1 超出数组，Math.min 兜底返回同档 target
// 边界：最高档降权时 idx-1 为 -1，Math.max 兜底返回同档 target
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

  const zz500Prod = activeProducts.find((p) => isZZ500Product(p.name));

  return {
    totalVal,
    currentEq,
    targetEq,
    buyAmt,
    sellXqShares: buyAmt / xqNav,
    allocA500C,
    allocZZ500C,
    sharesA500C: allocA500C / xqNav,
    sharesZZ500C: allocZZ500C / xqNav,
    zz500Code: zz500Prod?.code || null,
    totalFriction: 0,
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
  const zz500Code =
    sellProducts.find((p) => isZZ500Product(p.name))?.code || null;

  const totalRatio = sellProducts
    .filter((p) => p.code !== zz500Code && p.code !== priorityCode)
    .reduce((s, p) => s + (ratios[p.code] || 0), 0);

  let totalCashOut = 0,
    totalFriction = 0,
    hasAnySell = false;
  const results = {};

  // 第一优先：中证500（自动识别）
  if (zz500Code) {
    const pZ = sellProducts.find((p) => p.code === zz500Code);
    if (pZ) {
      const nav = getNavFn(pZ.code) || 1.0;
      const actualEqToSell = Math.min(
        sellNeededEq,
        (holdings[pZ.code] || 0) * nav * pZ.equity,
      );
      results[pZ.code] = {
        amt: pZ.equity > 0 ? actualEqToSell / pZ.equity : 0,
        nav,
      };
      sellNeededEq -= actualEqToSell;
    }
  }

  // 第二优先：用户手动标记的优先卖出品种
  if (priorityCode && priorityCode !== zz500Code) {
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

  // 第三优先：按比例分配剩余
  sellProducts.forEach((p) => {
    if (p.code === zz500Code || p.code === priorityCode) return;
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

    totalCashOut += res.amt - feeAmt;
    totalFriction += feeAmt;
    res.shares = res.amt / res.nav;
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
    hasHoldings = false, // 有持仓（不论数据新旧）
    hasParticipating = false; // 其中有今日数据、真正参与了计算的

  activeProducts.forEach((p) => {
    const shares = holdings[p.code] || 0;
    if (shares <= 0) return;
    // 「有持仓」只看份额，不看请求成没成功——否则整组超时会让顶部变空白，
    // 看起来像"没有持仓"，而正确的表达是"有持仓但此刻不知道"（显示 -）。
    hasHoldings = true;
    const f = results.find((r) => r.code === p.code);
    if (!f || f.error) {
      allUpdated = false;
      return;
    }

    const estD = f.estTime ? f.estTime.slice(0, 10) : "";
    const offD = f.offDate ? f.offDate.slice(0, 10) : "";

    // 「已更新」徽标：官方是今天 OR 估算是今天，缺一不可（D-010）。
    const isOffToday = offD === todayStr;
    const isEstToday = estD === todayStr;
    const isFundUpdated = isOffToday || isEstToday;

    if (!isFundUpdated) allUpdated = false;

    // 收益口径的日期闸门（D-019）：**只有今天的数据才算今天的收益。**
    // 盘中官方永远停在昨天，估算断供时旧判据会退到官方，把上一交易日的涨跌
    // 当成今日收益发出来（2026-07-21 实测 +1010，实为周一那段）。
    // 非交易日例外：WEEKEND / BEFORE_PRE 今天本就不该有数据，回退到最近可得，
    // 顶部因而改名「最新收益」；其余时段今天该有却没有，属异常，整只不参与。
    const isNonTradingDay = mktState === "WEEKEND" || mktState === "BEFORE_PRE";
    if (!isFundUpdated && !isNonTradingDay) return;

    // 同为今日时官方优先；非交易日回退沿用「有官方且不比估算旧」。
    // ⚠️ 与 data.js 的 getNavByCode **有意不同**——那条是市值口径，要最新可得净值，
    // 哪天的都对；这条是收益口径，必须是今天的。见红线 #6 的两类口径。
    const useOfficial = isNonTradingDay
      ? !!(f.offVal && (!estD || offD >= estD))
      : isOffToday;

    const nav = useOfficial ? parseFloat(f.offVal) : parseFloat(f.estVal);
    const pct = useOfficial ? parseFloat(f.offPct) : parseFloat(f.estPct);
    if (isNaN(nav)) return;

    let yestNav = null;
    const isBaseNavValid =
      f.baseNav &&
      f.baseDate &&
      (useOfficial ? f.baseDate < offD : f.baseDate < todayStr);

    if (isBaseNavValid) yestNav = f.baseNav;
    else if (!isNaN(pct)) yestNav = nav / (1 + pct / 100);
    else return;

    hasParticipating = true;
    totalYestVal += shares * yestNav;
    totalProfit += shares * (nav - yestNav);
  });

  // 有持仓、却没有一只拿得出今日数据 → 顶部显示「-」而不是编一个 0.00。
  // 盘前集合竞价同理（今日估算还没开始推）。
  const isWaitingForData =
    mktState === "PRE_MARKET" || (hasHoldings && !hasParticipating);

  return {
    totalProfit,
    totalYestVal,
    allUpdated,
    hasHoldings: hasParticipating,
    isWaitingForData,
  };
}

