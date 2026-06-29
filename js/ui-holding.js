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
    ? 'class="dr-card dr-pad dr-summary-box" style="position:relative; z-index:1; border-radius:0 12px 12px 12px; margin-bottom:0;"'
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

  // 统一的 Tab 标签样式
  const tabStyle =
    "display:inline-block; background:var(--bg3); border:1px solid var(--bd); border-bottom:none; color:var(--t1); font-size:13px; font-weight:600; padding:6px 14px; border-radius:8px 8px 0 0; font-family:var(--f-zh); margin-bottom:-1px; position:relative; z-index:2;";

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
  <div style="margin-bottom:10px;">
    <div style="${tabStyle}">💰 资产权益</div>
    ${summaryHtml}
  </div>`;

  const eqAmtStr = eqData
    ? fmtMoney((eqData.total * eqData.equity) / 100)
    : "--";

  // ====== 2. 资产价值明细 ======
  html += `
  <div style="margin-bottom:10px;">
    <div style="display:flex; justify-content:space-between; align-items:flex-end;">
      <div style="${tabStyle}">📑 资产明细</div>
      <div class="dr-lbl" style="font-family:var(--f-zh); margin-bottom:4px; margin-right:4px;">权益总额 <span class="num" style="color:var(--accent);font-size:13px;font-weight:600;">${eqAmtStr}</span></div>
    </div>
    <div class="dr-card" style="position:relative; z-index:1; border-radius:0 12px 12px 12px; padding:4px 0;">
      <div style="${gridDet} padding:6px 12px; border-bottom:1px solid var(--bd2); font-size:11px; color:var(--t3); font-family:var(--f-zh); font-weight:400;">
        <div>产品简称</div><div style="display:flex;justify-content:flex-end;">今日收益(¥)</div><div style="display:flex;justify-content:flex-end;">持仓占比</div><div style="display:flex;justify-content:flex-end;">持仓金额(¥)</div>
      </div>`;

  activeProds.forEach((p, idx) => {
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
      <div style="${gridDet} align-items:center; padding:7px 12px; ${idx === activeProds.length - 1 ? "" : "border-bottom:1px solid var(--bd);"}">
        <div style="font-family:var(--f-zh); font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        <div style="display:flex;justify-content:flex-end;font-size:13px;font-weight:600;" class="num ${pnlCls}">${pnlTxt}</div>
        <div class="num" style="display:flex;justify-content:flex-end;font-size:13px;font-weight:400;color:var(--t2);">${ratioStr}</div>
        <div class="num" style="display:flex;justify-content:flex-end;font-size:13px;font-weight:600;color:var(--t1);">${val ? fmt(val, 2) : "--"}</div>
      </div>`;
  });
  html += `</div></div>`;

  // ====== 3. 植入预案动态容器 (明细之下，配置之上) ======
  html += `<div id="holdingPlanArea"></div>`;

  // ====== 4. 持仓配置 ======
  html += `<div id="holdingConfigArea" style="display:none; margin-top:10px;">`;
  html += `
    <div style="${tabStyle}">⚙ 持仓配置</div>
    <div class="dr-card" style="position:relative; z-index:1; border-radius:0 12px 12px 12px; padding:0;">
      <div style="${gridStyle} padding:6px 12px; border-bottom:1px solid var(--bd); background:var(--bg4); font-size:11px; color:var(--t3); font-family:var(--f-zh); font-weight:400;">
        <div>产品简称</div><div style="text-align:center;">优先级</div><div style="text-align:center;">权重</div><div style="text-align:center;">权益档</div><div style="text-align:right;">份额</div>
      </div><div class="dr-col" style="gap:0;">`;

  activeProds.forEach((p, idx) => {
    const isPri = p.code === priorityCode;
    const priColor = isPri ? "var(--sell)" : "var(--t3)";
    const priBd = isPri ? "var(--sell-bd)" : "var(--bd2)";
    const priBg = isPri ? "var(--sell-bg)" : "transparent";
    const priTxt = isPri ? "优先" : "—";

    html += `
      <div style="${gridStyle} align-items:center; padding:8px 12px; ${idx === activeProds.length - 1 ? "" : "border-bottom:1px dashed var(--bd2);"}">
        <div style="min-width:0;"><input id="sn_${p.code}" type="text" class="dr-input-ghost" style="width:100%; font-family:var(--f-zh); font-size:13px; font-weight:600;" value="${shortNameMap[p.code] || ""}" placeholder="${p.name}"></div>

        <div style="display:flex; justify-content:center;">
            <div id="pri_btn_${p.code}" onclick="toggleHoldingPriority('${p.code}')" style="width:34px; height:24px; line-height:22px; text-align:center; border:1px solid ${priBd}; border-radius:4px; background:${priBg}; color:${priColor}; font-family:var(--f-zh); font-size:11px; font-weight:600; cursor:pointer; user-select:none; transition:all 0.2s;">${priTxt}</div>
        </div>

        <div style="display:flex; justify-content:center;">
            <input id="wt_${p.code}" type="number" step="0.01" class="num" oninput="if(typeof liveUpdateHoldingPlan === 'function') liveUpdateHoldingPlan()" style="width:40px; height:24px; background:var(--bg); border:1px solid var(--bd2); border-radius:4px; text-align:center; font-size:13px; color:var(--t1); outline:none;" value="${savedPlan[p.code] || ""}" placeholder="—">
        </div>

        <div style="display:flex; justify-content:center;">
            <input id="eq_${p.code}" type="number" step="0.01" class="num" style="width:40px; height:24px; background:var(--bg); border:1px solid var(--bd2); border-radius:4px; text-align:center; font-size:13px; color:var(--accent); outline:none; font-weight:600;" value="${(equityMap[p.code] != null ? equityMap[p.code] : p.equity).toFixed(2)}" placeholder="0.00">
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
  <div style="display:flex;gap:8px;margin-top:12px">
    <button onclick="manualPull()" ${pullDisabled} style="flex:1;padding:8px 12px;border-radius:10px;border:1px solid ${pullBd};background:var(--bg3);color:${pullCol};font-family:var(--f-zh);font-size:13px;font-weight:500;cursor:pointer;opacity:${_canPull ? "1" : "0.45"};">↓ 拉取云端</button>
    <button id="cloudCfgBtn" onclick="openCloudConfig()" style="flex:1;padding:8px 12px;border-radius:10px;border:1px solid ${cfgBd};background:var(--bg3);color:${cfgCol};font-family:var(--f-zh);font-size:13px;font-weight:500;cursor:pointer;">${cfgLabel}</button>
  </div>
  </div>`;

  return html;
}

function UI_buildHoldingPlanHtml(
  activeProds,
  currentPE,
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
    <div style="margin: 10px 0;">
      <div style="display:inline-block; background:var(--buy-bg); border:1px solid var(--buy-bd); border-bottom:none; color:var(--buy); font-size:13px; font-weight:600; padding:6px 14px; border-radius:8px 8px 0 0; font-family:var(--f-zh); margin-bottom:-1px; position:relative; z-index:2;">⬆ 增权预案</div>
      <div class="dr-card" style="position:relative; z-index:1; border-radius:0 12px 12px 12px; border:1px solid var(--buy-bd); background:var(--bg3); padding:12px;">
        <div class="dr-summary-box" style="margin-bottom:12px;">
          <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl" style="margin-bottom:2px;">当前权益</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${fmt(eqData.equity, 2)}%</div></div>
          <div class="dr-summary-item" style="flex:1; border-left:1px solid var(--bd2); border-right:1px solid var(--bd2); padding:0 4px;"><div class="dr-lbl" style="margin-bottom:2px;">测算目标</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${buyDraft.targetEq}%</div></div>
          <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl" style="margin-bottom:2px;">需要增权</div><div class="num" style="color:var(--buy); font-size:16px; font-weight:600;">${fmt(diffPct, 2)}%</div></div>
        </div>
        <div class="dr-lbl" style="margin-bottom:6px; font-family:var(--f-zh);">资金调配 (固定转出)</div>
        <div style="display:flex; flex-direction:column; gap:6px;">
          <div style="background:var(--bg2); border:1px solid var(--bd); border-radius:8px; padding:8px 12px; display:flex; justify-content:space-between; align-items:center;">
            <div style="font-family:var(--f-zh); color:var(--t1); font-size:13px;"><span style="font-weight:400;">转出</span> <span style="font-weight:500;">${SHORT_NAMES[SYS_CONFIG.CODE_XQ]}</span><span style="color:var(--t3); margin-left:4px;">→ ${SHORT_NAMES[SYS_CONFIG.CODE_A500]}</span></div>
            <div class="num" style="color:var(--buy); font-size:15px; font-weight:600; white-space:nowrap;">${fmt(buyDraft.sharesA500C, 2)} <span style="font-size:11px; color:var(--t2); margin-left:2px; font-weight:400; font-family:var(--f-zh);">份</span></div>
          </div>
          ${buyDraft.allocZZ500C > 0 ? `<div style="background:var(--bg2); border:1px solid var(--bd); border-radius:8px; padding:8px 12px; display:flex; justify-content:space-between; align-items:center;"><div style="font-family:var(--f-zh); color:var(--t1); font-size:13px;"><span style="font-weight:400;">转出</span> <span style="font-weight:500;">${SHORT_NAMES[SYS_CONFIG.CODE_XQ]}</span><span style="color:var(--t3); margin-left:4px;">→ ${buyDraft.zz500Code ? SHORT_NAMES[buyDraft.zz500Code] || buyDraft.zz500Code : "中证500C"}</span></div><div class="num" style="color:var(--buy); font-size:15px; font-weight:600; white-space:nowrap;">${fmt(buyDraft.sharesZZ500C, 2)} <span style="font-size:11px; color:var(--t2); margin-left:2px; font-weight:400; font-family:var(--f-zh);">份</span></div></div>` : ""}
        </div>
        <div style="text-align:center; margin-top:10px; font-size:13px; font-family:var(--f-zh); color:var(--t2);">
          调配金额 <span class="num" style="font-weight:600; border-bottom:1px dashed var(--bd2); padding-bottom:2px; font-size:14px; color:var(--t1); margin-right:16px;">${fmt(buyDraft.buyAmt, 2)}</span>
          交易磨损 <span class="num" style="font-weight:600; border-bottom:1px dashed var(--bd2); padding-bottom:2px; color:var(--warn); font-size:14px;">${fmt(friction, 2)}</span>
        </div>
      </div>
    </div>`;
  }

  // 2. 渲染降权预案 (只要 sellDraft 有效且存在动作)
  if (sellDraft && !sellDraft.error && sellDraft.hasAnySell) {
    html += `
    <div style="margin: 10px 0;">
      <div style="display:inline-block; background:var(--sell-bg); border:1px solid var(--sell-bd); border-bottom:none; color:var(--sell); font-size:13px; font-weight:600; padding:6px 14px; border-radius:8px 8px 0 0; font-family:var(--f-zh); margin-bottom:-1px; position:relative; z-index:2;">⬇ 降权预案</div>
      <div class="dr-card" style="position:relative; z-index:1; border-radius:0 12px 12px 12px; border:1px solid var(--sell-bd); background:var(--bg3); padding:12px;">
        <div class="dr-summary-box" style="margin-bottom:12px;">
          <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl" style="margin-bottom:2px;">当前权益</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${fmt(eqData.equity, 2)}%</div></div>
          <div class="dr-summary-item" style="flex:1; border-left:1px solid var(--bd2); border-right:1px solid var(--bd2); padding:0 4px;"><div class="dr-lbl" style="margin-bottom:2px;">测算目标</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${sellDraft.targetEq}%</div></div>
          <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl" style="margin-bottom:2px;">需要降权</div><div class="num" style="color:var(--sell); font-size:16px; font-weight:600;">${fmt(eqData.equity - sellDraft.targetEq, 2)}%</div></div>
        </div>
        <div class="dr-lbl" style="margin-bottom:6px; font-family:var(--f-zh);">资金调配 (按权重转出)</div>
        <div style="display:flex; flex-direction:column; gap:6px;">`;

    activeProds.forEach((p) => {
      const res = sellDraft.results?.[p.code];
      if (res && res.amt > 0) {
        html += `
          <div style="background:var(--bg2); border:1px solid var(--bd); border-radius:8px; padding:8px 12px; display:flex; justify-content:space-between; align-items:center;">
            <div style="font-family:var(--f-zh); color:var(--t1); font-size:13px;"><span style="font-weight:400;">转出</span> <span style="font-weight:600;">${p.name}</span></div>
            <div style="display:flex; align-items:center;"><span class="num" style="color:var(--sell); font-size:15px; font-weight:600;">${fmt(res.shares, 2)}</span><span style="font-size:11px; color:var(--t2); font-weight:400; margin-left:3px; font-family:var(--f-zh);">份</span></div>
          </div>`;
      }
    });

    html += `
        </div>
        <div style="text-align:center; margin-top:10px; font-size:13px; font-family:var(--f-zh); color:var(--t2);">
          测算总金额 <span class="num" style="font-weight:600; border-bottom:1px dashed var(--bd2); padding-bottom:2px; font-size:14px; color:var(--t1); margin-right:16px;">${fmt(sellDraft.totalCashOut + sellDraft.totalFriction, 2)}</span>
          交易磨损 <span class="num" style="font-weight:600; border-bottom:1px dashed var(--bd2); padding-bottom:2px; color:var(--warn); font-size:14px;">${fmt(sellDraft.totalFriction, 2)}</span>
        </div>
      </div>
    </div>`;
  }

  return html;
}

