// ==========================================
// Jany 基金看板 - UI 模板与视图渲染层
// 职责：隔离所有庞大的 HTML 字符串拼接
// ==========================================

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
          <div style="display:flex;flex-direction:column;gap:4px;padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(240,68,68,0.3)">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="font-size:14px;font-weight:600;color:var(--t1)">卖出 兴全中长债</div>
              <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:var(--up)">${buyAmt != null ? fmtMoney(buyAmt) : '--'}</div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="font-size:11px;color:var(--t3)">当前持仓 <span style="font-family:var(--f-num)">${holdings[SYS_CONFIG.CODE_XQ] ? fmt(holdings[SYS_CONFIG.CODE_XQ], 2) : '0.00'}</span> 份</div>
              <div style="font-size:11px;color:var(--t3);font-family:var(--f-num);">~${sellXqShares != null ? fmt(sellXqShares, 2) : '--'} <span style="font-family:var(--f-zh)">份</span></div>
            </div>
          </div>
        </div>

        <div style="font-size:11px;color:var(--t3);margin: 16px 0 8px 0;">目标分配 (优先A500C，单品上限${Math.round(SYS_CONFIG.LIMIT_A500C * 100)}%)</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;flex-direction:column;gap:4px;padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid ${allocA500C > 0 ? 'rgba(59,130,246,0.3)' : 'var(--bd)'}">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="font-size:14px;font-weight:600;color:var(--t1)">买入 A500C</div>
              <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#60a5fa">${allocA500C != null ? fmtMoney(allocA500C) : '--'}</div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="font-size:11px;color:var(--t3)">当前占比 <span style="font-family:var(--f-num)">${totalVal ? ((currA500CVal / totalVal) * 100).toFixed(2) : '0.00'}%</span></div>
              <div style="font-size:11px;color:var(--t3);font-family:var(--f-num);">~${allocA500C != null ? fmt(allocA500C / a500cNav, 2) : '--'} <span style="font-family:var(--f-zh)">份</span></div>
            </div>
          </div>
          
          ${allocZZ500C > 0 ? `
          <div style="display:flex;flex-direction:column;gap:4px;padding:10px 12px;background:var(--bg3);border-radius:8px;border:1px solid rgba(59,130,246,0.3)">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="font-size:14px;font-weight:600;color:var(--t1)">买入 中证500C</div>
              <div style="font-family:var(--f-num);font-size:15px;font-weight:600;color:#60a5fa">${fmtMoney(allocZZ500C)}</div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="font-size:11px;color:var(--t3)">超额溢出部分</div>
              <div style="font-size:11px;color:var(--t3);font-family:var(--f-num);">~${fmt(allocZZ500C / zz500cNav, 2)} <span style="font-family:var(--f-zh)">份</span></div>
            </div>
          </div>` : ''}
        </div>
      </div>
    </div>

    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-size:11px;font-weight:600;color:#f59e0b;background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);border-radius:6px;padding:2px 8px">▼ 降权预案评估</span>
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
    const isPri = window._prioritySellCode === p.code;
    
    htmlStr += `
      <div style="padding:10px 12px;background:var(--bg3);border-radius:10px;margin-bottom:8px;border:1px solid var(--bd);display:flex;flex-direction:column;gap:6px;">
        
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:14px;font-weight:600;color:var(--t1)">${getProductName(p.code)}</div>
          <div style="text-align:right;" id="sell_calc_shares_${p.code}">
            <div style="font-family:var(--f-num);font-size:13px;font-weight:500;color:var(--t3);line-height:1.2;">-- <span style="font-size:10px;font-weight:400;font-family:var(--f-zh)">份</span></div>
          </div>
        </div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:11px;color:var(--t3);font-family:var(--f-num);white-space:nowrap;">
            ${shares.toFixed(2)} <span style="font-family:var(--f-zh)">份</span> × ${nav ? nav.toFixed(4) : '--'} × ${eqPct}%
          </div>
          <div style="text-align:right;" id="sell_calc_fiat_${p.code}">
             <div style="font-size:11px;color:var(--t3);font-family:var(--f-num);line-height:1.2;height:16px;display:flex;align-items:center;justify-content:flex-end;">-- 元</div>
          </div>
        </div>
        
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
          <button class="pri-btn" data-code="${p.code}" onclick="togglePrioritySell('${p.code}')"
              style="font-size:11px; height:24px; box-sizing:border-box; width:72px; border-radius:6px; border:1px solid ${isPri ? '#f59e0b' : 'var(--bd2)'}; background:${isPri ? 'rgba(245,158,11,0.1)' : 'transparent'}; color:${isPri ? '#f59e0b' : 'var(--t3)'}; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; justify-content:center; padding:0;">
              ${isPri ? '★ 优先' : '☆ 设为优先'}
          </button>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--t3);">减仓比例</span>
            <input type="tel" inputmode="numeric" pattern="[0-9]*" placeholder="0" 
                   style="width:52px; height:24px; box-sizing:border-box; background:var(--bg); border:1px solid var(--bd2); border-radius:6px; color:var(--t1); font-family:var(--f-num); font-size:14px; padding:0; text-align:center; outline:none;" 
                   id="ratio_${p.code}" value="${saved}" oninput="calcSellPreview()" onchange="calcSellPreview()" onkeyup="calcSellPreview()">
          </div>
        </div>

      </div>`;
  });

  htmlStr += `
        <div style="margin-top:10px;padding:10px;background:var(--bg3);border-radius:8px" id="sell_preview_result">
          <span style="font-size:12px;color:var(--t3)">填写比例或设置优先卖出后显示操作结果</span>
        </div>
      </div>
    </div>`;

  body.innerHTML = htmlStr;
  
  calcSellPreview();
}

function calcSellPreview() {
  const holdings = loadHoldings();
  const eqResult = calcCurrentEquity(holdings); 
  if(!eqResult) return;
  
  const TARGET_EQ = getDynamicTarget('sell') || 25.0;
  const {equity: currentEq, total: totalVal} = eqResult;
  const currentEqVal = totalVal * currentEq / 100;
  const targetEqVal = totalVal * TARGET_EQ / 100;
  
  let sellNeededEq = Math.max(0, currentEqVal - targetEqVal);
  const sellProducts = funds.map(code => PRODUCTS.find(p => p.code === code)).filter(p => p && p.equity > 0);
  let totalRatio = 0; 
  const ratios = {};
  
  sellProducts.forEach(p => { 
    let v = parseFloat(document.getElementById('ratio_' + p.code)?.value) || 0; 
    if (window._prioritySellCode === p.code) v = 0; 
    ratios[p.code] = v; 
    totalRatio += v; 
  });

  const emptySharesHtml = `<div style="font-family:var(--f-num);font-size:13px;font-weight:500;color:var(--t3);line-height:1.2;">-- <span style="font-size:10px;font-weight:400;font-family:var(--f-zh)">份</span></div>`;
  const emptyFiatHtml = `<div style="font-size:11px;color:var(--t3);font-family:var(--f-num);line-height:1.2;height:16px;display:flex;align-items:center;justify-content:flex-end;">-- 元</div>`;

  if(!totalRatio && !window._prioritySellCode) {
    document.getElementById('sell_preview_result').innerHTML = '<span style="font-size:12px;color:var(--t3)">填写比例或设置优先产品后显示操作结果</span>';
    sellProducts.forEach(p => { 
      const elShares = document.getElementById('sell_calc_shares_' + p.code); 
      const elFiat = document.getElementById('sell_calc_fiat_' + p.code); 
      if(elShares) elShares.innerHTML = emptySharesHtml; 
      if(elFiat) elFiat.innerHTML = emptyFiatHtml; 
    });
    return;
  }

  let afterEqVal = currentEqVal;
  let totalCashOut = 0;
  let totalFriction = 0;
  const sellResults = {};

  if (window._prioritySellCode) {
    const pPri = sellProducts.find(p => p.code === window._prioritySellCode);
    if (pPri) {
      const nav = getNavByCode(pPri.code) || 1.0;
      const maxSellAmount = (holdings[pPri.code] || 0) * nav; 
      const maxEqContribution = maxSellAmount * pPri.equity; 
      const actualEqToSell = Math.min(sellNeededEq, maxEqContribution);
      const actualSellAmt = actualEqToSell / pPri.equity;

      sellResults[pPri.code] = { amt: actualSellAmt, nav: nav };
      sellNeededEq -= actualEqToSell; 
    }
  }

  sellProducts.forEach(p => {
    if (p.code === window._prioritySellCode) return; 
    const nav = getNavByCode(p.code) || 1.0;
    
    if (!totalRatio || !ratios[p.code]) {
      sellResults[p.code] = { amt: 0, nav: nav };
      return;
    }

    const eqQuota = sellNeededEq * (ratios[p.code] / totalRatio);
    const maxSellAmount = (holdings[p.code] || 0) * nav;
    const actualSellAmt = Math.min(eqQuota / p.equity, maxSellAmount);
    sellResults[p.code] = { amt: actualSellAmt, nav: nav };
  });

  let hasAnySell = false;
  sellProducts.forEach(p => {
    const res = sellResults[p.code] || { amt: 0, nav: getNavByCode(p.code) || 1.0 };
    const actualSell = res.amt;
    const elShares = document.getElementById('sell_calc_shares_' + p.code);
    const elFiat = document.getElementById('sell_calc_fiat_' + p.code);

    if (!actualSell) { 
      if(elShares) elShares.innerHTML = emptySharesHtml; 
      if(elFiat) elFiat.innerHTML = emptyFiatHtml; 
      return; 
    }
    
    hasAnySell = true;
    const feeAmt = actualSell * SYS_CONFIG.FEE;
    const cashOut = actualSell - feeAmt;
    const eqContribution = actualSell * p.equity;
    const eqDropPct = (eqContribution / totalVal) * 100;

    afterEqVal -= eqContribution; 
    totalCashOut += cashOut; 
    totalFriction += feeAmt;

    if(elShares) {
      elShares.innerHTML = `<div style="font-family:var(--f-num);font-size:13px;font-weight:600;color:var(--up);line-height:1.2;">${fmt(actualSell / res.nav, 2)} <span style="font-size:10px;font-weight:400;color:var(--t3);font-family:var(--f-zh)">份</span></div>`;
    }
    
    if(elFiat) {
      elFiat.innerHTML = `
        <div style="font-size:11px;display:flex;justify-content:flex-end;gap:6px;align-items:center;line-height:1.2;height:16px;">
          <span style="color:var(--t3);font-family:var(--f-num)">${fmtMoney(actualSell)}</span>
          <span style="color:#f59e0b;font-family:var(--f-zh);font-size:10px;background:rgba(245,158,11,0.1);padding:1px 4px;border-radius:4px;">降权 ${eqDropPct.toFixed(2)}%</span>
        </div>
      `;
    }
  });

  if (!hasAnySell) {
    document.getElementById('sell_preview_result').innerHTML = '<span style="font-size:12px;color:var(--t3)">优先持仓已清空，请为其他产品填写减仓比例</span>';
    return;
  }

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