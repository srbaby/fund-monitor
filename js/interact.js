// Jany 基金看板 - 控制器层
// 职责：接收用户操作，从 store/data 取数，调用 engine 计算，交给 ui 渲染
// 不写计算公式，不写 HTML，不直接改状态

// ---- 抽屉控制 ----
function openDrawer(id) {
  document.getElementById('drawerMask').classList.add('open');
  document.getElementById(id).classList.add('open');
}
function closeAllDrawers() {
  document.getElementById('drawerMask').classList.remove('open');
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('open'));
}

// ---- 数据刷新 ----
let _isFetchingData = false;

async function refreshData() {
  if (_isFetchingData) return;
  _isFetchingData = true;
  const miniRefBtn = document.getElementById('miniRefBtn');
  if (miniRefBtn) { miniRefBtn.textContent = '↻'; miniRefBtn.disabled = true; }

  try {
    loadFunds();
    fetchIndices();

    if (!funds.length) {
      document.getElementById('cardView').innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无关注产品，输入代码添加</div></div>`;
      document.getElementById('fundTbody').innerHTML = `<tr><td colspan="4" style="text-align:center;padding:50px;color:var(--t3)">暂无关注产品</td></tr>`;
      return;
    }

    const coreCodes = new Set(funds);
    PRODUCTS.forEach(p => { if (p.equity > 0 && !coreCodes.has(p.code)) coreCodes.add(p.code); });
    const results = await Promise.all([...coreCodes].map(fetchSingleFund));
    renderAll(results);

    if (cardSortable) cardSortable.destroy();
    if (tblSortable) tblSortable.destroy();
    const onEnd = evt => {
      const o = Array.from(evt.to.children).map(el => el.dataset.code).filter(Boolean);
      if (o.length === funds.length) { funds = o; saveFunds(); }
    };
    cardSortable = Sortable.create(document.getElementById('cardView'), {handle: '.drag-handle', animation: 200, ghostClass: 'sortable-ghost', onEnd});
    tblSortable = Sortable.create(document.getElementById('fundTbody'), {handle: '.tbl-drag', animation: 200, ghostClass: 'sortable-ghost', onEnd});
  } finally {
    _isFetchingData = false;
    if (miniRefBtn) { miniRefBtn.textContent = '↻ 刷新'; miniRefBtn.disabled = false; }
  }
}

// ---- 基金增删 ----
function addFund() {
  const input = document.getElementById('codeInput');
  const code = input.value.trim();
  if (/^\d{6}$/.test(code) && !funds.includes(code)) {
    funds.push(code); saveFunds(); input.value = ''; refreshData();
  } else { input.value = ''; }
}
function delFund(code) {
  const name = NAMES[code] || _lastResults.find(r => r.code === code)?.name || code;
  if (!confirm(`确认删除「${name}」？`)) return;
  funds = funds.filter(c => c !== code); saveFunds(); refreshData();
}

// ---- 定锚弹窗 ----
function openPeModal() {
  const peData = loadPe();
  if (peData) {
    document.getElementById('peModalBucket').value = peData.bucketStr || '65,70';
    document.getElementById('peModalInputPct').value = peData.peYest || '';
    document.getElementById('peModalPriceAnchor').value = peData.priceAnchor || '';
    document.getElementById('peModalBuyPrice').value = peData.priceBuy || '';
    document.getElementById('peModalSellPrice').value = peData.priceSell || '';
  }
  document.getElementById('peModal').style.display = 'flex';
}
function closePeModal() { document.getElementById('peModal').style.display = 'none'; }

function confirmPe() {
  const bucketStr   = document.getElementById('peModalBucket').value;
  const peYest      = parseFloat(document.getElementById('peModalInputPct').value);
  const priceAnchor = parseFloat(document.getElementById('peModalPriceAnchor').value);
  const priceBuy    = parseFloat(document.getElementById('peModalBuyPrice').value);
  const priceSell   = parseFloat(document.getElementById('peModalSellPrice').value);
  if (isNaN(peYest) || isNaN(priceAnchor)) { alert('请填写完整的【基准PE】与【基准点位】！'); return; }
  savePe({bucketStr, peYest, priceAnchor, priceBuy: isNaN(priceBuy) ? null : priceBuy, priceSell: isNaN(priceSell) ? null : priceSell});
  updatePeBar(); closePeModal();
}

// ---- 持仓抽屉 ----
function openHoldingDrawer() {
  const holdings  = loadHoldings();
  const eqData    = calcCurrentEquity(holdings);
  const currentPE = getCurrentPE();
  const targetEq  = getDynamicTarget('neutral');
  const diff      = (eqData && targetEq != null) ? eqData.equity - targetEq : null;
  const wrongDir  = diff != null && currentPE ? ((currentPE.value >= 65 && diff > 2) || (currentPE.value < 65 && diff < -2)) : false;
  const diffCol   = diff == null ? 'var(--t3)' : wrongDir ? '#f87171' : (diff > 0 ? '#f59e0b' : '#60a5fa');

  // 1. 顶部汇总卡片
  let html = `<div style="background:var(--bg3);border-radius:10px;padding:12px;margin-bottom:16px;border:1px solid var(--bd)">
    <div style="font-size:11px;color:var(--t3);margin-bottom:10px;font-weight:500;display:flex;align-items:center;gap:4px"><span>📊</span> 权益校对汇总</div>
    <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px">
      <div><div style="font-size:10px;color:var(--t3);margin-bottom:4px">总市值</div><div style="font-family:var(--f-num);font-size:16px;font-weight:600;color:var(--t1)">${eqData ? fmtMoney(eqData.total) : '--'}</div></div>
      <div><div style="font-size:10px;color:var(--t3);margin-bottom:4px">实际权益</div><div style="font-family:var(--f-num);font-size:16px;font-weight:600;color:${diffCol}">${eqData ? eqData.equity.toFixed(2) + '%' : '--'}</div></div>
      <div><div style="font-size:10px;color:var(--t3);margin-bottom:4px">目标权益</div><div style="font-family:var(--f-num);font-size:16px;font-weight:600;color:var(--accent)">${targetEq != null ? targetEq + '%' : '输入PE'}</div></div>
    </div>
    ${diff != null ? `<div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--bd2);font-size:11px;color:var(--t2)">偏离评估：<span style="font-family:var(--f-num);font-weight:600;color:${diffCol}">${diff > 0 ? '+' : ''}${diff.toFixed(2)}%</span>${wrongDir ? '<span style="color:#f87171;margin-left:8px;font-weight:500">⚠️ 方向警告</span>' : ''}</div>` : ''}
  </div>`;

  // 2. 资产价值明细（使用严格比例网格强制对齐）
  html += `<div style="margin-bottom:20px">
    <div style="font-size:11px;color:var(--t3);margin-bottom:8px;font-weight:500">资产价值明细</div>
    <div style="background:var(--bg3);border-radius:10px;overflow:hidden;border:1px solid var(--bd)">`;

  getActiveProducts().forEach(p => {
    const shares = holdings[p.code] || 0;
    const nav    = getNavByCode(p.code);
    const val    = nav ? shares * nav : 0;
    html += `<div style="display:grid;grid-template-columns: 2.5fr 2.2fr 0.8fr 2.2fr; gap:4px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--bd); font-size:12px">
      <div style="overflow:hidden">
        <div style="font-weight:600;color:var(--t1);white-space:nowrap;text-overflow:ellipsis">${p.name}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:2px;white-space:nowrap"><span style="font-family:var(--f-num)">${shares.toFixed(2)}</span> 份 × <span style="font-family:var(--f-num)">${nav ? nav.toFixed(4) : '--'}</span></div>
      </div>
      <div style="text-align:right;font-family:var(--f-num);color:var(--t2);font-weight:500">${val ? fmtMoney(val) : '--'}</div>
      <div style="text-align:right;font-size:10px;color:var(--t3)">×<span style="font-family:var(--f-num)">${Math.round(p.equity * 100)}%</span></div>
      <div style="text-align:right;font-family:var(--f-num);font-weight:600;color:var(--accent)">${val ? fmtMoney(val * p.equity) : '--'}</div>
    </div>`;
  });
  html += `</div></div>`;

  // 3. 份额表单卡片群（使用独立区块保证输入框绝不对不齐）
  html += `<div style="margin-bottom:16px">
    <div style="font-size:11px;color:var(--t3);margin-bottom:8px;font-weight:500">持仓份额管理</div>
    <div style="display:flex;flex-direction:column;gap:8px">`;

  getActiveProducts().forEach(p => {
    const shares = holdings[p.code] || 0;
    html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg3);border-radius:10px;border:1px solid var(--bd)">
      <div>
        <div style="font-size:14px;font-weight:600;color:var(--t1)">${getProductName(p.code)}</div>
        <div style="font-size:11px;color:var(--t3);margin-top:2px">${p.code} · 权益 <span style="font-family:var(--f-num)">${Math.round(p.equity * 100)}%</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input id="hi_${p.code}" type="number" step="0.01" style="width:120px;height:34px;background:var(--bg);border:1px solid var(--bd2);border-radius:6px;color:var(--t1);text-align:right;font-size:16px;font-family:var(--f-num);padding:0 10px" value="${shares.toFixed(2)}" placeholder="0.00">
        <span style="font-size:12px;color:var(--t3)">份</span>
      </div>
    </div>`;
  });
  html += `</div></div>`;

  // 4. 底部按钮
  html += `<div style="display:flex;gap:10px;margin-top:20px">
    <button onclick="exportToken()" style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--bd2);background:var(--bg);color:var(--t2);font-size:13px;font-weight:500;cursor:pointer">🔑 导出备份口令</button>
    <button onclick="importToken()" style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--bd2);background:var(--bg);color:var(--t2);font-size:13px;font-weight:500;cursor:pointer">📥 口令恢复</button>
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

// ---- 口令备份 ----
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
  const currentPE      = getCurrentPE();
  const holdings       = loadHoldings();
  const buyData        = calcBuyPlanDraft(holdings);
  const savedPlan      = JSON.parse(localStorage.getItem(STORE_SELL_PLAN) || '{}');
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
      <div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:10px;color:var(--t3)">持仓: ${(holdings[p.code] || 0).toFixed(2)} 份</div><div id="sell_calc_fiat_${p.code}" style="font-size:11px;color:var(--t3)">-- 元</div></div>
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
  const holdings       = loadHoldings();
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
    const res = draft.results?.[p.code];
    const elS = document.getElementById('sell_calc_shares_' + p.code);
    const elF = document.getElementById('sell_calc_fiat_'  + p.code);
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
    btn.innerHTML         = isPri ? '★ 优先' : '☆ 优先';
    btn.style.color       = isPri ? '#f59e0b' : 'var(--t3)';
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
