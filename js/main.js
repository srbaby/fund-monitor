// ==========================================
// 1. 全局 UI 状态
// ==========================================
let _mktOpen = null;
let idxPrev = {};
const prevData = {};
let allCollapsed = false;
let miniMode = 0;
const miniLabels = ['估算', '官方', '全部'];
let cardSortable = null, tblSortable = null;
let _planMode = 'neutral';
let _isFetchingData = false;
window._prioritySellCode = null;

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
// 3. UI 交互控制调度
// ==========================================
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

function renderAll(results) {
  _lastResults = results;
  updatePeBar();
  const fl = calcFlash(results);
  const today = todayDateStr();
  const mktState = getMarketState();
  const tradingDay = (mktState !== 'WEEKEND' && mktState !== 'BEFORE_PRE');
  
  const resultMap = new Map(results.map(r => [r.code, r]));
  const uiResults = funds.map(code => resultMap.get(code)).filter(Boolean);
  
  renderCards(uiResults, fl, today, tradingDay);
  renderTable(uiResults, fl, today, tradingDay);
  renderTodayProfit(uiResults, mktState, today);
  
  document.getElementById('cardHeaderBar').style.display = uiResults.length ? 'flex' : 'none';
}

function renderTodayProfit(results, mktState, todayStr) {
  const profitEl = document.getElementById('todayProfit'); 
  if (!profitEl) return;

  const holdings = loadHoldings();
  let totalProfit = 0, totalYestVal = 0, allUpdated = true, hasHoldings = false;
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

    const nav = isOfficialUpdated ? parseFloat(f.offVal) : parseFloat(f.estVal);
    const pct = isOfficialUpdated ? parseFloat(f.offPct) : parseFloat(f.estPct);
    
    if (!isNaN(nav) && !isNaN(pct)) { 
      const yestNav = nav / (1 + pct / 100); 
      const yestVal = shares * yestNav;
      
      totalYestVal += yestVal;
      totalProfit += yestVal * (pct / 100); 
      
      if (!isOfficialUpdated && estD !== todayStr && (mktState === 'PRE_MARKET' || mktState === 'TRADING')) {
        isWaitingForOpen = true; 
      }
    }
  });

  if (isWaitingForOpen) {
    profitEl.innerHTML = `<span style="color:var(--t3)">-</span>`;
  } else if (hasHoldings) {
    const sign = totalProfit > 0 ? '+' : '';
    const cls = totalProfit > 0 ? 'up' : totalProfit < 0 ? 'down' : 'flat';
    
    let rightBlock = '';
    if (allUpdated || totalYestVal > 0) {
        const pctVal = totalYestVal > 0 ? (totalProfit / totalYestVal) * 100 : null;
        const pctText = pctVal !== null ? `(${sign}${pctVal.toFixed(2)}%)` : '';
        
        if (allUpdated) {
            // 【UI专业升级】：上下折叠排布策略，绝对释放横向空间
            rightBlock = `
            <span style="display:inline-flex; flex-direction:column; justify-content:center; align-items:flex-start; margin-left:6px;">
                <span style="font-size:9px; color:#d97706; font-weight:500; font-family:var(--f-zh); line-height:1.2; margin-bottom:1px;">已更新</span>
                <span style="font-size:11px; font-weight:600; line-height:1.2; color:var(--t2);">${pctText}</span>
            </span>`;
        } else {
            // 盘中保持中心轴对齐，简单干净
            rightBlock = `<span style="font-size:13px; font-weight:600; margin-left:6px;">${pctText}</span>`;
        }
    }
    
    profitEl.innerHTML = `<span class="${cls}" style="display:flex; align-items:center;">${sign}${totalProfit.toFixed(2)}</span>${rightBlock}`;
  } else {
    profitEl.innerHTML = '';
  }
}

// ==========================================
// 4. 用户行为与列表控制
// ==========================================
async function refreshData() {
  if (_isFetchingData) return;
  _isFetchingData = true;

  const miniRefBtn = document.getElementById('miniRefBtn');
  if(miniRefBtn) { miniRefBtn.textContent = '↻'; miniRefBtn.disabled = true; }
  
  try {
    loadFunds(); 
    fetchIndices();
    
    if(!funds.length) {
      document.getElementById('cardView').innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无关注基金，输入代码添加</div></div>`;
      document.getElementById('fundTbody').innerHTML = `<tr><td colspan="4" style="text-align:center;padding:50px;color:var(--t3)">暂无关注基金</td></tr>`;
      return;
    }
    
    // 【优化：只请求必要数据】
    const coreCodes = new Set(funds);

    // 仅补充“引擎必须但未在关注列表”的品种
    PRODUCTS.forEach(p => {
        if (p.equity > 0 && !coreCodes.has(p.code)) {
            coreCodes.add(p.code);
        }
    });

    const results = await Promise.all([...coreCodes].map(fetchSingleFund));
    
    renderAll(results);
    
    if(cardSortable) cardSortable.destroy();
    if(tblSortable) tblSortable.destroy();
    
    const onEnd = evt => { 
      const o = Array.from(evt.to.children).map(el => el.dataset.code).filter(Boolean); 
      if(o.length === funds.length) { funds = o; saveFunds(); }
    };
    
    cardSortable = Sortable.create(document.getElementById('cardView'), {handle: '.drag-handle', animation: 200, ghostClass: 'sortable-ghost', onEnd});
    tblSortable = Sortable.create(document.getElementById('fundTbody'), {handle: '.tbl-drag', animation: 200, ghostClass: 'sortable-ghost', onEnd});
  } finally {
    _isFetchingData = false;
    if(miniRefBtn) { miniRefBtn.textContent = '↻ 刷新'; miniRefBtn.disabled = false; }
  }
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
    planBtn.className = 'pe-plan-btn neutral'; planBtn.textContent = '预案';
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

  // 修改：按钮文字收窄，以匹配定锚和持仓按钮大小
  if(v <= bounds.buyPct) { 
    display.className = 'pe-value pe-danger-dn'; 
    status.textContent = '▲ 增权信号'; 
    status.className = 'pe-status triggered-buy'; 
    planBtn.className = 'pe-plan-btn buy'; 
    planBtn.textContent = '增权'; 
    if(marker) marker.style.background = '#3b82f6'; 
  } else if(v >= bounds.sellPct) { 
    display.className = 'pe-value pe-danger-up'; 
    status.textContent = '▼ 降权信号'; 
    status.className = 'pe-status triggered-sell'; 
    planBtn.className = 'pe-plan-btn sell'; 
    planBtn.textContent = '降权'; 
    if(marker) marker.style.background = '#f59e0b'; 
  } else { 
    display.className = 'pe-value pe-normal'; 
    status.textContent = '待机'; 
    status.className = 'pe-status normal'; 
    planBtn.className = 'pe-plan-btn neutral'; 
    planBtn.textContent = '预案'; 
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
// 6. 数据存储管理交互
// ==========================================
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

function saveSellPlan() {
  const plan = {}; 
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);
  activeProducts.filter(p => p.equity > 0).forEach(p => { 
    const v = document.getElementById('ratio_' + p.code)?.value || ''; 
    if(v) plan[p.code] = v; 
  });
  localStorage.setItem('jy_sell_plan_v1', JSON.stringify(plan)); 
}

function saveAndClosePlan() {
  saveSellPlan();
  closeAllDrawers();
}

function togglePrioritySell(code) {
  if (window._prioritySellCode === code) {
    window._prioritySellCode = null;
  } else {
    window._prioritySellCode = code;
  }

  // ✅ 持久化
  if (window._prioritySellCode) {
    localStorage.setItem('jy_priority_sell_v1', window._prioritySellCode);
  } else {
    localStorage.removeItem('jy_priority_sell_v1');
  }

  document.querySelectorAll('.pri-btn').forEach(btn => {
    const isPri = btn.dataset.code === window._prioritySellCode;
    btn.innerHTML = isPri ? '★ 优先' : '☆ 设为优先';
    btn.style.color = isPri ? '#f59e0b' : 'var(--t3)';
    btn.style.borderColor = isPri ? '#f59e0b' : 'var(--bd2)';
    btn.style.background = isPri ? 'rgba(245,158,11,0.1)' : 'transparent';
  });

  if(typeof calcSellPreview === 'function') calcSellPreview();
}

function openPlanDrawer() {
  const currentPE = getCurrentPE();
  if(!currentPE) { alert('请先定锚！'); openPeModal(); return; }
  
  window._prioritySellCode = localStorage.getItem('jy_priority_sell_v1');
  _planMode = currentPE.value <= currentPE.bounds.buyPct ? 'buy' : (currentPE.value >= currentPE.bounds.sellPct ? 'sell' : 'neutral');
  renderPlanDrawer(); 
  openDrawer('planDrawer');
}

// ==========================================
// 7. 抽屉控制与初始化
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
