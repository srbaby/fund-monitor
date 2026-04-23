// ==========================================
// Jany 基金看板 - UI 模板与视图渲染层
// 职责：隔离所有庞大的 HTML 字符串拼接，纯粹的 View 层
// ==========================================

// --- 基础格式化小工具 ---
function fp(v) { 
  if(v == null) return {cls: 'flat', txt: '--'}; 
  return {cls: v > 0 ? 'up' : v < 0 ? 'down' : 'flat', txt: (v > 0 ? '+' : '') + v.toFixed(2) + '%'}; 
}

function inlinePctHtml(ep, op, stale, ef, of2) { 
  const staleCls = stale ? ' stale-text' : '';
  const opCls = stale ? 'flat' : op.cls; 
  if(miniMode === 0) return `<span class="inline-pct ${ep.cls} ${ef}">${ep.txt}</span>`; 
  if(miniMode === 1) return `<span class="inline-pct ${opCls} ${of2}${staleCls}">${op.txt}</span>`; 
  return `<span class="inline-pct"><span class="${ep.cls} ${ef}">${ep.txt}</span><span style="color:var(--t3);margin:0 3px">|</span><span class="${opCls} ${of2}${staleCls}">${op.txt}</span></span>`; 
}

// ==========================================
// 1. 核心视图渲染 (局部原子更新, 消灭闪烁)
// ==========================================
function buildCardInnerHtml(f, fl, today, tradingDay) {
  if (f.error) return `<div class="card-top"><span class="drag-handle">⠿</span><div class="card-info"><div class="card-name-box"><div class="card-name" style="color:var(--t3)">${NAMES[f.code] || f.code}</div><div class="card-code">${f.code}</div></div></div><div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div></div><div style="padding:10px 16px 14px;font-size:12px;color:var(--t3);border-top:1px solid var(--bd)">⚠ 获取超时，请刷新</div>`;

  const ep = fp(f.estPct), op = fp(f.offPct);
  const {ef, of2} = (fl || {})[f.code] || {ef: '', of2: ''};
  const isStale = (f.estTime && f.estTime.slice(0, 10) === today || tradingDay) && (!f.offDate || f.offDate.slice(0, 10) < today);

  return `
    <div class="card-top">
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
  const currentCodes = Array.from(container.children).filter(c => c.dataset && c.dataset.code).map(c => c.dataset.code);
  const targetCodes = results.map(r => r.code);
  
  // 判断是否需要全局重绘 (列表为空、顺序改变、增删基金)
  const isStructureSame = currentCodes.length > 0 && currentCodes.join(',') === targetCodes.join(',');

  if (!isStructureSame) {
    container.innerHTML = results.map(f => {
      const cc = (f.estPct != null && !f.error) ? (f.estPct > 0 ? 'up-card' : f.estPct < 0 ? 'down-card' : '') : '';
      return `<div class="fund-card ${cc}${allCollapsed ? ' collapsed' : ''}" data-code="${f.code}">${buildCardInnerHtml(f, fl, today, tradingDay)}</div>`;
    }).join('') || `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无关注基金</div></div>`;
    return;
  }

  // 高性能原子更新：仅更新内部数据，绝不打断 Sortable.js 拖拽
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
  if(f.error) return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name" style="color:var(--t3)">${NAMES[f.code] || f.code}</div><div class="tbl-code">${f.code}</div></div></td><td colspan="2" style="color:var(--t3);font-size:12px">⚠ 获取超时</td><td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;
  
  const ep = fp(f.estPct), op = fp(f.offPct);
  const {ef, of2} = (fl || {})[f.code] || {ef: '', of2: ''};
  const tblStale = (f.estTime && f.estTime.slice(0,10) === today || tradingDay) && (!f.offDate || f.offDate.slice(0,10) < today);
  
  return `
    <td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name">${f.name}</div><div class="tbl-code">${f.code}</div></div></td>
    <td><div class="tbl-pct ${ep.cls} ${ef}">${ep.txt}</div><div class="tbl-nav">净值 <span class="nv">${f.estVal || '--'}</span></div><div class="tbl-time">${f.estTime || '--'}</div></td>
    <td style="${tblStale ? 'opacity:0.35;filter:grayscale(1)' : ''}"><div class="tbl-pct ${op.cls} ${of2}">${op.txt}</div><div class="tbl-nav">净值 <span class="nv">${f.offVal || '--'}</span></div><div class="tbl-time">${f.offDate || '--'}</div></td>
    <td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;
}

function renderTable(results, fl, today, tradingDay) {
  const container = document.getElementById('fundTbody');
  const currentCodes = Array.from(container.children).filter(c => c.dataset && c.dataset.code).map(c => c.dataset.code);
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

// ==========================================
// 2. 持仓编辑抽屉
// ==========================================
function openHoldingDrawer() {
  const holdings = loadHoldings();
  const eqData = calcCurrentEquity(holdings);
  const currentPE = getCurrentPE();
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);

  let targetEq = null;
  if (currentPE?.rawData?.bucketStr) {
    const lo = parseFloat(currentPE.rawData.bucketStr.split(',')[0]); 
    targetEq = PE_EQUITY_TABLE.find(x => lo >= x.lo && lo < x.hi)?.target;
  }

  const diff = (eqData && targetEq != null) ? eqData.equity - targetEq : null;
  const wrongDir = diff != null && currentPE ? ((currentPE.value >= 65 && diff > 2) || (currentPE.value < 65 && diff < -2)) : false;
  const diffCol = diff == null ? 'var(--t3)' : wrongDir ? '#f87171' : (diff > 0 ? '#f59e0b' : '#60a5fa');

  let htmlStr = `
    <div style="background:var(--bg3);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid var(--bd)">
      <div style="font-size:11px;color:var(--t3);margin-bottom:8px;font-weight:500">📊 权益校对汇总</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><div style="font-size:10px;color:var(--t3)">总市值</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600">${eqData ? fmtMoney(eqData.total) : '--'}</div></div>
        <div><div style="font-size:10px;color:var(--t3)">实际权益</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:${diffCol}">${eqData ? eqData.equity.toFixed(2) + '%' : '--'}</div></div>
        <div><div style="font-size:10px;color:var(--t3)">目标权益</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:var(--accent)">${targetEq != null ? targetEq + '%' : '输入PE'}</div></div>
      </div>
      ${diff != null ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);font-size:11px">偏离：<span style="font-family:var(--f-num);font-weight:600;color:${diffCol}">${diff > 0 ? '+' : ''}${diff.toFixed(2)}%</span>${wrongDir ? '<span style="color:#f87171;margin-left:6px">⚠️ 方向警告</span>' : ''}</div>` : ''}
    </div>
    <div style="background:var(--bg3);border-radius:10px;overflow:hidden;margin-bottom:14px;border:1px solid var(--bd)">`;

  activeProducts.forEach(p => {
    const shares = holdings[p.code] || 0;
    const nav = getNavByCode(p.code);
    const val = nav ? shares * nav : 0;
    htmlStr += `
      <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--bd);font-size:12px">
        <div><div style="font-weight:500">${p.name}</div><div style="font-size:10px;color:var(--t3);white-space:nowrap;"><span style="font-family:var(--f-num)">${shares.toFixed(2)}</span> 份 × <span style="font-family:var(--f-num)">${nav ? nav.toFixed(4) : '--'}</span></div></div>
        <div style="text-align:right;font-family:var(--f-num);color:var(--t2)">${val ? fmtMoney(val) : '--'}</div>
        <div style="text-align:right;font-size:10px;color:var(--t3)">×<span style="font-family:var(--f-num)">${Math.round(p.equity * 100)}%</span></div>
        <div style="text-align:right;font-family:var(--f-num);font-weight:500;color:var(--accent)">${val ? fmtMoney(val * p.equity) : '--'}</div>
      </div>`;
  });

  htmlStr += `</div>`;

  activeProducts.forEach(p => {
    htmlStr += `<div class="holding-row"><div class="holding-name"><div style="font-size:13px;font-weight:500">${getProductName(p.code)}</div><div style="font-size:11px;color:var(--t3)">${p.code}·权益<span style="font-family:var(--f-num)">${Math.round(p.equity * 100)}%</span></div></div><input class="holding-input" id="hi_${p.code}" type="number" step="0.01" style="font-size:16px" value="${(holdings[p.code] || 0).toFixed(2)}" placeholder="0"><span class="holding-unit">份</span></div>`;
  });

  htmlStr += `<div style="margin-top:16px;display:flex;gap:8px"><button onclick="exportToken()" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--bd2);background:transparent;color:var(--t2);font-size:12px;cursor:pointer">🔑 生成备份口令</button><button onclick="importToken()" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--bd2);background:transparent;color:var(--t2);font-size:12px;cursor:pointer">📥 口令恢复</button></div>`;

  document.getElementById('holdingDrawerBody').innerHTML = htmlStr;
  openDrawer('holdingDrawer');
}

// ==========================================
// 3. 量化预案抽屉
// ==========================================
function renderPlanDrawer() {
  const currentPE = getCurrentPE();
  const holdings = loadHoldings();
  const peVal = currentPE ? currentPE.value : null;
  const buyData = calcBuyPlanDraft(holdings);
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(Boolean);
  const savedPlan = JSON.parse(localStorage.getItem(STORE_SELL_PLAN) || '{}');

  if (!buyData) return;

  let htmlStr = `
    <div style="background:var(--bg3);border-radius:10px;padding:10px 12px;margin-bottom:16px;border:1px solid var(--bd);font-size:12px;color:var(--t2)">
      当前PE <b style="color:var(--t1);font-family:var(--f-num)">${peVal ? peVal.toFixed(2) + '%' : '--'}</b>
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
        <div style="padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(240,68,68,0.3);display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:14px;font-weight:600;">卖出份数</div>
          <div style="font-family:var(--f-num);font-size:15px;font-weight:700;color:var(--up)">${fmt(buyData.sellXqShares, 2)} 份</div>
        </div>
        <div style="font-size:11px;color:var(--t3);margin:16px 0 8px 0;">目标分配 (优先A500C，溢出至中证500C)</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(59,130,246,0.3);display:flex;justify-content:space-between;align-items:center;">
            <div><div style="font-size:14px;font-weight:600;">买入 A500C</div><div style="font-size:10px;color:var(--t3)">~${fmt(buyData.allocA500C / buyData.a500cNav, 2)} 份</div></div>
            <div style="font-family:var(--f-num);font-size:15px;font-weight:700;color:#60a5fa">${fmtMoney(buyData.allocA500C)}</div>
          </div>
          ${buyData.allocZZ500C > 1 ? `<div style="padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(59,130,246,0.3);display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:14px;font-weight:600;">买入 中证500C</div><div style="font-size:10px;color:var(--t3)">~${fmt(buyData.allocZZ500C / buyData.zz500cNav, 2)} 份</div></div><div style="font-family:var(--f-num);font-size:15px;font-weight:700;color:#60a5fa">${fmtMoney(buyData.allocZZ500C)}</div></div>` : ''}
        </div>
      </div>
    </div>

    <div>
      <div style="display:flex;align-items:center;margin-bottom:10px"><span style="font-size:11px;font-weight:600;color:#f59e0b;background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);border-radius:6px;padding:2px 8px">▼ 降权预案评估</span></div>
      <div style="background:rgba(240,68,68,0.04);border:1px solid rgba(240,68,68,0.12);border-radius:10px;padding:12px">
        <div id="sell_summary_area"></div>
        <div style="font-size:11px;color:var(--t3);margin-bottom:10px">配置减仓比例（空=不参与），摩擦费率 ${SYS_CONFIG.FEE * 100}%</div>`;

  activeProducts.filter(p => p.equity > 0).forEach(p => {
    const isPri = window._prioritySellCode === p.code;
    htmlStr += `
      <div style="padding:10px 12px;background:var(--bg3);border-radius:10px;margin-bottom:8px;border:1px solid var(--bd);display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;"><div style="font-size:14px;font-weight:600;">${getProductName(p.code)}</div><div id="sell_calc_shares_${p.code}" style="font-family:var(--f-num);font-weight:600;color:var(--t3)">-- 份</div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;"><div style="font-size:10px;color:var(--t3)">持仓: ${(holdings[p.code] || 0).toFixed(2)} 份</div><div id="sell_calc_fiat_${p.code}" style="font-size:11px;color:var(--t3)">-- 元</div></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
          <button class="pri-btn" data-code="${p.code}" onclick="togglePrioritySell('${p.code}')" style="font-size:11px; height:24px; width:72px; border-radius:6px; border:1px solid ${isPri ? '#f59e0b' : 'var(--bd2)'}; background:${isPri ? 'rgba(245,158,11,0.1)' : 'transparent'}; color:${isPri ? '#f59e0b' : 'var(--t3)'}; cursor:pointer;">${isPri ? '★ 优先' : '☆ 优先'}</button>
          <div style="display:flex;align-items:center;gap:6px;"><span style="font-size:11px;color:var(--t3);">减仓权重</span><input type="tel" style="width:52px; height:24px; background:var(--bg); border:1px solid var(--bd2); border-radius:6px; color:var(--t1); text-align:center;" id="ratio_${p.code}" value="${savedPlan[p.code] || ''}" oninput="calcSellPreview()"></div>
        </div>
      </div>`;
  });

  htmlStr += `<div style="margin-top:10px;padding:10px;background:var(--bg3);border-radius:8px" id="sell_preview_result"><span style="font-size:12px;color:var(--t3)">等待输入比例...</span></div></div></div>`;

  document.getElementById('planDrawerBody').innerHTML = htmlStr;
  calcSellPreview();
}

// ==========================================
// 4. 降权实时计算预览 (UI 触发器)
// ==========================================
function calcSellPreview() {
  const holdings = loadHoldings();
  const ratios = {};
  const activeProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(p => p && p.equity > 0);
  
  activeProducts.forEach(p => { ratios[p.code] = parseFloat(document.getElementById('ratio_' + p.code)?.value) || 0; });
  
  const draft = calcSellExecutionDraft(holdings, ratios, window._prioritySellCode);

  const summaryEl = document.getElementById('sell_summary_area');
  if (summaryEl && !draft.error) {
    summaryEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
        <div><div style="font-size:10px;color:var(--t3)">当前权益</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600">${draft.currentEq.toFixed(2)}%</div></div>
        <div><div style="font-size:10px;color:var(--t3)">触发后目标</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#f87171">${draft.targetEq}%</div></div>
        <div><div style="font-size:10px;color:var(--t3)">需减比例</div><div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#f59e0b">${draft.diffEqPct.toFixed(2)}%</div></div>
      </div>`;
  }

  activeProducts.forEach(p => {
    const res = draft.results ? draft.results[p.code] : null;
    const elShares = document.getElementById('sell_calc_shares_' + p.code);
    const elFiat = document.getElementById('sell_calc_fiat_' + p.code);
    
    if (res && res.amt > 0) {
      elShares.innerHTML = `<span style="color:var(--up)">${fmt(res.shares, 2)}</span> 份`;
      elFiat.innerHTML = `<span style="color:var(--t2)">${fmtMoney(res.amt)}</span> <span style="color:#f59e0b;font-size:10px;margin-left:4px;">降权 ${res.eqDropPct.toFixed(2)}%</span>`;
    } else {
      elShares.innerHTML = `-- 份`; elFiat.innerHTML = `-- 元`;
    }
  });

  const resultEl = document.getElementById('sell_preview_result');
  if (draft.hasAnySell) {
    resultEl.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:12px">
        <div><div style="color:var(--t3);font-size:10px">操作后权益</div><div style="font-family:var(--f-num);font-weight:700;font-size:16px;color:#22c55e">${draft.afterEqPct.toFixed(2)}%</div></div>
        <div><div style="color:var(--t3);font-size:10px">转出到账</div><div style="font-family:var(--f-num);font-weight:600;font-size:15px;">${fmtMoney(draft.totalCashOut)}</div></div>
        <div><div style="color:var(--t3);font-size:10px">总摩擦</div><div style="font-family:var(--f-num);font-weight:600;font-size:15px;color:#f87171">${fmtMoney(draft.totalFriction)}</div></div>
      </div>`;
  } else {
    resultEl.innerHTML = `<span style="font-size:12px;color:var(--t3)">请填写比例或设为优先卖出</span>`;
  }
}