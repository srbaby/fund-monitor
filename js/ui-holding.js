function UI_buildSummaryHtml(
  currentPE,
  eqData,
  currentEqVal,
  eqCol,
  targetNeutralNum,
  inDrawer = false,
) {
  const totalStr = eqData ? fmtMoney(eqData.total) : "--";
  const curEqStr = currentEqVal != null ? fmt(currentEqVal, 2) + "%" : "--";

  const targetStr = targetNeutralNum != null ? targetNeutralNum + "%" : "--";
  const diff =
    eqData && targetNeutralNum != null
      ? eqData.equity - targetNeutralNum
      : null;
  const wrongDir = isEquityWrongDir(currentPE?.value, diff);
  const isNeutral = diff != null && Math.abs(diff) < 1 && !wrongDir;
  const badgeCol = isNeutral ? "var(--t2)" : eqCol;
  const badgeHtml =
    diff != null
      ? `<span class="num" style="color:${badgeCol};font-size:11px;font-weight:500;">${diff > 0 ? "+" : ""}${fmt(diff, 2)}%</span>`
      : "";

  const boxClass = inDrawer
    ? 'class="dr-card dr-pad dr-summary-box"'
    : 'class="dr-card dr-pad dr-sec dr-summary-box"';
  return `<div ${boxClass}>
    <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl">持仓总额</div><div class="dr-val num" style="color:var(--accent); font-weight:600;">${totalStr}</div></div>
    <div class="dr-summary-item" style="flex:1;border-left:1px solid var(--bd2); border-right:1px solid var(--bd2); padding:0 4px;"><div class="dr-lbl">当前权益</div><div style="display:flex;align-items:baseline;justify-content:center;gap:3px;"><span class="dr-val num" style="color:${eqCol}; font-weight:600;">${curEqStr}</span>${badgeHtml}</div></div>
    <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl">目标权益</div><div class="dr-val num" style="font-weight:600;">${targetStr}</div></div>
  </div>`;
}

// holdings 和 activeProds 由调用方从 store 读取后传入，ui 层不直接访问 localStorage

// profitMap: { [code]: number | null } — 由 interact 层计算后传入
function UI_renderHoldingDrawerBody(
  activeProds,
  holdings,
  equityMap,
  shortNameMap,
  getNavFn,
  eqData,
  currentPE,
  targetEqNeutral,
  profitMap,
  savedPlan = {},
  priorityCode = null,
) {
  const diff =
    eqData && targetEqNeutral != null ? eqData.equity - targetEqNeutral : null;
  const wrongDir = isEquityWrongDir(currentPE?.value, diff);
  const isNeutral = diff != null && Math.abs(diff) < 1 && !wrongDir;
  const diffCol =
    diff == null
      ? "var(--t3)"
      : wrongDir
        ? "var(--warn)"
        : isNeutral
          ? "var(--t1)"
          : diff > 0
            ? "var(--sell)"
            : "var(--buy)";

  const gridStyle =
    "display:grid; grid-template-columns: minmax(70px, 1.2fr) 38px 46px 46px 1fr; gap:8px;";
  const gridDet =
    "display:grid; grid-template-columns: minmax(70px, 1.4fr) minmax(65px, 1fr) minmax(60px, 1fr) minmax(85px, 1.2fr); gap:8px;";

  // ====== 1. 权益校对汇总 ======
  const summaryHtml = UI_buildSummaryHtml(
    currentPE,
    eqData,
    eqData?.equity,
    diffCol,
    targetEqNeutral,
    true,
  );

  let html = `
  <div class="dr-section">
    <div class="dr-section-title">💰 资产权益</div>
    ${summaryHtml}
  </div>`;

  const eqAmtStr = eqData
    ? fmtMoney((eqData.total * eqData.equity) / 100)
    : "--";

  // ====== 2. 资产价值明细 ======
  html += `
  <div class="dr-section">
    <div class="dr-section-head">
      <div class="dr-section-title">📑 资产明细</div>
      <div class="dr-section-meta">权益总额 <span class="num">${eqAmtStr}</span></div>
    </div>
    <div class="dr-card dr-table-card">
      <div class="dr-table-head" style="${gridDet}">
        <div>产品简称</div><div style="display:flex;justify-content:flex-end;">最新收益(¥)</div><div style="display:flex;justify-content:flex-end;">持仓占比</div><div style="display:flex;justify-content:flex-end;">持仓金额(¥)</div>
      </div>`;

  activeProds.forEach((p) => {
    const shares = holdings[p.code] || 0;
    const nav = getNavFn(p.code) || 0;
    const val = shares * nav;
    const ratioStr =
      eqData && eqData.total > 0
        ? fmt((val / eqData.total) * 100, 1) + "%"
        : "--";

    const profitAmt = profitMap[p.code] ?? null;
    const pnlCls = profitAmt > 0 ? "up" : profitAmt < 0 ? "down" : "flat";
    const pnlTxt =
      profitAmt != null
        ? (profitAmt > 0 ? "+" : "") + profitAmt.toFixed(2)
        : "--";

    html += `
      <div class="dr-table-row" style="${gridDet}">
        <div class="dr-product-name">${p.name}</div>
        <div style="display:flex;justify-content:flex-end;font-size:13px;font-weight:600;" class="num ${pnlCls}">${pnlTxt}</div>
        <div class="num" style="display:flex;justify-content:flex-end;font-size:13px;font-weight:400;color:var(--t2);">${ratioStr}</div>
        <div class="num" style="display:flex;justify-content:flex-end;font-size:13px;font-weight:600;color:var(--t1);">${val ? fmt(val, 2) : "--"}</div>
      </div>`;
  });
  html += `</div></div>`;

  // ====== 3. 植入预案动态容器 (明细之下，配置之上) ======
  html += `<div id="holdingPlanArea"></div>`;

  // ====== 4. 持仓配置 ======
  html += `<div id="holdingConfigArea" class="dr-section" style="display:none;">`;
  html += `
    <div class="dr-section-title">⚙ 持仓配置</div>
    <div class="dr-card dr-table-card">
      <div class="dr-table-head" style="${gridStyle}">
        <div>产品简称</div><div style="text-align:center;">优先级</div><div style="text-align:center;">权重</div><div style="text-align:center;">权益档</div><div style="text-align:right;">份额</div>
      </div><div class="dr-col" style="gap:0;">`;

  activeProds.forEach((p) => {
    const isPri = p.code === priorityCode;
    const priColor = isPri ? "var(--sell)" : "var(--t3)";
    const priBd = isPri ? "var(--sell-bd)" : "var(--bd2)";
    const priBg = isPri ? "var(--sell-bg)" : "transparent";
    const priTxt = isPri ? "优先" : "—";

    html += `
      <div class="dr-config-row" style="${gridStyle}">
        <div style="min-width:0;"><input id="sn_${p.code}" type="text" class="dr-input-ghost" style="width:100%; font-family:var(--f-zh); font-size:13px; font-weight:600;" value="${shortNameMap[p.code] || ""}" placeholder="${p.name}"></div>

        <div style="display:flex; justify-content:center;">
            <div id="pri_btn_${p.code}" class="dr-priority-pill" onclick="toggleHoldingPriority('${p.code}')" style="border-color:${priBd}; background:${priBg}; color:${priColor};">${priTxt}</div>
        </div>

        <div style="display:flex; justify-content:center;">
            <input id="wt_${p.code}" type="number" step="0.01" class="dr-mini-input num" oninput="if(typeof liveUpdateHoldingPlan === 'function') liveUpdateHoldingPlan()" value="${savedPlan[p.code] || ""}" placeholder="—">
        </div>

        <div style="display:flex; justify-content:center;">
            <input id="eq_${p.code}" type="number" step="0.01" class="dr-mini-input dr-mini-input--accent num" value="${(equityMap[p.code] != null ? equityMap[p.code] : p.equity).toFixed(2)}" placeholder="0.00">
        </div>

        <div style="min-width:0;">
            <input id="hi_${p.code}" type="number" step="0.01" class="dr-input-ghost num" oninput="if(typeof liveUpdateHoldingPlan === 'function') liveUpdateHoldingPlan()" style="width:100%; text-align:right; font-size:14px; font-weight:600; color:var(--t1);" value="${holdings[p.code] > 0 ? holdings[p.code].toFixed(2) : ""}" placeholder="0.00">
        </div>
      </div>`;
  });
  const _cs = getCloudStatus();
  const _count = _cs.count;
  const _canPull = isCloudConfigured();
  // 配置按钮：有填写的全部验证通过→绿，有填写但验证失败→红，0个→灰
  const cfgCol =
    _count === 0 ? "var(--t3)" : _cs.ok ? "var(--dn)" : "var(--sell)";
  const cfgBd =
    _count === 0 ? "var(--bd2)" : _cs.ok ? "var(--dn-bd)" : "var(--sell-bd)";
  const cfgLabel = `⚙ 配置 (${_count}/2)`;
  // 拉取按钮：未配置禁用+灰，已配置中性色（不用绿）
  const pullDisabled = _canPull ? "" : "disabled";
  const pullCol = _canPull ? "var(--t2)" : "var(--t3)";
  const pullBd = _canPull ? "var(--bd2)" : "var(--bd2)";
  html += `</div></div></div>
  <div class="dr-cloud-actions">
    <button class="dr-cloud-btn" onclick="manualPull()" ${pullDisabled} style="border-color:${pullBd};color:${pullCol};opacity:${_canPull ? "1" : "0.45"};">↓ 拉取云端</button>
    <button class="dr-cloud-btn" id="cloudCfgBtn" onclick="openCloudConfig()" style="border-color:${cfgBd};color:${cfgCol};">${cfgLabel}</button>
  </div>
  </div>`;

  return html;
}

function UI_buildHoldingPlanHtml(
  activeProds,
  targetEqNeutral,
  eqData,
  buyDraft,
  sellDraft,
) {
  if (!eqData || targetEqNeutral == null) return "";

  let html = "";

  // 1. 渲染增权预案 (只要 buyDraft 有效且存在买入金额)
  if (buyDraft && buyDraft.buyAmt > 0) {
    const diffPct = buyDraft.targetEq - eqData.equity;
    const friction = buyDraft.totalFriction || 0;

    html += `
    <div class="dr-section">
      <div class="dr-section-title buy">⬆ 增权预案</div>
      <div class="dr-card dr-plan-card buy">
        <div class="dr-summary-box" style="margin-bottom:12px;">
          <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl" style="margin-bottom:2px;">当前权益</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${fmt(eqData.equity, 2)}%</div></div>
          <div class="dr-summary-item" style="flex:1; border-left:1px solid var(--bd2); border-right:1px solid var(--bd2); padding:0 4px;"><div class="dr-lbl" style="margin-bottom:2px;">测算目标</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${buyDraft.targetEq}%</div></div>
          <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl" style="margin-bottom:2px;">需要增权</div><div class="num" style="color:var(--buy); font-size:16px; font-weight:600;">${fmt(diffPct, 2)}%</div></div>
        </div>
        <div class="dr-lbl" style="margin-bottom:6px; font-family:var(--f-zh);">资金调配 (固定转出)</div>
        <div class="dr-flow-list">
          <div class="dr-flow-row">
            <div class="dr-flow-main"><span>转出</span> <b>${SHORT_NAMES[SYS_CONFIG.CODE_XQ]}</b><em>→ ${SHORT_NAMES[SYS_CONFIG.CODE_A500]}</em></div>
            <div class="dr-flow-shares buy num">${fmt(buyDraft.sharesA500C, 2)} <span>份</span></div>
          </div>
          ${buyDraft.allocZZ500C > 0 ? `<div class="dr-flow-row"><div class="dr-flow-main"><span>转出</span> <b>${SHORT_NAMES[SYS_CONFIG.CODE_XQ]}</b><em>→ ${buyDraft.zz500Code ? SHORT_NAMES[buyDraft.zz500Code] || buyDraft.zz500Code : "中证500C"}</em></div><div class="dr-flow-shares buy num">${fmt(buyDraft.sharesZZ500C, 2)} <span>份</span></div></div>` : ""}
        </div>
        <div class="dr-plan-foot">
          <span>调配金额 <b class="num">${fmt(buyDraft.buyAmt, 2)}</b></span>
          <span>交易磨损 <b class="num warn">${fmt(friction, 2)}</b></span>
        </div>
      </div>
    </div>`;
  }

  // 2. 渲染降权预案 (只要 sellDraft 有效且存在动作)
  if (sellDraft && !sellDraft.error && sellDraft.hasAnySell) {
    html += `
    <div class="dr-section">
      <div class="dr-section-title sell">⬇ 降权预案</div>
      <div class="dr-card dr-plan-card sell">
        <div class="dr-summary-box" style="margin-bottom:12px;">
          <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl" style="margin-bottom:2px;">当前权益</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${fmt(eqData.equity, 2)}%</div></div>
          <div class="dr-summary-item" style="flex:1; border-left:1px solid var(--bd2); border-right:1px solid var(--bd2); padding:0 4px;"><div class="dr-lbl" style="margin-bottom:2px;">测算目标</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${sellDraft.targetEq}%</div></div>
          <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl" style="margin-bottom:2px;">需要降权</div><div class="num" style="color:var(--sell); font-size:16px; font-weight:600;">${fmt(eqData.equity - sellDraft.targetEq, 2)}%</div></div>
        </div>
        <div class="dr-lbl" style="margin-bottom:6px; font-family:var(--f-zh);">资金调配 (按权重转出)</div>
        <div class="dr-flow-list">`;

    activeProds.forEach((p) => {
      const res = sellDraft.results?.[p.code];
      if (res && res.amt > 0) {
        html += `
          <div class="dr-flow-row">
            <div class="dr-flow-main"><span>转出</span> <b>${p.name}</b></div>
            <div class="dr-flow-shares sell num">${fmt(res.shares, 2)} <span>份</span></div>
          </div>`;
      }
    });

    html += `
        </div>
        <div class="dr-plan-foot">
          <span>测算总金额 <b class="num">${fmt(sellDraft.totalCashOut + sellDraft.totalFriction, 2)}</b></span>
          <span>交易磨损 <b class="num warn">${fmt(sellDraft.totalFriction, 2)}</b></span>
        </div>
      </div>
    </div>`;
  }

  return html;
}
