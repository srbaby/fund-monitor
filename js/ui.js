// ============================================================
// ui.js - 渲染层
// 职责：所有 DOM 更新，时钟、指数栏、PE 栏、卡片、表格、今日盈亏渲染
// 不含业务计算，不含 localStorage 读写
// ============================================================

// ---- 模块状态 ----
let _mktOpen      = null;          // 上次市场状态，用于避免重复更新标签
let allCollapsed  = true;          // 桌面端收窄状态（默认 true 但桌面 CSS 隐藏按钮）
let mobileExpanded = false;        // 手机端展开状态（默认收窄）
let miniMode      = 0;             // 手机收窄模式：0=估算 1=官方 2=全部
let cardSortable  = null;          // 卡片拖拽实例
let tblSortable   = null;          // 表格拖拽实例
const miniLabels  = ['估算', '官方', '全部'];
const prevData    = {};            // 上次渲染数据，用于闪烁追踪
const idxPrev     = {};            // 上次指数价格，用于指数闪烁

// ---- 格式化工具 ----
function fp(v) {
  if (v == null) return {cls: 'flat', txt: '--'};
  return {cls: v > 0 ? 'up' : v < 0 ? 'down' : 'flat', txt: (v > 0 ? '+' : '') + v.toFixed(2) + '%'};
}
function fmt(n, decimals = 0) {
  return (n == null || isNaN(n)) ? '--' : n.toLocaleString('zh-CN', {minimumFractionDigits: decimals, maximumFractionDigits: decimals});
}
function fmtMoney(n) { return '¥' + fmt(n, 0); }
function getProductName(code) { return SHORT_NAMES[code] || (PRODUCTS.find(p => p.code === code)?.name) || code; }

// ---- 时钟与市场状态标签 ----
function updateClock() {
  const n = new Date();
  document.getElementById('liveTime').textContent = [n.getHours(), n.getMinutes(), n.getSeconds()].map(v => String(v).padStart(2, '0')).join(':');
  document.getElementById('liveDate').textContent = `${n.getFullYear()}/${String(n.getMonth()+1).padStart(2,'0')}/${String(n.getDate()).padStart(2,'0')} ${DAYS[n.getDay()]}`;
  const state = getMarketState();
  if (state !== _mktOpen) {
    _mktOpen = state;
    document.getElementById('mktDot').className = 'mkt-dot' + (state === 'TRADING' ? ' open' : '');
    const labels = {WEEKEND: '休市·周末', BEFORE_PRE: '盘前', PRE_MARKET: '盘前集合', TRADING: '交易中', MID_BREAK: '午休', POST_MARKET: '已收盘'};
    document.getElementById('mktLabel').textContent = labels[state] || '待机';
  }
}

// ---- 闪烁追踪 ----
function calcFlash(results) {
  const fl = {};
  results.forEach(f => {
    if (f.error) { fl[f.code] = {ef: '', of2: ''}; return; }
    const pr = prevData[f.code];
    fl[f.code] = {
      ef:  pr && pr.estPct !== f.estPct && f.estPct != null ? (f.estPct > (pr.estPct || 0) ? 'flash-up' : 'flash-down') : '',
      of2: pr && pr.offPct !== f.offPct && f.offPct != null ? (f.offPct > (pr.offPct || 0) ? 'flash-up' : 'flash-down') : ''
    };
    prevData[f.code] = {estPct: f.estPct, offPct: f.offPct};
  });
  return fl;
}

// ---- 指数栏 ----
function renderIndices(map) {
  document.getElementById('idxBar').innerHTML = INDICES.map(idx => {
    const d = map[idx.id];
    if (!d || !d.f2) return `<div class="idx-cell"><div class="idx-lbl">${idx.lbl}</div><div class="idx-row"><div class="idx-chg flat">—</div></div></div>`;
    const price = typeof d.f2 === 'number' ? d.f2.toFixed(2) : String(d.f2);
    const pct   = d.f3 ?? 0;
    const cls   = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const sign  = pct > 0 ? '+' : '';
    const old   = idxPrev[idx.id];
    const flash = old && old !== price ? (parseFloat(price) > parseFloat(old) ? 'flash-up' : 'flash-down') : '';
    idxPrev[idx.id] = price;
    return `<div class="idx-cell ${cls} ${flash}"><div class="idx-lbl">${idx.lbl}</div><div class="idx-row"><div class="idx-chg ${cls}">${sign}${typeof pct === 'number' ? pct.toFixed(2) : pct}%</div><div class="idx-price">${price}</div></div></div>`;
  }).join('');
}

// ---- PE 栏 ----
function updatePeBar() {
  const currentPE = getCurrentPE();
  const display   = document.getElementById('peDisplay');
  const status    = document.getElementById('peStatus');
  const marker    = document.getElementById('peTrackMarker');
  const planBtn   = document.getElementById('planBtn');
  const eqDiv     = document.getElementById('peEquityInfo');
  const loEl      = document.getElementById('peTrackLo');
  const hiEl      = document.getElementById('peTrackHi');

  if (!currentPE) {
    display.textContent = '--.--%'; display.className = 'pe-value pe-normal';
    status.textContent  = '未输入PE'; status.className = 'pe-status normal';
    planBtn.className   = 'pe-plan-btn neutral'; planBtn.textContent = '预案';
    if (marker) marker.style.display = 'none';
    if (loEl)   loEl.style.display   = 'none';
    if (hiEl)   hiEl.style.display   = 'none';
    if (eqDiv)  eqDiv.style.display  = 'none';
    return;
  }

  const v = currentPE.value, bounds = currentPE.bounds;
  display.innerHTML = `<span style="font-family:var(--f-num)">${v.toFixed(2)}%</span>`
    + (currentPE.isDynamic ? `<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:4px;vertical-align:top">实时</span>` : '');

  const PE_MID = (bounds.buyPct + bounds.sellPct) / 2;
  const span   = (bounds.sellPct - bounds.buyPct) * 2;
  const peMin  = PE_MID - span / 2, peMax = PE_MID + span / 2;
  const toPos  = pe => Math.min(Math.max((pe - peMin) / (peMax - peMin) * 100, 0), 100);

  if (marker) { marker.style.display = 'block'; marker.style.left = toPos(v) + '%'; }
  if (loEl)   { loEl.style.display   = 'block'; loEl.style.left   = toPos(bounds.buyPct) + '%'; }
  if (hiEl)   { hiEl.style.display   = 'block'; hiEl.style.left   = toPos(bounds.sellPct) + '%'; }

  if (eqDiv) {
    const eqData = calcCurrentEquity(loadHoldings());
    const target = getDynamicTarget('neutral');
    if (eqData && target != null) {
      const diff     = eqData.equity - target;
      const sign     = diff > 0 ? '+' : '';
      const wrongDir = (v >= 65 && diff > 2) || (v < 65 && diff < -2);
      const col      = wrongDir ? '#f87171' : (diff > 0 ? '#f59e0b' : '#60a5fa');
      eqDiv.innerHTML = `目标<b style="font-family:var(--f-num)">${target}%</b> 实际<b style="color:${col};font-family:var(--f-num)">${eqData.equity.toFixed(2)}%</b> <span style="color:${col};font-family:var(--f-num)">${sign}${diff.toFixed(2)}%</span>`;
      eqDiv.style.display = 'flex';
    } else {
      eqDiv.style.display = 'none';
    }
  }

  if (v <= bounds.buyPct) {
    display.className = 'pe-value pe-danger-dn'; status.textContent = '▲ 增权信号'; status.className = 'pe-status triggered-buy';
    planBtn.className = 'pe-plan-btn buy'; planBtn.textContent = '增权';
    if (marker) marker.style.background = '#3b82f6';
  } else if (v >= bounds.sellPct) {
    display.className = 'pe-value pe-danger-up'; status.textContent = '▼ 降权信号'; status.className = 'pe-status triggered-sell';
    planBtn.className = 'pe-plan-btn sell'; planBtn.textContent = '降权';
    if (marker) marker.style.background = '#f59e0b';
  } else {
    display.className = 'pe-value pe-normal'; status.textContent = '待机'; status.className = 'pe-status normal';
    planBtn.className = 'pe-plan-btn neutral'; planBtn.textContent = '预案';
    if (marker) marker.style.background = 'var(--t1)';
  }
}

// ---- 卡片 HTML ----
function inlinePctHtml(ep, op, stale, ef, of2) {
  const staleCls = stale ? ' stale-text' : '';
  const opCls    = stale ? 'flat' : op.cls;
  if (miniMode === 0) return `<span class="inline-pct ${ep.cls} ${ef}">${ep.txt}</span>`;
  if (miniMode === 1) return `<span class="inline-pct ${opCls} ${of2}${staleCls}">${op.txt}</span>`;
  return `<span class="inline-pct"><span class="${ep.cls} ${ef}">${ep.txt}</span><span style="color:var(--t3);margin:0 3px">|</span><span class="${opCls} ${of2}${staleCls}">${op.txt}</span></span>`;
}

function buildCardInnerHtml(f, fl, today, tradingDay) {
  if (f.error) return `<div class="card-top"><span class="drag-handle">⠿</span><div class="card-info"><div class="card-name-box"><div class="card-name" style="color:var(--t3)">${f.name || NAMES[f.code] || f.code}</div><div class="card-code">${f.code}</div></div></div><div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div></div><div style="padding:10px 16px 14px;font-size:12px;color:var(--t3);border-top:1px solid var(--bd)">⚠ 获取超时，请刷新</div>`;

  const ep = fp(f.estPct), op = fp(f.offPct);
  const {ef, of2} = (fl || {})[f.code] || {ef: '', of2: ''};
  const isStale   = (f.estTime && f.estTime.slice(0, 10) === today || tradingDay) && (!f.offDate || f.offDate.slice(0, 10) < today);

  return `<div class="card-top">
    <span class="drag-handle">⠿</span>
    <div class="card-info"><div class="card-name-box"><div class="card-name">${f.name}</div><div class="card-code">${f.code}</div></div></div>
    ${inlinePctHtml(ep, op, isStale, ef, of2)}
    <div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div>
  </div>
  <div class="card-data">
    <div class="data-half">
      <div class="dh-label">盘中估算</div>
      <div class="dh-pct ${ep.cls} ${ef}">${ep.txt}</div>
      <div class="dh-meta"><span>净值 <b>${f.estVal || '--'}</b></span><span>${f.estTime ? f.estTime.slice(11,16) : '--'}</span></div>
    </div>
    <div class="data-half${isStale ? ' stale' : ''}">
      <div class="dh-label">官方数据</div>
      <div class="dh-pct ${op.cls} ${of2}">${op.txt}</div>
      <div class="dh-meta"><span>净值 <b>${f.offVal || '--'}</b></span><span>${f.offDate ? f.offDate.slice(5) : '--'}</span></div>
    </div>
  </div>`;
}

function renderCards(results, fl, today, tradingDay) {
  const container  = document.getElementById('cardView');
  const currentCodes = Array.from(container.children).filter(c => c.dataset?.code).map(c => c.dataset.code);
  const targetCodes  = results.map(r => r.code);
  const isStructureSame = currentCodes.length > 0 && currentCodes.join(',') === targetCodes.join(',');
  const isMobile   = window.matchMedia('(max-width:767px)').matches;
  const collapsed  = isMobile ? !mobileExpanded : allCollapsed;

  if (!isStructureSame) {
    container.innerHTML = results.map(f => {
      const cc = (f.estPct != null && !f.error) ? (f.estPct > 0 ? 'up-card' : f.estPct < 0 ? 'down-card' : '') : '';
      return `<div class="fund-card ${cc}${collapsed ? ' collapsed' : ''}" data-code="${f.code}">${buildCardInnerHtml(f, fl, today, tradingDay)}</div>`;
    }).join('') || `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无关注基金</div></div>`;
    return;
  }

  results.forEach(f => {
    const el = container.querySelector(`[data-code="${f.code}"]`);
    if (el) {
      const cc = (f.estPct != null && !f.error) ? (f.estPct > 0 ? 'up-card' : f.estPct < 0 ? 'down-card' : '') : '';
      el.className = `fund-card ${cc}${collapsed ? ' collapsed' : ''}`;
      el.innerHTML = buildCardInnerHtml(f, fl, today, tradingDay);
    }
  });
}

// ---- 表格 HTML ----
function buildTableInnerHtml(f, fl, today, tradingDay) {
  if (f.error) return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name" style="color:var(--t3)">${NAMES[f.code] || f.code}</div><div class="tbl-code">${f.code}</div></div></td><td colspan="2" style="color:var(--t3);font-size:12px">⚠ 获取超时</td><td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;

  const ep = fp(f.estPct), op = fp(f.offPct);
  const {ef, of2}  = (fl || {})[f.code] || {ef: '', of2: ''};
  const tblStale   = (f.estTime && f.estTime.slice(0,10) === today || tradingDay) && (!f.offDate || f.offDate.slice(0,10) < today);

  return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name">${f.name}</div><div class="tbl-code">${f.code}</div></div></td>
    <td><div class="tbl-pct ${ep.cls} ${ef}">${ep.txt}</div><div class="tbl-nav">净值 <span class="nv">${f.estVal || '--'}</span></div><div class="tbl-time">${f.estTime || '--'}</div></td>
    <td style="${tblStale ? 'opacity:0.35;filter:grayscale(1)' : ''}"><div class="tbl-pct ${op.cls} ${of2}">${op.txt}</div><div class="tbl-nav">净值 <span class="nv">${f.offVal || '--'}</span></div><div class="tbl-time">${f.offDate || '--'}</div></td>
    <td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;
}

function renderTable(results, fl, today, tradingDay) {
  const container = document.getElementById('fundTbody');
  const currentCodes = Array.from(container.children).filter(c => c.dataset?.code).map(c => c.dataset.code);
  const targetCodes  = results.map(r => r.code);
  const isStructureSame = currentCodes.length > 0 && currentCodes.join(',') === targetCodes.join(',');

  if (!isStructureSame) {
    container.innerHTML = results.map(f => `<tr data-code="${f.code}">${buildTableInnerHtml(f, fl, today, tradingDay)}</tr>`).join('');
    return;
  }
  results.forEach(f => {
    const el = container.querySelector(`[data-code="${f.code}"]`);
    if (el) el.innerHTML = buildTableInnerHtml(f, fl, today, tradingDay);
  });
}

// ---- 今日盈亏 ----
function renderTodayProfit(results, mktState, todayStr) {
  const profitEl = document.getElementById('todayProfit');
  if (!profitEl) return;
  const holdings = loadHoldings();
  const {totalProfit, totalYestVal, allUpdated, hasHoldings, isWaitingForOpen} = calcTodayProfit(results, holdings, mktState, todayStr);

  if (isWaitingForOpen) {
    profitEl.innerHTML = `<span style="color:var(--t3)">-</span>`;
  } else if (hasHoldings) {
    const sign   = totalProfit > 0 ? '+' : '';
    const cls    = totalProfit > 0 ? 'up' : totalProfit < 0 ? 'down' : 'flat';
    const pctVal = totalYestVal > 0 ? (totalProfit / totalYestVal) * 100 : null;
    const pctText = pctVal !== null ? `(${sign}${pctVal.toFixed(2)}%)` : '';
    const rightBlock = allUpdated
      ? `<span style="display:inline-flex;flex-direction:column;justify-content:center;align-items:flex-start;margin-left:6px"><span style="font-size:9px;color:#d97706;font-weight:500;font-family:var(--f-zh);line-height:1.2;margin-bottom:1px">已更新</span><span style="font-size:11px;font-weight:600;line-height:1.2;color:var(--t2)">${pctText}</span></span>`
      : `<span style="font-size:13px;font-weight:600;margin-left:6px">${pctText}</span>`;
    profitEl.innerHTML = `<span class="${cls}" style="display:flex;align-items:center">${sign}${totalProfit.toFixed(2)}</span>${rightBlock}`;
  } else {
    profitEl.innerHTML = '';
  }
}

// ---- 渲染总调度 ----
function renderAll(results) {
  _lastResults = results;
  updatePeBar();
  const fl         = calcFlash(results);
  const today      = todayDateStr();
  const mktState   = getMarketState();
  const tradingDay = (mktState !== 'WEEKEND' && mktState !== 'BEFORE_PRE');
  const resultMap  = new Map(results.map(r => [r.code, r]));
  const uiResults  = funds.map(code => resultMap.get(code)).filter(Boolean);

  renderCards(uiResults, fl, today, tradingDay);
  renderTable(uiResults, fl, today, tradingDay);
  renderTodayProfit(uiResults, mktState, today);
  document.getElementById('cardHeaderBar').style.display = uiResults.length ? 'flex' : 'none';
}

// ---- 收窄/展开控制 ----
function toggleAllCollapse() {
  if (window.matchMedia('(max-width:767px)').matches) {
    mobileExpanded = !mobileExpanded;
    document.getElementById('colBtn').textContent    = mobileExpanded ? '收窄' : '展开';
    document.getElementById('cycleBtn').style.display = mobileExpanded ? 'none' : '';
    if (_lastResults.length) renderAll(_lastResults);
    return;
  }
  allCollapsed = !allCollapsed;
  document.getElementById('colBtn').textContent     = allCollapsed ? '展开' : '收窄';
  document.getElementById('cycleBtn').style.display = allCollapsed ? '' : 'none';
  document.body.classList.toggle('collapsed-mode', allCollapsed);
  if (_lastResults.length) renderAll(_lastResults);
}

function cycleMiniMode() {
  miniMode = (miniMode + 1) % 3;
  document.getElementById('cycleBtn').textContent = miniLabels[miniMode];
  if (_lastResults.length) renderAll(_lastResults);
}