// Jany 基金看板 - 基金数据模块
// 职责：基金数据拉取、卡片/表格渲染、增删排序、今日盈亏、闪烁追踪

// ---- 网络层 ----
window.jsonpResolvers = {};
window.jsonpgz = function(data) {
  if (data?.fundcode && window.jsonpResolvers[data.fundcode]) {
    window.jsonpResolvers[data.fundcode](data);
    delete window.jsonpResolvers[data.fundcode];
  }
};

function fetchEst(code) {
  return new Promise(resolve => {
    let done = false;
    const s = document.createElement('script');
    const fin = v => { if (!done) { done = true; delete window.jsonpResolvers[code]; s.remove(); resolve(v); } };
    window.jsonpResolvers[code] = fin;
    s.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    s.onerror = () => fin(null);
    setTimeout(() => fin(null), 3000);
    document.head.appendChild(s);
  });
}

const offCache = {};
const offQ = [];
let offBusy = false;

function fetchOff(code) {
  const now = new Date();
  const nowTs = now.getTime();
  const h = now.getHours(), m = now.getMinutes(), day = now.getDay();
  const timeNum = h * 60 + m;
  const todayStr = todayDateStr();
  const cached = offCache[code];

  if (cached) {
    const isTodayData = cached.data?.date === todayStr;
    let ttl = isTodayData ? 12 * 3600000
      : (day === 0 || day === 6) ? 12 * 3600000
      : timeNum >= 19 * 60 + 30 ? 5 * 60000
      : 3600000;
    if (nowTs - cached.ts < ttl) return Promise.resolve(cached.data);
  }

  return new Promise(r => {
    const resolve = val => { if (val) offCache[code] = {ts: Date.now(), data: val}; r(val); };
    offQ.push({code, resolve});
    drainOff();
  });
}

function drainOff() {
  if (offBusy || !offQ.length) return;
  offBusy = true;
  const {code, resolve} = offQ.shift();
  let done = false;
  const s = document.createElement('script');
  const fin = v => { if (!done) { done = true; window.apidata = undefined; s.remove(); resolve(v); offBusy = false; setTimeout(drainOff, 30); } };

  s.src = `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=1&v=${Date.now()}`;
  s.onload = () => {
    try {
      const html = window.apidata?.content;
      if (html) {
        const tr = html.match(/<tbody>\s*<tr>(.*?)<\/tr>/i);
        if (tr) {
          const tds = tr[1].match(/<td[^>]*>(.*?)<\/td>/g).map(td => td.replace(/<[^>]+>/g, '').trim());
          if (tds.length >= 4) {
            const date = tds[0], nav = tds[1];
            const pct = (tds[3] && tds[3] !== '---') ? parseFloat(tds[3].replace('%', '')) : null;
            fin({nav: Number(nav).toFixed(4), pct: pct != null ? pct.toFixed(2) : null, date});
            return;
          }
        }
      }
      fin(null);
    } catch(e) { fin(null); }
  };
  s.onerror = () => fin(null);
  setTimeout(() => fin(null), 3000);
  document.head.appendChild(s);
}

async function fetchSingleFund(code) {
  const [est, off] = await Promise.all([fetchEst(code), fetchOff(code)]);
  if (!est && !off) return {code, error: true};
  return {
    code, error: false,
    name: est?.name || NAMES[code] || `基金 ${code}`,
    estPct: est?.gszzl != null && est.gszzl !== '' ? parseFloat(est.gszzl) : null,
    estVal: est?.gsz || null,
    estTime: est?.gztime || null,
    offPct: off?.pct != null ? parseFloat(off.pct) : null,
    offVal: off?.nav || est?.dwjz || null,
    offDate: off?.date || est?.jzrq || null
  };
}

// ---- 净值取用（供 pe.js / plan.js 复用）----
function getNavByCode(code) {
  const f = _lastResults.find(r => r.code === code);
  if (!f) return null;
  const offD = f.offDate ? f.offDate.slice(0, 10) : '';
  const estD = f.estTime ? f.estTime.slice(0, 10) : '';
  if (f.offVal && (!estD || offD >= estD)) return parseFloat(f.offVal);
  if (f.estVal) return parseFloat(f.estVal);
  return null;
}

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

// ---- 闪烁追踪 ----
const prevData = {};
function calcFlash(results) {
  const fl = {};
  results.forEach(f => {
    if (f.error) { fl[f.code] = {ef: '', of2: ''}; return; }
    const pr = prevData[f.code];
    fl[f.code] = {
      ef: pr && pr.estPct !== f.estPct && f.estPct != null ? (f.estPct > (pr.estPct || 0) ? 'flash-up' : 'flash-down') : '',
      of2: pr && pr.offPct !== f.offPct && f.offPct != null ? (f.offPct > (pr.offPct || 0) ? 'flash-up' : 'flash-down') : ''
    };
    prevData[f.code] = {estPct: f.estPct, offPct: f.offPct};
  });
  return fl;
}

// ---- 今日盈亏 ----
function renderTodayProfit(results, mktState, todayStr) {
  const profitEl = document.getElementById('todayProfit');
  if (!profitEl) return;

  const holdings = loadHoldings();
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
    let isOfficialUpdated = offD === todayStr
      || mktState === 'WEEKEND' || mktState === 'BEFORE_PRE'
      || (estD && offD && offD >= estD);

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

// ---- 卡片渲染 ----
let allCollapsed = false;
let miniMode = 0;
const miniLabels = ['估算', '官方', '全部'];
let cardSortable = null, tblSortable = null;

function inlinePctHtml(ep, op, stale, ef, of2) {
  const staleCls = stale ? ' stale-text' : '';
  const opCls = stale ? 'flat' : op.cls;
  if (miniMode === 0) return `<span class="inline-pct ${ep.cls} ${ef}">${ep.txt}</span>`;
  if (miniMode === 1) return `<span class="inline-pct ${opCls} ${of2}${staleCls}">${op.txt}</span>`;
  return `<span class="inline-pct"><span class="${ep.cls} ${ef}">${ep.txt}</span><span style="color:var(--t3);margin:0 3px">|</span><span class="${opCls} ${of2}${staleCls}">${op.txt}</span></span>`;
}

function buildCardInnerHtml(f, fl, today, tradingDay) {
  if (f.error) return `<div class="card-top"><span class="drag-handle">⠿</span><div class="card-info"><div class="card-name-box"><div class="card-name" style="color:var(--t3)">${f.name || NAMES[f.code] || f.code}</div><div class="card-code">${f.code}</div></div></div><div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div></div><div style="padding:10px 16px 14px;font-size:12px;color:var(--t3);border-top:1px solid var(--bd)">⚠ 获取超时，请刷新</div>`;

  const ep = fp(f.estPct), op = fp(f.offPct);
  const {ef, of2} = (fl || {})[f.code] || {ef: '', of2: ''};
  const isStale = (f.estTime && f.estTime.slice(0, 10) === today || tradingDay) && (!f.offDate || f.offDate.slice(0, 10) < today);

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
  const container = document.getElementById('cardView');
  const currentCodes = Array.from(container.children).filter(c => c.dataset?.code).map(c => c.dataset.code);
  const targetCodes = results.map(r => r.code);
  const isStructureSame = currentCodes.length > 0 && currentCodes.join(',') === targetCodes.join(',');

  if (!isStructureSame) {
    container.innerHTML = results.map(f => {
      const cc = (f.estPct != null && !f.error) ? (f.estPct > 0 ? 'up-card' : f.estPct < 0 ? 'down-card' : '') : '';
      return `<div class="fund-card ${cc}${allCollapsed ? ' collapsed' : ''}" data-code="${f.code}">${buildCardInnerHtml(f, fl, today, tradingDay)}</div>`;
    }).join('') || `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无关注基金</div></div>`;
    return;
  }

  results.forEach(f => {
    const el = container.querySelector(`[data-code="${f.code}"]`);
    if (el) {
      const cc = (f.estPct != null && !f.error) ? (f.estPct > 0 ? 'up-card' : f.estPct < 0 ? 'down-card' : '') : '';
      el.className = `fund-card ${cc}${allCollapsed ? ' collapsed' : ''}`;
      el.innerHTML = buildCardInnerHtml(f, fl, today, tradingDay);
    }
  });
}

function buildTableInnerHtml(f, fl, today, tradingDay) {
  if (f.error) return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name" style="color:var(--t3)">${NAMES[f.code] || f.code}</div><div class="tbl-code">${f.code}</div></div></td><td colspan="2" style="color:var(--t3);font-size:12px">⚠ 获取超时</td><td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;

  const ep = fp(f.estPct), op = fp(f.offPct);
  const {ef, of2} = (fl || {})[f.code] || {ef: '', of2: ''};
  const tblStale = (f.estTime && f.estTime.slice(0,10) === today || tradingDay) && (!f.offDate || f.offDate.slice(0,10) < today);

  return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name">${f.name}</div><div class="tbl-code">${f.code}</div></div></td>
    <td><div class="tbl-pct ${ep.cls} ${ef}">${ep.txt}</div><div class="tbl-nav">净值 <span class="nv">${f.estVal || '--'}</span></div><div class="tbl-time">${f.estTime || '--'}</div></td>
    <td style="${tblStale ? 'opacity:0.35;filter:grayscale(1)' : ''}"><div class="tbl-pct ${op.cls} ${of2}">${op.txt}</div><div class="tbl-nav">净值 <span class="nv">${f.offVal || '--'}</span></div><div class="tbl-time">${f.offDate || '--'}</div></td>
    <td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;
}

function renderTable(results, fl, today, tradingDay) {
  const container = document.getElementById('fundTbody');
  const currentCodes = Array.from(container.children).filter(c => c.dataset?.code).map(c => c.dataset.code);
  const targetCodes = results.map(r => r.code);
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

// ---- 渲染总调度 ----
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

// ---- 增删交互 ----
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

function toggleAllCollapse() {
  allCollapsed = !allCollapsed;
  document.getElementById('colBtn').textContent = allCollapsed ? '展开' : '收窄';
  document.getElementById('cycleBtn').style.display = allCollapsed ? '' : 'none';
  document.body.classList.toggle('collapsed-mode', allCollapsed);
  if (_lastResults.length) renderAll(_lastResults);
}
function cycleMiniMode() {
  miniMode = (miniMode + 1) % 3;
  document.getElementById('cycleBtn').textContent = miniLabels[miniMode];
  if (_lastResults.length) renderAll(_lastResults);
}