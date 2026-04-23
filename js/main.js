// ==========================================
// 1. 全局 UI 状态
// ==========================================
let _mktOpen = null;
let idxPrev = {};
const prevData = {};
let allCollapsed = false;
let miniMode = 0;
const miniLabels = ['盘中估算', '官方数据', '估算|官方'];
let cardSortable = null, tblSortable = null;
let _planMode = 'neutral';

// ==========================================
// 2. 定时器与基础视图 (顶栏/指数)
// ==========================================
function updateClock() {
  const n = new Date();
  document.getElementById('liveTime').textContent = [n.getHours(), n.getMinutes(), n.getSeconds()].map(v => String(v).padStart(2, '0')).join(':');
  document.getElementById('liveDate').textContent = `${n.getFullYear()}/${String(n.getMonth() + 1).padStart(2, '0')}/${String(n.getDate()).padStart(2, '0')} ${DAYS[n.getDay()]}`;
  
  const state = getMarketState();
  const open = (state === 'TRADING');
  
  if(state !== _mktOpen) {
    _mktOpen = state;
    document.getElementById('mktDot').className = 'mkt-dot' + (open ? ' open' : '');
    let lbl = '待机';
    if(state === 'WEEKEND') lbl = '休市·周末';
    else if(state === 'BEFORE_PRE') lbl = '盘前';
    else if(state === 'PRE_MARKET') lbl = '盘前集合';
    else if(state === 'TRADING') lbl = '交易中';
    else if(state === 'MID_BREAK') lbl = '午休';
    else if(state === 'POST_MARKET') lbl = '已收盘';
    document.getElementById('mktLabel').textContent = lbl;
  }
}

function renderIndices(map) {
  document.getElementById('idxBar').innerHTML = INDICES.map(idx => {
    const d = map[idx.id];
    if(!d || !d.f2) return `<div class="idx-cell"><div class="idx-lbl">${idx.lbl}</div><div class="idx-row"><div class="idx-chg flat">—</div></div></div>`;
    
    const price = typeof d.f2 === 'number' ? d.f2.toFixed(2) : String(d.f2);
    const pct = d.f3 ?? 0;
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const sign = pct > 0 ? '+' : '';
    const old = idxPrev[idx.id];
    const flash = old && old !== price ? (parseFloat(price) > parseFloat(old) ? 'flash-up' : 'flash-down') : '';
    idxPrev[idx.id] = price;
    
    return `
      <div class="idx-cell ${cls} ${flash}">
        <div class="idx-lbl">${idx.lbl}</div>
        <div class="idx-row">
          <div class="idx-chg ${cls}">${sign}${typeof pct === 'number' ? pct.toFixed(2) : pct}%</div>
          <div class="idx-price">${price}</div>
        </div>
      </div>`;
  }).join('');
}

// ==========================================
// 3. 基金主数据渲染 (卡片/表格/盈亏推导)
// ==========================================
function fp(v) { 
  if(v == null) return {cls: 'flat', txt: '--'}; 
  return {cls: v > 0 ? 'up' : v < 0 ? 'down' : 'flat', txt: (v > 0 ? '+' : '') + v.toFixed(2) + '%'}; 
}

function toggleAllCollapse() { 
  allCollapsed = !allCollapsed; 
  document.getElementById('colBtn').textContent = allCollapsed ? '展开' : '收窄'; 
  document.getElementById('cycleBtn').style.display = allCollapsed ? '' : 'none'; 
  document.body.classList.toggle('collapsed-mode', allCollapsed); 
  if(_lastResults.length) renderAll(_lastResults); 
}

function cycleMiniMode() { 
  miniMode = (miniMode + 1) % 3; 
  document.getElementById('cycleBtn').textContent = miniLabels[miniMode]; 
  if(_lastResults.length) renderAll(_lastResults); 
}

function calcFlash(results) { 
  const fl = {}; 
  results.forEach(f => { 
    if(f.error) { fl[f.code] = {ef: '', of2: ''}; return; } 
    const pr = prevData[f.code]; 
    fl[f.code] = {
      ef: pr && pr.estPct !== f.estPct && f.estPct != null ? (f.estPct > (pr.estPct || 0) ? 'flash-up' : 'flash-down') : '',
      of2: pr && pr.offPct !== f.offPct && f.offPct != null ? (f.offPct > (pr.offPct || 0) ? 'flash-up' : 'flash-down') : ''
    }; 
  }); 
  results.forEach(f => { if(!f.error) prevData[f.code] = {estPct: f.estPct, offPct: f.offPct}; }); 
  return fl; 
}

function inlinePctHtml(ep, op, stale, ef, of2) { 
  const staleCls = stale ? ' stale-text' : '';
  const opCls = stale ? 'flat' : op.cls; 
  if(miniMode === 0) return `<span class="inline-pct ${ep.cls} ${ef}">${ep.txt}</span>`; 
  if(miniMode === 1) return `<span class="inline-pct ${opCls} ${of2}${staleCls}">${op.txt}</span>`; 
  return `<span class="inline-pct"><span class="${ep.cls} ${ef}">${ep.txt}</span><span style="color:var(--t3);margin:0 3px">|</span><span class="${opCls} ${of2}${staleCls}">${op.txt}</span></span>`; 
}

function renderAll(results) {
  _lastResults = results;
  updatePeBar();
  const fl = calcFlash(results);
  const today = todayDateStr();
  const mktState = getMarketState();
  const tradingDay = (mktState !== 'WEEKEND' && mktState !== 'BEFORE_PRE');
  const uiResults = funds.map(code => results.find(r => r.code === code)).filter(Boolean);
  
  renderCards(uiResults, fl, today, tradingDay);
  renderTable(uiResults, fl, today, tradingDay);
  renderTodayProfit(uiResults, mktState, today);
  
  document.getElementById('cardHeaderBar').style.display = uiResults.length ? 'flex' : 'none';
}

function renderTodayProfit(results, mktState, todayStr) {
  const profitEl = document.getElementById('todayProfit'); 
  if (!profitEl) return;

  const holdings = loadHoldings();
  let totalProfit = 0, allUpdated = true, hasHoldings = false;
  let isWaitingForOpen = (mktState === 'PRE_MARKET');
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code) || { code }).filter(Boolean);

  activeProducts.forEach(p => {
    const shares = holdings[p.code] || 0; 
    if (shares <= 0) return;
    
    const f = results.find(r => r.code === p.code); 
    if (!f || f.error) { allUpdated = false; return; }
    hasHoldings = true;

    const estD = f.estTime ? f.estTime.slice(0, 10) : '';
    const offD = f.offDate ? f.offDate.slice(0, 10) : '';
    let isOfficialUpdated = false;
    
    if (offD === todayStr) isOfficialUpdated = true;
    else if (mktState === 'WEEKEND' || mktState === 'BEFORE_PRE') isOfficialUpdated = true;
    else if (estD && offD && offD >= estD) isOfficialUpdated = true;

    if (!isOfficialUpdated) allUpdated = false;

    let nav = null, pct = null;
    if (isOfficialUpdated) { 
      nav = parseFloat(f.offVal); pct = parseFloat(f.offPct); 
    } else { 
      nav = parseFloat(f.estVal); pct = parseFloat(f.estPct); 
      if (estD !== todayStr && (mktState === 'PRE_MARKET' || mktState === 'TRADING')) isWaitingForOpen = true; 
    }

    if (!isNaN(nav) && !isNaN(pct)) { 
      const yestNav = nav / (1 + pct / 100); 
      totalProfit += shares * yestNav * (pct / 100); 
    }
  });

  if (isWaitingForOpen) {
    profitEl.innerHTML = `<span style="color:var(--t3)">-</span>`;
  } else if (hasHoldings) {
    const sign = totalProfit > 0 ? '+' : '';
    const cls = totalProfit > 0 ? 'up' : totalProfit < 0 ? 'down' : 'flat';
    const updatedLabel = allUpdated ? `<span style="font-size:10px; color:#d97706; font-weight:500; margin-left:6px; font-family:var(--f-zh)">已更新</span>` : '';
    profitEl.innerHTML = `<span class="${cls}">${sign}${totalProfit.toFixed(2)}</span>${updatedLabel}`;
  } else {
    profitEl.innerHTML = '';
  }
}

function renderCards(results, fl, today, tradingDay) {
  const html = results.map(f => {
    if (f.error) {
      return `
      <div class="fund-card" data-code="${f.code}">
        <div class="card-top">
          <span class="drag-handle">⠿</span>
          <div class="card-info">
            <div class="card-name-box">
              <div class="card-name" style="color:var(--t3)">${NAMES[f.code] || f.code}</div>
              <div class="card-code">${f.code}</div>
            </div>
          </div>
          <div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div>
        </div>
        <div style="padding:10px 16px 14px;font-size:12px;color:var(--t3);border-top:1px solid var(--bd)">⚠ 获取超时，请刷新</div>
      </div>`;
    }
    
    const ep = fp(f.estPct), op = fp(f.offPct);
    const cc = f.estPct != null ? (f.estPct > 0 ? 'up-card' : f.estPct < 0 ? 'down-card' : '') : '';
    const {ef, of2} = (fl || {})[f.code] || {ef: '', of2: ''};
    const isStale = (f.estTime && f.estTime.slice(0, 10) === today || tradingDay) && (!f.offDate || f.offDate.slice(0, 10) < today);
    
    return `
    <div class="fund-card ${cc}${allCollapsed ? ' collapsed' : ''}" data-code="${f.code}">
      <div class="card-top">
        <span class="drag-handle">⠿</span>
        <div class="card-info">
          <div class="card-name-box">
            <div class="card-name">${f.name}</div>
            <div class="card-code">${f.code}</div>
          </div>
        </div>
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
      </div>
    </div>`;
  }).join('');
  
  document.getElementById('cardView').innerHTML = html || `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无关注基金</div></div>`;
}

function renderTable(results, fl, today, tradingDay) {
  const html = results.map(f => {
    if(f.error) {
      return `
      <tr data-code="${f.code}">
        <td>
          <span class="tbl-drag">⠿</span>
          <div style="display:inline-block;vertical-align:top">
            <div class="tbl-name" style="color:var(--t3)">${NAMES[f.code] || f.code}</div>
            <div class="tbl-code">${f.code}</div>
          </div>
        </td>
        <td colspan="2" style="color:var(--t3);font-size:12px">⚠ 获取超时</td>
        <td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>
      </tr>`;
    }
    
    const ep = fp(f.estPct), op = fp(f.offPct);
    const {ef, of2} = (fl || {})[f.code] || {ef: '', of2: ''};
    const tblStale = (f.estTime && f.estTime.slice(0,10) === today || tradingDay) && (!f.offDate || f.offDate.slice(0,10) < today);
    
    return `
    <tr data-code="${f.code}">
      <td>
        <span class="tbl-drag">⠿</span>
        <div style="display:inline-block;vertical-align:top">
          <div class="tbl-name">${f.name}</div>
          <div class="tbl-code">${f.code}</div>
        </div>
      </td>
      <td>
        <div class="tbl-pct ${ep.cls} ${ef}">${ep.txt}</div>
        <div class="tbl-nav">净值 <span class="nv">${f.estVal || '--'}</span></div>
        <div class="tbl-time">${f.estTime || '--'}</div>
      </td>
      <td style="${tblStale ? 'opacity:0.35;filter:grayscale(1)' : ''}">
        <div class="tbl-pct ${op.cls} ${of2}">${op.txt}</div>
        <div class="tbl-nav">净值 <span class="nv">${f.offVal || '--'}</span></div>
        <div class="tbl-time">${f.offDate || '--'}</div>
      </td>
      <td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>
    </tr>`;
  }).join('');
  
  document.getElementById('fundTbody').innerHTML = html;
}

// ==========================================
// 4. 用户行为与列表控制
// ==========================================
async function refreshData() {
  const miniRefBtn = document.getElementById('miniRefBtn');
  if(miniRefBtn) { miniRefBtn.textContent = '↻'; miniRefBtn.disabled = true; }
  
  loadFunds(); 
  fetchIndices();
  
  if(!funds.length) {
    document.getElementById('cardView').innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无关注基金，输入代码添加</div></div>`;
    document.getElementById('fundTbody').innerHTML = `<tr><td colspan="4" style="text-align:center;padding:50px;color:var(--t3)">暂无关注基金</td></tr>`;
    if(miniRefBtn) { miniRefBtn.textContent = '↻ 刷新'; miniRefBtn.disabled = false; }
    return;
  }
  
  const allCodes = Array.from(new Set([...funds, ...PRODUCTS.map(p => p.code)]));
  const results = await Promise.all(allCodes.map(fetchSingleFund));
  
  renderAll(results);
  
  if(miniRefBtn) { miniRefBtn.textContent = '↻ 刷新'; miniRefBtn.disabled = false; }
  
  if(cardSortable) cardSortable.destroy();
  if(tblSortable) tblSortable.destroy();
  
  const onEnd = evt => { 
    const o = Array.from(evt.to.children).map(el => el.dataset.code).filter(Boolean); 
    if(o.length === funds.length) { funds = o; saveFunds(); }
  };
  
  cardSortable = Sortable.create(document.getElementById('cardView'), {handle: '.drag-handle', animation: 200, ghostClass: 'sortable-ghost', onEnd});
  tblSortable = Sortable.create(document.getElementById('fundTbody'), {handle: '.tbl-drag', animation: 200, ghostClass: 'sortable-ghost', onEnd});
}

function addFund() { 
  const input = document.getElementById('codeInput'); 
  const code = input.value.trim(); 
  if(/^\d{6}$/.test(code) && !funds.includes(code)) { 
    funds.push(code); 
    saveFunds(); 
    input.value = ''; 
    refreshData(); 
  } else {
    input.value = ''; 
  }
}

function delFund(code) { 
  if(!confirm(`确认删除「${NAMES[code] || code}」？`)) return; 
  funds = funds.filter(c => c !== code); 
  saveFunds(); 
  refreshData(); 
}

document.getElementById('codeInput').addEventListener('keydown', e => { if(e.key === 'Enter') addFund(); });

// ==========================================
// 5. PE 渲染与定锚操作
// ==========================================
function updatePeBar() {
  const currentPE = getCurrentPE();
  const display = document.getElementById('peDisplay');
  const status = document.getElementById('peStatus');
  const marker = document.getElementById('peTrackMarker');
  const planBtn = document.getElementById('planBtn');
  const eqDiv = document.getElementById('peEquityInfo');
  const loEl = document.getElementById('peTrackLo');
  const hiEl = document.getElementById('peTrackHi');

  if(!currentPE) {
    display.textContent = '--.--%'; display.className = 'pe-value pe-normal';
    status.textContent = '未输入PE'; status.className = 'pe-status normal';
    planBtn.className = 'pe-plan-btn neutral'; planBtn.textContent = '待机预案';
    if(marker) marker.style.display = 'none'; 
    if(loEl) loEl.style.display = 'none'; 
    if(hiEl) hiEl.style.display = 'none'; 
    if(eqDiv) eqDiv.style.display = 'none';
    return;
  }

  const v = currentPE.value;
  const bounds = currentPE.bounds;
  display.innerHTML = `<span style="font-family:var(--f-num)">${v.toFixed(2)}%</span>` + 
                      (currentPE.isDynamic ? `<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:4px;vertical-align:top">实时</span>` : '');

  const PE_MID = (bounds.buyPct + bounds.sellPct) / 2;
  const span = (bounds.sellPct - bounds.buyPct) * 2; 
  const peMin = PE_MID - span / 2;
  const peMax = PE_MID + span / 2;
  const toPos = pe => Math.min(Math.max((pe - peMin) / (peMax - peMin) * 100, 0), 100);

  if(marker) { marker.style.display = 'block'; marker.style.left = toPos(v) + '%'; }
  if(loEl) { loEl.style.display = 'block'; loEl.style.left = toPos(bounds.buyPct) + '%'; }
  if(hiEl) { hiEl.style.display = 'block'; hiEl.style.left = toPos(bounds.sellPct) + '%'; }

  if(eqDiv) {
    const holdings = loadHoldings();
    const eq = calcCurrentEquity(holdings);
    let target = null;
    if (currentPE.rawData && currentPE.rawData.bucketStr) {
      const lo = parseFloat(currentPE.rawData.bucketStr.split(',')[0]); 
      const r = PE_EQUITY_TABLE.find(x => lo >= x.lo && lo < x.hi);
      if (r) target = r.target;
    }
    
    if(eq && target != null) {
      const diff = eq.equity - target;
      const sign = diff > 0 ? '+' : '';
      const wrongDir = (v >= 65 && diff > 2) || (v < 65 && diff < -2);
      const col = wrongDir ? '#f87171' : (diff > 0 ? '#f59e0b' : '#60a5fa');
      eqDiv.innerHTML = `目标<b style="font-family:var(--f-num)">${target}%</b> 实际<b style="color:${col};font-family:var(--f-num)">${eq.equity.toFixed(2)}%</b> <span style="color:${col};font-family:var(--f-num)">${sign}${diff.toFixed(2)}%</span>`;
      eqDiv.style.display = 'flex';
    } else {
      eqDiv.style.display = 'none';
    }
  }

  if(v <= bounds.buyPct) { 
    display.className = 'pe-value pe-danger-dn'; 
    status.textContent = '▲ 增权信号'; 
    status.className = 'pe-status triggered-buy'; 
    planBtn.className = 'pe-plan-btn buy'; 
    planBtn.textContent = '▲ 增权预案'; 
    if(marker) marker.style.background = '#3b82f6'; 
  } else if(v >= bounds.sellPct) { 
    display.className = 'pe-value pe-danger-up'; 
    status.textContent = '▼ 降权信号'; 
    status.className = 'pe-status triggered-sell'; 
    planBtn.className = 'pe-plan-btn sell'; 
    planBtn.textContent = '▼ 降权预案'; 
    if(marker) marker.style.background = '#f59e0b'; 
  } else { 
    display.className = 'pe-value pe-normal'; 
    status.textContent = '待机'; 
    status.className = 'pe-status normal'; 
    planBtn.className = 'pe-plan-btn neutral'; 
    planBtn.textContent = '待机预案'; 
    if(marker) marker.style.background = 'var(--t1)'; 
  }
}

function openPeModal() {
  const peData = loadPe();
  if(peData) {
    document.getElementById('peModalBucket').value = peData.bucketStr || '50,55';
    document.getElementById('peModalInputPct').value = peData.peYest || '';
    document.getElementById('peModalPriceAnchor').value = peData.priceAnchor || '';
    document.getElementById('peModalBuyPrice').value = peData.priceBuy || '';
    document.getElementById('peModalSellPrice').value = peData.priceSell || '';
  }
  document.getElementById('peModal').style.display = 'flex';
}

function closePeModal() { document.getElementById('peModal').style.display = 'none'; }

function confirmPe() {
  const bucketStr = document.getElementById('peModalBucket').value;
  const peYest = parseFloat(document.getElementById('peModalInputPct').value);
  const priceAnchor = parseFloat(document.getElementById('peModalPriceAnchor').value);
  const priceBuy = parseFloat(document.getElementById('peModalBuyPrice').value);
  const priceSell = parseFloat(document.getElementById('peModalSellPrice').value);

  if(isNaN(peYest) || isNaN(priceAnchor)) { alert('请填写完整的【基准PE】与【基准点位】！'); return; }
  savePe({ bucketStr, peYest, priceAnchor, priceBuy: isNaN(priceBuy) ? null : priceBuy, priceSell: isNaN(priceSell) ? null : priceSell });
  updatePeBar(); 
  closePeModal();
}

// ==========================================
// 6. 持仓管理与备份
// ==========================================
function openHoldingDrawer() {
  const holdings = loadHoldings();
  const body = document.getElementById('holdingDrawerBody');
  let totalVal = 0, totalEq = 0;
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);

  const rows = activeProducts.map(p => {
    const shares = holdings[p.code] || 0;
    const nav = getNavByCode(p.code);
    const val = (nav != null) ? shares * nav : null;
    if(val != null) { totalVal += val; totalEq += val * p.equity; }
    return {p, shares, nav, val, eqVal: val != null ? val * p.equity : null};
  });

  const currentPE = getCurrentPE();
  let targetEq = null;
  if (currentPE && currentPE.rawData && currentPE.rawData.bucketStr) {
      const lo = parseFloat(currentPE.rawData.bucketStr.split(',')[0]); 
      const r = PE_EQUITY_TABLE.find(x => lo >= x.lo && lo < x.hi);
      if (r) targetEq = r.target;
  }

  const actualEqPct = totalVal > 0 ? totalEq / totalVal * 100 : null;
  const diff = actualEqPct != null && targetEq != null ? actualEqPct - targetEq : null;
  const wrongDir = diff != null && currentPE ? ((currentPE.value >= 65 && diff > 2) || (currentPE.value < 65 && diff < -2)) : false;
  const diffCol = diff == null ? 'var(--t3)' : wrongDir ? '#f87171' : (diff > 0 ? '#f59e0b' : '#60a5fa');

  let htmlStr = `
    <div style="background:var(--bg3);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid var(--bd)">
      <div style="font-size:11px;color:var(--t3);margin-bottom:8px;font-weight:500">📊 权益校对汇总</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div>
          <div style="font-size:10px;color:var(--t3)">持仓总市值</div>
          <div style="font-family:var(--f-num);font-size:15px;font-weight:600">${totalVal > 0 ? fmtMoney(totalVal) : '--'}</div>
        </div>
        <div>
          <div style="font-size:10px;color:var(--t3)">实际权益</div>
          <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:${diffCol}">${actualEqPct != null ? actualEqPct.toFixed(2) + '%' : '--'}</div>
        </div>
        <div>
          <div style="font-size:10px;color:var(--t3)">目标权益</div>
          <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:var(--accent)">${targetEq != null ? targetEq + '%' : '输入PE'}</div>
        </div>
      </div>
      ${diff != null ? `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);font-size:11px">
        偏离：<span style="font-family:var(--f-num);font-weight:600;color:${diffCol}">${diff > 0 ? '+' : ''}${diff.toFixed(2)}%</span>
        ${wrongDir ? '<span style="color:#f87171;margin-left:6px">⚠️ 方向警告</span>' : ''}
      </div>` : ''}
    </div>
    
    <div style="font-size:11px;color:var(--t3);margin-bottom:10px">明细（份额×估值=市值，→权益贡献）</div>
    <div style="background:var(--bg3);border-radius:10px;overflow:hidden;margin-bottom:14px;border:1px solid var(--bd)">`;

  rows.forEach(({p, shares, nav, val, eqVal}) => {
    htmlStr += `
      <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--bd);font-size:12px">
        <div>
          <div style="font-weight:500">${p.name}</div>
          <div style="font-size:10px;color:var(--t3);white-space:nowrap;">
            <span style="font-family:var(--f-num)">${shares.toFixed(2)}</span> 份 × <span style="font-family:var(--f-num)">${nav ? nav.toFixed(4) : '--'}</span>
          </div>
        </div>
        <div style="text-align:right;font-family:var(--f-num);color:var(--t2)">${val != null ? fmtMoney(val) : '--'}</div>
        <div style="text-align:right;font-size:10px;color:var(--t3)">×<span style="font-family:var(--f-num)">${Math.round(p.equity * 100)}%</span></div>
        <div style="text-align:right;font-family:var(--f-num);font-weight:500;color:var(--accent)">${eqVal != null ? fmtMoney(eqVal) : '--'}</div>
      </div>`;
  });

  htmlStr += `
      <div style="display:grid;grid-template-columns:1fr auto;padding:10px 12px;font-size:12px;font-weight:600">
        <div>权益合计</div>
        <div style="font-family:var(--f-num);color:var(--accent)">${totalEq > 0 ? fmtMoney(totalEq) : '--'}</div>
      </div>
    </div>`;

  activeProducts.forEach(p => {
    htmlStr += `
    <div class="holding-row">
      <div class="holding-name">
        <div style="font-size:13px;font-weight:500">${getProductName(p.code)}</div>
        <div style="font-size:11px;color:var(--t3)">${p.code}·权益<span style="font-family:var(--f-num)">${Math.round(p.equity * 100)}%</span></div>
      </div>
      <input class="holding-input" id="hi_${p.code}" type="number" step="0.01" style="font-size:16px" value="${(holdings[p.code] || 0).toFixed(2)}" placeholder="0">
      <span class="holding-unit">份</span>
    </div>`;
  });

  htmlStr += `
    <div style="margin-top:16px;display:flex;gap:8px">
      <button onclick="exportHoldings()" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--bd2);background:transparent;color:var(--t2);font-size:12px;cursor:pointer">📤 导出备份</button>
      <button onclick="importHoldings()" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--bd2);background:transparent;color:var(--t2);font-size:12px;cursor:pointer">📥 导入备份</button>
    </div>`;

  body.innerHTML = htmlStr;
  openDrawer('holdingDrawer');
}

function saveHoldings() {
  const h = loadHoldings();
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);
  activeProducts.forEach(p => { 
    const v = parseFloat(document.getElementById('hi_' + p.code)?.value || '0'); 
    h[p.code] = isNaN(v) ? 0 : v; 
  });
  saveHoldingsData(h); 
  closeAllDrawers(); 
  alert('✅ 持仓已保存');
}

function exportHoldings() {
  const data = JSON.stringify({holdings: loadHoldings(), pe: loadPe(), exported: new Date().toISOString()}, null, 2);
  const a = document.createElement('a'); 
  a.href = URL.createObjectURL(new Blob([data], {type: 'application/json'}));
  a.download = `基金持仓备份_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.json`; 
  a.click();
}

function importHoldings() {
  const input = document.createElement('input'); 
  input.type = 'file'; 
  input.accept = '.json';
  input.onchange = e => {
    const reader = new FileReader();
    reader.onload = ev => {
      try { 
        const data = JSON.parse(ev.target.result); 
        if(data.holdings) {
          saveHoldingsData(data.holdings);
          if(data.pe) savePe(data.pe);
          closeAllDrawers();
          updatePeBar();
          alert('✅ 导入成功');
        } else {
          alert('❌ 格式错误');
        } 
      } catch(err) {
        alert('❌ 解析失败：' + err.message);
      }
    }; 
    reader.readAsText(e.target.files[0]);
  }; 
  input.click();
}

// ==========================================
// 7. 纯计算待机预案 (不修改任何数据)
// ==========================================
function openPlanDrawer() {
  const currentPE = getCurrentPE();
  if(!currentPE) { alert('请先定锚！'); openPeModal(); return; }
  
  _planMode = currentPE.value <= currentPE.bounds.buyPct ? 'buy' : (currentPE.value >= currentPE.bounds.sellPct ? 'sell' : 'neutral');
  renderPlanDrawer(); 
  openDrawer('planDrawer');
}

function renderPlanDrawer() {
  const holdings = loadHoldings();
  const body = document.getElementById('planDrawerBody');
  const currentPE = getCurrentPE();
  const peVal = currentPE ? currentPE.value : null;
  const eqResult = calcCurrentEquity(holdings);
  const currentEq = eqResult ? eqResult.equity : null;
  const totalVal = eqResult ? eqResult.total : null;

  const BUY_TARGET = getDynamicTarget('buy') || 34.0;
  const SELL_TARGET = getDynamicTarget('sell') || 25.0;
  const currentEqVal = totalVal && currentEq ? totalVal * currentEq / 100 : null;
  const buyNeededEq = currentEqVal != null ? Math.max(0, totalVal * BUY_TARGET / 100 - currentEqVal) : null;
  const diffEqPct = currentEq != null ? Math.max(0, currentEq - SELL_TARGET).toFixed(2) : null;

  const buyAmt = buyNeededEq; 
  const xqNav = getNavByCode(SYS_CONFIG.CODE_XQ) || 1.0;
  const a500cNav = getNavByCode(SYS_CONFIG.CODE_A500) || 1.0;
  const zz500cNav = getNavByCode(SYS_CONFIG.CODE_ZZ500) || 1.0;
  
  const sellXqShares = buyAmt != null ? buyAmt / xqNav : null;
  
  const currA500CVal = totalVal ? (holdings[SYS_CONFIG.CODE_A500] || 0) * a500cNav : 0;
  const maxA500CVal = totalVal ? totalVal * SYS_CONFIG.LIMIT_A500C : 0; 
  const a500cRoom = Math.max(0, maxA500CVal - currA500CVal);

  const allocA500C = buyAmt != null ? Math.min(buyAmt, a500cRoom) : null;
  const allocZZ500C = buyAmt != null ? buyAmt - allocA500C : null;

  const savedPlan = JSON.parse(localStorage.getItem(STORE_SELL_PLAN) || '{}');
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);

  let htmlStr = `
    <div style="background:var(--bg3);border-radius:10px;padding:10px 12px;margin-bottom:16px;border:1px solid var(--bd);font-size:12px;color:var(--t2)">
      当前PE <b style="color:var(--t1);font-family:var(--f-num)">${peVal != null ? peVal.toFixed(2) + '%' : '--'}</b>
      · 当前权益 <b style="color:var(--t1);font-family:var(--f-num)">${currentEq != null ? currentEq.toFixed(2) + '%' : '--'}</b>
      · 总市值 <b style="color:var(--t1);font-family:var(--f-num)">${totalVal != null ? fmtMoney(totalVal) : '--'}</b>
    </div>

    <div style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:11px;font-weight:600;color:#60a5fa;background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);border-radius:6px;padding:2px 8px">▲ 增权预案评估</span>
      </div>
      <div style="background:rgba(59,130,246,.05);border:1px solid rgba(59,130,246,.15);border-radius:10px;padding:12px">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
          <div>
            <div style="font-size:10px;color:var(--t3)">当前权益</div>
            <div style="font-family:var(--f-num);font-size:15px;font-weight:600">${currentEq != null ? currentEq.toFixed(2) + '%' : '--'}</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--t3)">触发后目标</div>
            <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#60a5fa">${BUY_TARGET}%</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--t3)">需调配金额</div>
            <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#60a5fa">${buyAmt != null ? fmtMoney(buyAmt) : '--'}</div>
          </div>
        </div>
        
        <div style="font-size:11px;color:var(--t3);margin: 16px 0 8px 0;">资金筹集 (固定卖出底仓债基)</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(240,68,68,0.3)">
            <div>
              <div style="display:flex;align-items:baseline;gap:6px;">
                <div style="font-size:13px;font-weight:500">卖 兴全中长债</div>
                <div style="font-size:10px;color:var(--t3)">当前持仓 <span style="font-family:var(--f-num)">${holdings[SYS_CONFIG.CODE_XQ] ? fmt(holdings[SYS_CONFIG.CODE_XQ], 2) : '0.00'}</span> 份</div>
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-family:var(--f-num);font-size:14px;font-weight:600;color:var(--up)">${buyAmt != null ? fmtMoney(buyAmt) : '--'}</div>
              <div style="font-size:10px;color:var(--t3);font-family:var(--f-num);margin-top:2px;">~${sellXqShares != null ? fmt(sellXqShares, 2) : '--'} <span style="font-family:var(--f-zh)">份</span></div>
            </div>
          </div>
        </div>

        <div style="font-size:11px;color:var(--t3);margin: 16px 0 8px 0;">目标分配 (优先A500C，单品上限${Math.round(SYS_CONFIG.LIMIT_A500C * 100)}%)</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid ${allocA500C > 0 ? 'rgba(59,130,246,0.3)' : 'var(--bd)'}">
            <div>
              <div style="display:flex;align-items:baseline;gap:6px;">
                <div style="font-size:13px;font-weight:500">买 A500C</div>
                <div style="font-size:10px;color:var(--t3)">当前占比 <span style="font-family:var(--f-num)">${totalVal ? ((currA500CVal / totalVal) * 100).toFixed(2) : '0.00'}%</span></div>
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-family:var(--f-num);font-size:14px;font-weight:600;color:#60a5fa">${allocA500C != null ? fmtMoney(allocA500C) : '--'}</div>
              <div style="font-size:10px;color:var(--t3);font-family:var(--f-num);margin-top:2px;">~${allocA500C != null ? fmt(allocA500C / a500cNav, 2) : '--'} <span style="font-family:var(--f-zh)">份</span></div>
            </div>
          </div>
          
          ${allocZZ500C > 0 ? `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(59,130,246,0.3)">
            <div>
              <div style="font-size:13px;font-weight:500">买 中证500C</div>
              <div style="font-size:10px;color:var(--t3);margin-top:2px;">超额溢出部分</div>
            </div>
            <div style="text-align:right">
              <div style="font-family:var(--f-num);font-size:14px;font-weight:600;color:#60a5fa">${fmtMoney(allocZZ500C)}</div>
              <div style="font-size:10px;color:var(--t3);font-family:var(--f-num);margin-top:2px;">~${fmt(allocZZ500C / zz500cNav, 2)} <span style="font-family:var(--f-zh)">份</span></div>
            </div>
          </div>` : ''}
        </div>
      </div>
    </div>

    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-size:11px;font-weight:600;color:#f59e0b;background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);border-radius:6px;padding:2px 8px">▼ 降权预案评估</span>
        <button onclick="saveSellPlan()" style="font-size:11px;padding:3px 10px;border-radius:6px;border:1px solid var(--bd2);background:transparent;color:var(--t2);cursor:pointer">保存预案记录</button>
      </div>
      <div style="background:rgba(240,68,68,.04);border:1px solid rgba(240,68,68,.12);border-radius:10px;padding:12px">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
          <div>
            <div style="font-size:10px;color:var(--t3)">当前权益</div>
            <div style="font-family:var(--f-num);font-size:15px;font-weight:600">${currentEq != null ? currentEq.toFixed(2) + '%' : '--'}</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--t3)">触发后目标</div>
            <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#f87171">${SELL_TARGET}%</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--t3)">需减权益比例</div>
            <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#f59e0b">${diffEqPct != null ? diffEqPct + '%' : '--'}</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--t3);margin-bottom:10px">填比例（整数，空=不参与），各产品默认${SYS_CONFIG.FEE * 100}%摩擦</div>`;

  activeProducts.filter(p => p.equity > 0).forEach(p => {
    const shares = holdings[p.code] || 0;
    const nav = getNavByCode(p.code) || null;
    const saved = savedPlan[p.code] || '';
    const eqPct = Math.round(p.equity * 100);
    
    htmlStr += `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:12px;background:var(--bg3);border-radius:10px;margin-bottom:8px;border:1px solid var(--bd)">
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;min-height:48px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="font-size:14px;font-weight:600;color:var(--t1)">${getProductName(p.code)}</div>
            <div style="font-size:10px;color:var(--t2);background:var(--bg);padding:2px 6px;border-radius:4px;border:1px solid var(--bd2)">权益 ${eqPct}%</div>
          </div>
          <div style="font-size:11px;color:var(--t3);margin-top:6px;font-family:var(--f-num);white-space:nowrap;">
            ${shares.toFixed(2)} <span style="font-family:var(--f-zh)">份</span> × ${nav ? nav.toFixed(4) : '--'} × ${eqPct}%
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--t3);">减仓比例</span>
            <input type="tel" inputmode="numeric" pattern="[0-9]*" placeholder="0" 
                   style="width:48px;background:var(--bg);border:1px solid var(--bd2);border-radius:6px;color:var(--t1);font-family:var(--f-num);font-size:15px;padding:4px 0;text-align:center;outline:none;" 
                   id="ratio_${p.code}" value="${saved}" oninput="calcSellPreview()" onchange="calcSellPreview()" onkeyup="calcSellPreview()">
          </div>
          <div style="text-align:right;min-width:100px;min-height:30px;" id="sell_calc_${p.code}">
            <div style="font-family:var(--f-num);font-size:12px;font-weight:500;color:var(--t3)">-- <span style="font-size:10px;font-weight:400;font-family:var(--f-zh)">份</span></div>
            <div style="font-size:10px;color:var(--t3);font-family:var(--f-num);margin-top:2px">-- 元</div>
          </div>
        </div>
      </div>`;
  });

  htmlStr += `
        <div style="margin-top:10px;padding:10px;background:var(--bg3);border-radius:8px" id="sell_preview_result">
          <span style="font-size:12px;color:var(--t3)">填写比例后显示操作结果</span>
        </div>
      </div>
    </div>`;

  body.innerHTML = htmlStr;
  if(Object.keys(savedPlan).length) calcSellPreview();
}

function saveSellPlan() {
  const plan = {}; 
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);
  activeProducts.filter(p => p.equity > 0).forEach(p => { 
    const v = document.getElementById('ratio_' + p.code)?.value || ''; 
    if(v) plan[p.code] = v; 
  });
  localStorage.setItem('jy_sell_plan_v1', JSON.stringify(plan)); 
  alert('预案计算记录已保存（不影响持仓份额）');
}

function calcSellPreview() {
  const holdings = loadHoldings();
  const eqResult = calcCurrentEquity(holdings); 
  if(!eqResult) return;
  
  const TARGET_EQ = getDynamicTarget('sell') || 25.0;
  const {equity: currentEq, total: totalVal} = eqResult;
  const currentEqVal = totalVal * currentEq / 100;
  const targetEqVal = totalVal * TARGET_EQ / 100;
  const sellNeededEq = Math.max(0, currentEqVal - targetEqVal);

  const sellProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(p => p && p.equity > 0);
  let totalRatio = 0; 
  const ratios = {};
  
  sellProducts.forEach(p => { 
    const v = parseFloat(document.getElementById('ratio_' + p.code)?.value) || 0; 
    ratios[p.code] = v; 
    totalRatio += v; 
  });

  if(!totalRatio) {
    document.getElementById('sell_preview_result').innerHTML = '<span style="font-size:12px;color:var(--t3)">填写比例后显示操作结果</span>';
    sellProducts.forEach(p => { 
      const el2 = document.getElementById('sell_calc_' + p.code); 
      if(el2) el2.innerHTML = `<div style="font-family:var(--f-num);font-size:12px;font-weight:500;color:var(--t3)">-- <span style="font-size:10px;font-weight:400;font-family:var(--f-zh)">份</span></div><div style="font-size:10px;color:var(--t3);font-family:var(--f-num);margin-top:2px">-- 元</div>`; 
    });
    return;
  }

  let afterEqVal = currentEqVal;
  let totalCashOut = 0;
  let totalFriction = 0;

  sellProducts.forEach(p => {
    const el2 = document.getElementById('sell_calc_' + p.code);
    if(!ratios[p.code]) { 
      if(el2) el2.innerHTML = `<div style="font-family:var(--f-num);font-size:12px;font-weight:500;color:var(--t3)">-- <span style="font-size:10px;font-weight:400;font-family:var(--f-zh)">份</span></div><div style="font-size:10px;color:var(--t3);font-family:var(--f-num);margin-top:2px">-- 元</div>`; 
      return; 
    }
    
    const eqQuota = sellNeededEq * (ratios[p.code] / totalRatio);
    const sellAmt = eqQuota / p.equity;
    const nav = getNavByCode(p.code) || 1.0;
    const maxSell = (holdings[p.code] || 0) * nav;
    const actualSell = Math.min(sellAmt, maxSell);
    
    const feeAmt = actualSell * SYS_CONFIG.FEE;
    const cashOut = actualSell - feeAmt;
    const eqContribution = actualSell * p.equity;
    const eqDropPct = (eqContribution / totalVal) * 100;

    afterEqVal -= eqContribution; 
    totalCashOut += cashOut; 
    totalFriction += feeAmt;

    const el = document.getElementById('sell_calc_' + p.code);
    if(el) {
      el.innerHTML = `
        <div style="font-family:var(--f-num);font-size:13px;font-weight:600;color:var(--up)">${fmt(actualSell / nav, 2)} <span style="font-size:10px;font-weight:400;color:var(--t3);font-family:var(--f-zh)">份</span></div>
        <div style="font-size:11px;color:var(--t3);font-family:var(--f-num);margin-top:2px">${fmtMoney(actualSell)}</div>
        <div style="font-size:10px;color:#f59e0b;margin-top:2px;font-family:var(--f-zh)">降权 <span style="font-family:var(--f-num)">${eqDropPct.toFixed(2)}%</span></div>
      `;
    }
  });

  const afterEqPct = afterEqVal / totalVal * 100;
  
  document.getElementById('sell_preview_result').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px">
      <div>
        <div style="color:var(--t3);font-size:10px">操作后权益</div>
        <div style="font-family:var(--f-num);font-weight:700;font-size:16px;color:#22c55e">${afterEqPct.toFixed(2)}%</div>
      </div>
      <div>
        <div style="color:var(--t3);font-size:10px">转出到账金额</div>
        <div style="font-family:var(--f-num);font-weight:600;font-size:15px;color:var(--t1)">${fmtMoney(totalCashOut)}</div>
      </div>
      <div>
        <div style="color:var(--t3);font-size:10px">摩擦总计</div>
        <div style="font-family:var(--f-num);font-weight:600;font-size:15px;color:#f87171">${fmtMoney(totalFriction)}</div>
      </div>
    </div>`;
}

// ==========================================
// 8. 抽屉与事件绑定
// ==========================================
function openDrawer(id) { 
  document.getElementById('drawerMask').classList.add('open'); 
  document.getElementById(id).classList.add('open'); 
}

function closeAllDrawers() { 
  document.getElementById('drawerMask').classList.remove('open'); 
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('open')); 
}

// 初始化启动
updateClock();
setInterval(updateClock, 1000);
updatePeBar();
refreshData();

// 挂载轮询
setInterval(() => { if(!document.hidden) fetchIndices(); }, SYS_CONFIG.REFRESH_IDX);
setInterval(() => { if(!document.hidden) refreshData(); }, SYS_CONFIG.REFRESH_API);

// 挂载页面可见性事件
document.addEventListener('visibilitychange', () => { 
  if(!document.hidden) { 
    fetchIndices(); 
    refreshData(); 
  } 
});