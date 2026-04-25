// Jany 基金看板 - 预案模块
// 职责：权益计算、增降权推演、持仓抽屉、预案抽屉、口令备份 UI、抽屉控制

// ---- 抽屉通用控制（全局复用）----
function openDrawer(id) {
  document.getElementById('drawerMask').classList.add('open');
  document.getElementById(id).classList.add('open');
}
function closeAllDrawers() {
  document.getElementById('drawerMask').classList.remove('open');
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('open'));
}

// ---- 权益计算引擎 ----
function calcCurrentEquity(holdings) {
  let total = 0, eq = 0;
  getActiveProducts().forEach(p => {
    const shares = holdings[p.code] || 0; if (!shares) return;
    const nav = getNavByCode(p.code); if (nav == null) return;
    const val = shares * nav;
    total += val; eq += val * p.equity;
  });
  return total > 0 ? {equity: eq / total * 100, total} : null;
}

// 增权推演
function calcBuyPlanDraft(holdings) {
  const eqResult = calcCurrentEquity(holdings);
  if (!eqResult) return null;
  const {total: totalVal, equity: currentEq} = eqResult;
  const targetEq = getDynamicTarget('buy');
  if (targetEq == null) return null;

  const buyAmt = Math.max(0, totalVal * (targetEq - currentEq) / 100);
  const xqNav    = getNavByCode(SYS_CONFIG.CODE_XQ)   || 1.0;
  const a500cNav = getNavByCode(SYS_CONFIG.CODE_A500)  || 1.0;
  const zz500cNav= getNavByCode(SYS_CONFIG.CODE_ZZ500) || 1.0;

  const currA500CVal = (holdings[SYS_CONFIG.CODE_A500] || 0) * a500cNav;
  const a500cRoom    = Math.max(0, totalVal * SYS_CONFIG.LIMIT_A500C - currA500CVal);
  const allocA500C   = Math.min(buyAmt, a500cRoom);
  const allocZZ500C  = buyAmt - allocA500C;

  return {totalVal, currentEq, targetEq, buyAmt, sellXqShares: buyAmt / xqNav, allocA500C, allocZZ500C, a500cNav, zz500cNav};
}

// 降权推演
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
      const nav = getNavByCode(pPri.code) || 1.0;
      const maxEqContribution = (holdings[pPri.code] || 0) * nav * pPri.equity;
      const actualEqToSell    = Math.min(sellNeededEq, maxEqContribution);
      results[pPri.code] = {amt: actualEqToSell / pPri.equity, nav};
      sellNeededEq -= actualEqToSell;
    }
  }

  // 按比例分配剩余
  sellProducts.forEach(p => {
    if (p.code === priorityCode) return;
    const nav = getNavByCode(p.code) || 1.0;
    if (!totalRatio || !ratios[p.code]) { results[p.code] = {amt: 0, nav}; return; }
    const eqQuota      = sellNeededEq * (ratios[p.code] / totalRatio);
    const maxSellAmt   = (holdings[p.code] || 0) * nav;
    results[p.code]    = {amt: Math.min(eqQuota / p.equity, maxSellAmt), nav};
  });

  // 计算摩擦与到账
  sellProducts.forEach(p => {
    const res = results[p.code] || {amt: 0, nav: getNavByCode(p.code) || 1.0};
    if (!res.amt) return;
    hasAnySell = true;
    const feeAmt   = res.amt * SYS_CONFIG.FEE;
    const eqDropVal= res.amt * p.equity;
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

// ---- 持仓抽屉 ----
function openHoldingDrawer() {
  const holdings = loadHoldings();
  const eqData   = calcCurrentEquity(holdings);
  const currentPE= getCurrentPE();
  const targetEq = getDynamicTarget('neutral');
  const diff     = (eqData && targetEq != null) ? eqData.equity - targetEq : null;
  const wrongDir = diff != null && currentPE ? ((currentPE.value >= 65 && diff > 2) || (currentPE.value < 65 && diff < -2)) : false;
  const diffCol  = diff == null ? 'var(--t3)' : wrongDir ? '#f87171' : (diff > 0 ? '#f59e0b' : '#60a5fa');

  let html = `<div style="background:var(--bg3);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid var(--bd)">
    <div style="font-size:11px;color:var(--t3);margin-bottom:8px;font-weight:500">📊 权益校对汇总</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
      <div><div style="font-size:10px;color:var(--t3)">总市值</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600">${eqData ? fmtMoney(eqData.total) : '--'}</div></div>
      <div><div style="font-size:10px;color:var(--t3)">实际权益</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:${diffCol}">${eqData ? eqData.equity.toFixed(2) + '%' : '--'}</div></div>
      <div><div style="font-size:10px;color:var(--t3)">目标权益</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:var(--accent)">${targetEq != null ? targetEq + '%' : '输入PE'}</div></div>
    </div>
    ${diff != null ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);font-size:11px">偏离：<span style="font-family:var(--f-num);font-weight:600;color:${diffCol}">${diff > 0 ? '+' : ''}${diff.toFixed(2)}%</span>${wrongDir ? '<span style="color:#f87171;margin-left:6px">⚠️ 方向警告</span>' : ''}</div>` : ''}
  </div>
  <div style="background:var(--bg3);border-radius:10px;overflow:hidden;margin-bottom:14px;border:1px solid var(--bd)">`;

  getActiveProducts().forEach(p => {
    const shares = holdings[p.code] || 0;
    const nav    = getNavByCode(p.code);
    const val    = nav ? shares * nav : 0;
    html += `<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--bd);font-size:12px">
      <div><div style="font-weight:500">${p.name}</div><div style="font-size:10px;color:var(--t3)"><span style="font-family:var(--f-num)">${shares.toFixed(2)}</span> 份 × <span style="font-family:var(--f-num)">${nav ? nav.toFixed(4) : '--'}</span></div></div>
      <div style="text-align:right;font-family:var(--f-num);color:var(--t2)">${val ? fmtMoney(val) : '--'}</div>
      <div style="text-align:right;font-size:10px;color:var(--t3)">×<span style="font-family:var(--f-num)">${Math.round(p.equity * 100)}%</span></div>
      <div style="text-align:right;font-family:var(--f-num);font-weight:500;color:var(--accent)">${val ? fmtMoney(val * p.equity) : '--'}</div>
    </div>`;
  });

  html += `</div>`;

  getActiveProducts().forEach(p => {
    const shares = loadHoldings()[p.code] || 0;
    html += `<div class="holding-row">
      <div class="holding-name"><div style="font-size:13px;font-weight:500">${getProductName(p.code)}</div><div style="font-size:11px;color:var(--t3)">${p.code}·权益<span style="font-family:var(--f-num)">${Math.round(p.equity * 100)}%</span></div></div>
      <input class="holding-input" id="hi_${p.code}" type="number" step="0.01" style="font-size:16px" value="${shares.toFixed(2)}" placeholder="0">
      <span class="holding-unit">份</span>
    </div>`;
  });

  html += `<div style="margin-top:16px;display:flex;gap:8px">
    <button onclick="exportToken()" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--bd2);background:transparent;color:var(--t2);font-size:12px;cursor:pointer">🔑 生成备份口令</button>
    <button onclick="importToken()" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--bd2);background:transparent;color:var(--t2);font-size:12px;cursor:pointer">📥 口令恢复</button>
  </div>`;

  document.getElementById('holdingDrawerBody').innerHTML = html;
  openDrawer('holdingDrawer');
}

function saveHoldings() {
  const h = loadHoldings();
  getActiveProducts().forEach(p => {
    const v = parseFloat(document.getElementById('hi_' + p.code)?.value || '0');
    h[p.code] = isNaN(v) ? 0 : v;
  });
  saveHoldingsData(h); closeAllDrawers(); alert('✅ 持仓已保存');
}

// 口令 UI（数据操作委托给 store.js）
function exportToken() {
  prompt('请复制以下备份口令并妥善保存：', exportSnapshot());
}
function importToken() {
  const str = prompt('请输入你的资产备份口令：');
  if (!str) return;
  if (importSnapshot(str)) {
    closeAllDrawers(); updatePeBar(); refreshData();
    alert('✅ 资产配置与首页列表全量恢复成功！');
  } else {
    alert('❌ 口令无效或已损坏，请检查复制是否完整！');
  }
}

// ---- 预案抽屉 ----
window._prioritySellCode = localStorage.getItem('jy_priority_sell_v1');

function openPlanDrawer() {
  const currentPE = getCurrentPE();
  if (!currentPE) { alert('请先定锚！'); openPeModal(); return; }
  window._prioritySellCode = localStorage.getItem('jy_priority_sell_v1');
  renderPlanDrawer();
  openDrawer('planDrawer');
}

function renderPlanDrawer() {
  const currentPE = getCurrentPE();
  const holdings  = loadHoldings();
  const buyData   = calcBuyPlanDraft(holdings);
  const savedPlan = JSON.parse(localStorage.getItem(STORE_SELL_PLAN) || '{}');
  const equityProducts = getActiveProducts().filter(p => p.equity > 0);

  if (!buyData) return;

  let html = `<div style="background:var(--bg3);border-radius:10px;padding:10px 12px;margin-bottom:16px;border:1px solid var(--bd);font-size:12px;color:var(--t2)">
    当前PE <b style="color:var(--t1);font-family:var(--f-num)">${currentPE.value.toFixed(2)}%</b>
    · 当前权益 <b style="color:var(--t1);font-family:var(--f-num)">${buyData.currentEq.toFixed(2)}%</b>
    · 总市值 <b style="color:var(--t1);font-family:var(--f-num)">${fmtMoney(buyData.totalVal)}</b>
  </div>

  <div style="margin-bottom:20px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="font-size:11px;font-weight:600;color:#60a5fa;background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);border-radius:6px;padding:2px 8px">▲ 增权预案评估</span></div>
    <div style="background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.15);border-radius:10px;padding:12px">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
        <div><div style="font-size:10px;color:var(--t3)">当前权益</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600">${buyData.currentEq.toFixed(2)}%</div></div>
        <div><div style="font-size:10px;color:var(--t3)">触发后目标</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#60a5fa">${buyData.targetEq}%</div></div>
        <div><div style="font-size:10px;color:var(--t3)">需调配金额</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#60a5fa">${fmtMoney(buyData.buyAmt)}</div></div>
      </div>
      <div style="font-size:11px;color:var(--t3);margin-bottom:8px">资金筹集 (卖出 ${getProductName(SYS_CONFIG.CODE_XQ)})</div>
      <div style="padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(240,68,68,0.3);display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:14px;font-weight:600">卖出份数</div>
        <div style="font-family:var(--f-num);font-size:15px;font-weight:700;color:var(--up)">${fmt(buyData.sellXqShares, 2)} 份</div>
      </div>
      <div style="font-size:11px;color:var(--t3);margin:16px 0 8px">目标分配 (优先A500C，溢出至中证500C)</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(59,130,246,0.3);display:flex;justify-content:space-between;align-items:center">
          <div><div style="font-size:14px;font-weight:600">买入 A500C</div><div style="font-size:10px;color:var(--t3)">~${fmt(buyData.allocA500C / buyData.a500cNav, 2)} 份</div></div>
          <div style="font-family:var(--f-num);font-size:15px;font-weight:700;color:#60a5fa">${fmtMoney(buyData.allocA500C)}</div>
        </div>
        ${buyData.allocZZ500C > 1 ? `<div style="padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(59,130,246,0.3);display:flex;justify-content:space-between;align-items:center"><div><div style="font-size:14px;font-weight:600">买入 中证500C</div><div style="font-size:10px;color:var(--t3)">~${fmt(buyData.allocZZ500C / buyData.zz500cNav, 2)} 份</div></div><div style="font-family:var(--f-num);font-size:15px;font-weight:700;color:#60a5fa">${fmtMoney(buyData.allocZZ500C)}</div></div>` : ''}
      </div>
    </div>
  </div>

  <div>
    <div style="display:flex;align-items:center;margin-bottom:10px"><span style="font-size:11px;font-weight:600;color:#f59e0b;background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);border-radius:6px;padding:2px 8px">▼ 降权预案评估</span></div>
    <div style="background:rgba(240,68,68,0.04);border:1px solid rgba(240,68,68,0.12);border-radius:10px;padding:12px">
      <div id="sell_summary_area"></div>
      <div style="font-size:11px;color:var(--t3);margin-bottom:10px">配置减仓比例（空=不参与），摩擦费率 ${SYS_CONFIG.FEE * 100}%</div>`;

  equityProducts.forEach(p => {
    const isPri = window._prioritySellCode === p.code;
    html += `<div style="padding:10px 12px;background:var(--bg3);border-radius:10px;margin-bottom:8px;border:1px solid var(--bd);display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:14px;font-weight:600">${getProductName(p.code)}</div><div id="sell_calc_shares_${p.code}" style="font-family:var(--f-num);font-weight:600;color:var(--t3)">-- 份</div></div>
      <div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:10px;color:var(--t3)">持仓: ${(loadHoldings()[p.code] || 0).toFixed(2)} 份</div><div id="sell_calc_fiat_${p.code}" style="font-size:11px;color:var(--t3)">-- 元</div></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
        <button class="pri-btn" data-code="${p.code}" onclick="togglePrioritySell('${p.code}')" style="font-size:11px;height:24px;width:72px;border-radius:6px;border:1px solid ${isPri ? '#f59e0b' : 'var(--bd2)'};background:${isPri ? 'rgba(245,158,11,0.1)' : 'transparent'};color:${isPri ? '#f59e0b' : 'var(--t3)'};cursor:pointer">${isPri ? '★ 优先' : '☆ 优先'}</button>
        <div style="display:flex;align-items:center;gap:6px"><span style="font-size:11px;color:var(--t3)">减仓权重</span><input type="tel" style="width:52px;height:24px;background:var(--bg);border:1px solid var(--bd2);border-radius:6px;color:var(--t1);text-align:center" id="ratio_${p.code}" value="${savedPlan[p.code] || ''}" oninput="calcSellPreview()"></div>
      </div>
    </div>`;
  });

  html += `<div style="margin-top:10px;padding:10px;background:var(--bg3);border-radius:8px" id="sell_preview_result"><span style="font-size:12px;color:var(--t3)">等待输入比例...</span></div></div></div>`;

  document.getElementById('planDrawerBody').innerHTML = html;
  calcSellPreview();
}

function calcSellPreview() {
  const holdings = loadHoldings();
  const equityProducts = getActiveProducts().filter(p => p.equity > 0);
  const ratios = {};
  equityProducts.forEach(p => { ratios[p.code] = parseFloat(document.getElementById('ratio_' + p.code)?.value) || 0; });

  const draft = calcSellExecutionDraft(holdings, ratios, window._prioritySellCode);

  const summaryEl = document.getElementById('sell_summary_area');
  if (summaryEl && !draft.error) {
    summaryEl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
      <div><div style="font-size:10px;color:var(--t3)">当前权益</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600">${draft.currentEq.toFixed(2)}%</div></div>
      <div><div style="font-size:10px;color:var(--t3)">触发后目标</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#f87171">${draft.targetEq}%</div></div>
      <div><div style="font-size:10px;color:var(--t3)">需减比例</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#f59e0b">${draft.diffEqPct.toFixed(2)}%</div></div>
    </div>`;
  }

  equityProducts.forEach(p => {
    const res    = draft.results?.[p.code];
    const elS    = document.getElementById('sell_calc_shares_' + p.code);
    const elF    = document.getElementById('sell_calc_fiat_'  + p.code);
    if (res && res.amt > 0) {
      elS.innerHTML = `<span style="color:var(--up)">${fmt(res.shares, 2)}</span> 份`;
      elF.innerHTML = `<span style="color:var(--t2)">${fmtMoney(res.amt)}</span> <span style="color:#f59e0b;font-size:10px;margin-left:4px">降权 ${res.eqDropPct.toFixed(2)}%</span>`;
    } else {
      elS.innerHTML = `-- 份`; elF.innerHTML = `-- 元`;
    }
  });

  const resultEl = document.getElementById('sell_preview_result');
  if (draft.hasAnySell) {
    resultEl.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px">
      <div><div style="color:var(--t3);font-size:10px">操作后权益</div><div style="font-family:var(--f-num);font-weight:700;font-size:16px;color:#22c55e">${draft.afterEqPct.toFixed(2)}%</div></div>
      <div><div style="color:var(--t3);font-size:10px">转出到账</div><div style="font-family:var(--f-num);font-weight:600;font-size:15px">${fmtMoney(draft.totalCashOut)}</div></div>
      <div><div style="color:var(--t3);font-size:10px">总摩擦</div><div style="font-family:var(--f-num);font-weight:600;font-size:15px;color:#f87171">${fmtMoney(draft.totalFriction)}</div></div>
    </div>`;
  } else {
    resultEl.innerHTML = `<span style="font-size:12px;color:var(--t3)">请填写比例或设为优先卖出</span>`;
  }
}

function togglePrioritySell(code) {
  window._prioritySellCode = (window._prioritySellCode === code) ? null : code;
  if (window._prioritySellCode) localStorage.setItem('jy_priority_sell_v1', window._prioritySellCode);
  else localStorage.removeItem('jy_priority_sell_v1');
  document.querySelectorAll('.pri-btn').forEach(btn => {
    const isPri = btn.dataset.code === window._prioritySellCode;
    btn.innerHTML    = isPri ? '★ 优先' : '☆ 优先';
    btn.style.color  = isPri ? '#f59e0b' : 'var(--t3)';
    btn.style.borderColor = isPri ? '#f59e0b' : 'var(--bd2)';
    btn.style.background  = isPri ? 'rgba(245,158,11,0.1)' : 'transparent';
  });
  calcSellPreview();
}

function saveSellPlan() {
  const plan = {};
  getActiveProducts().filter(p => p.equity > 0).forEach(p => {
    const v = document.getElementById('ratio_' + p.code)?.value || '';
    if (v) plan[p.code] = v;
  });
  localStorage.setItem(STORE_SELL_PLAN, JSON.stringify(plan));
}
function saveAndClosePlan() { saveSellPlan(); closeAllDrawers(); }