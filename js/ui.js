// ============================================================
// ui.js - 渲染层 (v3.1 响应式与微模板版)
// 职责：所有 DOM 更新，时钟、指数栏、PE 栏、卡片、表格、今日盈亏渲染、抽屉 HTML 生成
// 铁律：不含业务计算，不含 localStorage 读写
// ============================================================

let _mktState = null,
  allCollapsed = true,
  mobileExpanded = false,
  miniMode = 0;
let cardSortable = null,
  tblSortable = null;
const miniLabels = ["估算", "官方", "全部"];
const prevData = {},
  idxPrev = {};
const _peDOM = {};
let _peDOMReady = false;
// 缓存高频访问的静态 DOM 节点
const _el = {};
function _getEl(id) {
  if (!_el[id]) _el[id] = document.getElementById(id);
  return _el[id];
}

// ---- 格式化工具 ----
function fp(v) {
  if (v == null || isNaN(v)) return { cls: "flat", txt: "--" };
  return {
    cls: v > 0 ? "up" : v < 0 ? "down" : "flat",
    txt: (v > 0 ? "+" : "") + v.toFixed(2) + "%",
  };
}
function fmt(n, decimals = 0) {
  return n == null || isNaN(n)
    ? "--"
    : n.toLocaleString("zh-CN", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
}
function fmtMoney(n) {
  return "¥" + fmt(n, 2);
}
function getProductName(code) {
  return (
    SHORT_NAMES[code] || PRODUCTS.find((p) => p.code === code)?.name || code
  );
}
function getDisplayName(f) {
  return f.name || NAMES[f.code] || f.code;
}

function isStructureUnchanged(containerId, targetCodes) {
  const container = document.getElementById(containerId);
  if (!container) return false;
  const currentCodes = Array.from(container.children)
    .filter((c) => c.dataset?.code)
    .map((c) => c.dataset.code);
  return (
    currentCodes.length > 0 && currentCodes.join(",") === targetCodes.join(",")
  );
}

// ============================================================
// UI 微模板工厂 (UI Template Factory)
// ============================================================

function UI_showDialog(options) {
  const modal = document.createElement("div");
  modal.style.cssText =
    "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;";

  const mask = document.createElement("div");
  mask.style.cssText = "position:absolute;inset:0;background:rgba(0,0,0,.6);";
  mask.onclick = () => document.body.removeChild(modal);

  const box = document.createElement("div");
  box.style.cssText =
    "position:relative;background:var(--bg2);border-radius:16px;padding:24px;width:100%;max-width:320px;border:1px solid var(--bd2);display:flex;flex-direction:column;gap:12px;";

  const title = document.createElement("div");
  title.style.cssText = "font-size:15px;font-weight:600;color:var(--t1);";
  title.textContent = options.title;
  box.appendChild(title);

  if (options.desc) {
    const desc = document.createElement("div");
    desc.style.cssText = "font-size:12px;color:var(--t3);line-height:1.4;";
    desc.textContent = options.desc;
    box.appendChild(desc);
  }

  const textarea = document.createElement("textarea");
  textarea.className = "token-textarea";
  if (options.placeholder) textarea.placeholder = options.placeholder;
  if (options.value) textarea.value = options.value;
  if (options.readOnly) textarea.readOnly = true;
  box.appendChild(textarea);

  const btnWrap = document.createElement("div");
  btnWrap.style.cssText = "display:flex;gap:8px;margin-top:8px;";

  if (options.showCancel) {
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.className = "modal-btn-cancel";
    cancelBtn.onclick = () => document.body.removeChild(modal);
    btnWrap.appendChild(cancelBtn);
  }

  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = options.confirmText;
  confirmBtn.className = "modal-btn-zh";
  if (options.showCancel) confirmBtn.style.flex = "2";
  confirmBtn.onclick = () => options.onConfirm(textarea, modal);
  btnWrap.appendChild(confirmBtn);

  box.appendChild(btnWrap);
  modal.appendChild(mask);
  modal.appendChild(box);
  document.body.appendChild(modal);
}

function UI_renderEmptyState() {
  const emptyHtml = `
    <div class="empty-state">
      <div class="empty-icon">📭</div>
      <div style="font-size:15px; font-weight:600; color:var(--t2); margin-bottom:6px;">暂无关注产品</div>
      <div style="font-size:12px; color:var(--t3);">请在下方输入 6 位基金代码，构建你的配置看板</div>
    </div>
  `;
  return {
    card: emptyHtml,
    table: `<tr><td colspan="4" style="background:transparent; border:none; padding:0;">${emptyHtml}</td></tr>`,
  };
}

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
  const diff = eqData && targetNeutralNum != null ? eqData.equity - targetNeutralNum : null;
  const wrongDir = isEquityWrongDir(currentPE?.value, diff);
  const isNeutral = diff != null && Math.abs(diff) < 1 && !wrongDir;
  const badgeCol = isNeutral ? "var(--t2)" : eqCol;
  const badgeHtml = diff != null
    ? `<span class="num" style="color:${badgeCol};font-size:11px;font-weight:500;">${diff > 0 ? "+" : ""}${fmt(diff, 2)}%</span>`
    : "";

  const boxClass = inDrawer
    ? 'class="dr-card dr-pad dr-summary-box" style="position:relative; z-index:1; border-radius:0 12px 12px 12px; margin-bottom:0;"'
    : 'class="dr-card dr-pad dr-sec dr-summary-box"';
  return `<div ${boxClass}>
    <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl">持仓总额</div><div class="dr-val" style="color:var(--accent); font-weight:600;">${totalStr}</div></div>
    <div class="dr-summary-item" style="flex:1;border-left:1px solid var(--bd2); border-right:1px solid var(--bd2); padding:0 4px;"><div class="dr-lbl">当前权益</div><div style="display:flex;align-items:baseline;justify-content:center;gap:3px;"><span class="dr-val" style="color:${eqCol}; font-weight:600;">${curEqStr}</span>${badgeHtml}</div></div>
    <div class="dr-summary-item" style="flex:1;"><div class="dr-lbl">目标权益</div><div class="dr-val" style="font-weight:600;">${targetStr}</div></div>
  </div>`;
}

function UI_renderHoldingDrawerBody(
  activeProds,
  holdings,
  equityMap,
  shortNameMap,
  getNavFn,
  eqData,
  currentPE,
  targetEqNeutral,
  lastResults,
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
        <div>产品简称</div><div style="display:flex;justify-content:flex-end;">今日涨跌</div><div style="display:flex;justify-content:flex-end;">持仓占比</div><div style="display:flex;justify-content:flex-end;">持仓金额(¥)</div>
      </div>`;

  activeProds.forEach((p, idx) => {
    const shares = holdings[p.code] || 0;
    const nav = getNavFn(p.code) || 0;
    const val = shares * nav;
    const ratioStr =
      eqData && eqData.total > 0
        ? fmt((val / eqData.total) * 100, 1) + "%"
        : "--";

    const fetchedResult = lastResults.find((r) => r.code === p.code);
    let profitAmt = null;
    if (fetchedResult && shares > 0 && nav > 0) {
      const offD = fetchedResult.offDate
        ? fetchedResult.offDate.slice(0, 10)
        : "";
      const estD = fetchedResult.estTime
        ? fetchedResult.estTime.slice(0, 10)
        : "";
      const isOfficialUpdated = fetchedResult.offVal && (!estD || offD >= estD);
      const activePct = isOfficialUpdated
        ? fetchedResult.offPct
        : fetchedResult.estPct;

      let yestNav = null;
      if (fetchedResult.baseNav && fetchedResult.baseDate) {
        yestNav = fetchedResult.baseNav;
      } else if (activePct != null && !isNaN(activePct)) {
        yestNav = nav / (1 + activePct / 100);
      }

      if (yestNav) profitAmt = shares * (nav - yestNav);
    }

    const pnlCls = profitAmt > 0 ? "up" : profitAmt < 0 ? "down" : "flat";
    const pnlTxt =
      profitAmt != null
        ? (profitAmt > 0 ? "+" : "") + profitAmt.toFixed(2)
        : "--";

    html += `
      <div style="${gridDet} align-items:center; padding:7px 12px; ${idx === activeProds.length - 1 ? "" : "border-bottom:1px solid var(--bd);"}">
        <div style="font-family:var(--f-zh); font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        <div style="display:flex;justify-content:flex-end;font-size:13px;font-weight:600;" class="num ${pnlCls}">${pnlTxt}</div>
        <div class="num" style="display:flex;justify-content:flex-end;font-size:13px;font-weight:400;color:var(--t2)">${ratioStr}</div>
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

    const fetchedResult = lastResults.find((r) => r.code === p.code);

    html += `
      <div style="${gridStyle} align-items:center; padding:8px 12px; ${idx === activeProds.length - 1 ? "" : "border-bottom:1px dashed var(--bd2);"}">
        <div style="min-width:0;"><input id="sn_${p.code}" type="text" class="dr-input-ghost" style="width:100%; font-family:var(--f-zh); font-size:13px; font-weight:600;" value="${shortNameMap[p.code] || ""}" placeholder="${fetchedResult?.name || NAMES[p.code] || p.code}"></div>

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
  html += `</div></div></div>
  <div style="display:flex;gap:10px;margin-top:12px">
    <button onclick="exportToken()" style="flex:1;padding:8px 12px;border-radius:10px;border:1px solid var(--bd2);background:var(--bg3);color:var(--t2);font-family:var(--f-zh);font-size:13px;font-weight:500;cursor:pointer;">🔑 导出</button>
    <button onclick="importToken()" style="flex:1;padding:8px 12px;border-radius:10px;border:1px solid var(--bd2);background:var(--bg3);color:var(--t2);font-family:var(--f-zh);font-size:13px;font-weight:500;cursor:pointer;">📥 恢复</button>
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

  const diff = eqData.equity - targetEqNeutral;
  if (Math.abs(diff) < 0.01) return "";

  let html = "";
  if (diff < 0) {
    // 增权预研 - 使用 interact.js 传入的 buyDraft
    if (!buyDraft) return "";
    const diffPct = Math.abs(diff);
    const friction = buyDraft.totalFriction || 0;

    html += `
    <div style="margin: 10px 0;">
      <div style="display:inline-block; background:var(--buy-bg); border:1px solid var(--buy-bd); border-bottom:none; color:var(--buy); font-size:13px; font-weight:600; padding:6px 14px; border-radius:8px 8px 0 0; font-family:var(--f-zh); margin-bottom:-1px; position:relative; z-index:2;">⬆ 增权预研</div>
      <div class="dr-card" style="position:relative; z-index:1; border-radius:0 12px 12px 12px; border:1px solid var(--buy-bd); background:var(--bg3); padding:12px;">
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); text-align:center; gap:8px; margin-bottom:10px;">
          <div class="dr-col" style="align-items:center;"><div class="dr-lbl" style="margin-bottom:2px;">当前权益</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${fmt(eqData.equity, 2)}%</div></div>
          <div class="dr-col" style="align-items:center;"><div class="dr-lbl" style="margin-bottom:2px;">触发后目标</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${buyDraft.targetEq}%</div></div>
          <div class="dr-col" style="align-items:center;"><div class="dr-lbl" style="margin-bottom:2px;">需要增权</div><div class="num" style="color:var(--buy); font-size:16px; font-weight:600;">${fmt(buyDraft.targetEq - eqData.equity, 2)}%</div></div>
        </div>

        <div class="dr-lbl" style="margin-bottom:6px; font-family:var(--f-zh);">资金调配 (固定转出)</div>
        <div style="background:var(--bg2); border:1px solid var(--bd); border-radius:8px; padding:8px 12px; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-family:var(--f-zh); color:var(--t1); font-weight:500; font-size:13px;">转出 ${getProductName(SYS_CONFIG.CODE_XQ)}</div>
          <div class="num" style="color:var(--buy); font-size:15px; font-weight:600;">${fmt(buyDraft.sellXqShares, 2)} <span style="font-size:11px; color:var(--t2); margin-left:2px; font-weight:400;">份</span> <span style="color:var(--buy); font-size:12px; margin-left:8px; font-weight:500; background:var(--buy-dim); padding:3px 6px; border-radius:4px;">增权 ${fmt(diffPct, 2)}%</span></div>
        </div>

        <div style="text-align:center; margin-top:10px; font-size:13px; font-family:var(--f-zh); color:var(--t2);">
          调配总金额 <span class="num" style="font-weight:600; border-bottom:1px dashed var(--bd2); padding-bottom:2px; font-size:14px; color:var(--t1); margin-right:16px;">${fmt(buyDraft.buyAmt, 2)}</span>
          交易磨损 <span class="num" style="font-weight:600; border-bottom:1px dashed var(--bd2); padding-bottom:2px; color:var(--warn); font-size:14px;">${fmt(friction, 2)}</span>
        </div>
      </div>
    </div>`;
  } else {
    // 降权预案 - 使用 interact.js 传入的 sellDraft
    if (!sellDraft || sellDraft.error) return "";

    html += `
    <div style="margin: 10px 0;">
      <div style="display:inline-block; background:var(--sell-bg); border:1px solid var(--sell-bd); border-bottom:none; color:var(--sell); font-size:13px; font-weight:600; padding:6px 14px; border-radius:8px 8px 0 0; font-family:var(--f-zh); margin-bottom:-1px; position:relative; z-index:2;">⬇ 降权预案</div>
      <div class="dr-card" style="position:relative; z-index:1; border-radius:0 12px 12px 12px; border:1px solid var(--sell-bd); background:var(--bg3); padding:12px;">
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); text-align:center; gap:8px; margin-bottom:10px;">
          <div class="dr-col" style="align-items:center;"><div class="dr-lbl" style="margin-bottom:2px;">当前权益</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${fmt(eqData.equity, 2)}%</div></div>
          <div class="dr-col" style="align-items:center;"><div class="dr-lbl" style="margin-bottom:2px;">触发后目标</div><div class="num" style="color:var(--t2); font-size:16px; font-weight:600;">${sellDraft.targetEq}%</div></div>
          <div class="dr-col" style="align-items:center;"><div class="dr-lbl" style="margin-bottom:2px;">需要降权</div><div class="num" style="color:var(--sell); font-size:16px; font-weight:600;">${fmt(eqData.equity - sellDraft.targetEq, 2)}%</div></div>
        </div>

        <div class="dr-lbl" style="margin-bottom:6px; font-family:var(--f-zh);">资金调配 (按权重转出)</div>
        <div style="display:flex; flex-direction:column; gap:6px;">`;

    activeProds.forEach((p) => {
      const res = sellDraft.results?.[p.code];
      if (res && res.amt > 0) {
        html += `
          <div style="background:var(--bg2); border:1px solid var(--bd); border-radius:8px; padding:8px 12px; display:flex; justify-content:space-between; align-items:center;">
            <div style="font-family:var(--f-zh); color:var(--t1); font-size:13px;"><span style="font-weight:400;">转出</span> <span style="font-weight:600;">${p.name}</span></div>
            <div style="display:flex; align-items:center;"><span class="num" style="color:var(--sell); font-size:15px; font-weight:600;">${fmt(res.shares, 2)}</span><span style="font-size:11px; color:var(--t2); font-weight:400; margin-left:3px;">份</span><span class="num" style="color:var(--sell); font-size:12px; font-weight:500; background:var(--sell-dim); padding:3px 6px; border-radius:4px; margin-left:14px;">降权 ${fmt(res.eqDropPct, 2)}%</span></div>
          </div>`;
      }
    });

    if (!sellDraft.hasAnySell) {
      html += `<div style="text-align:center; color:var(--t3); font-size:13px; padding:12px 0; background:var(--bg2); border-radius:8px; border:1px dashed var(--bd2);">请在下方配置中输入比例或设为优先卖出</div>`;
    }

    html += `
        </div>
        <div style="text-align:center; margin-top:10px; font-size:13px; font-family:var(--f-zh); color:var(--t2);">
          调配总金额 <span class="num" style="font-weight:600; border-bottom:1px dashed var(--bd2); padding-bottom:2px; font-size:14px; color:var(--t1); margin-right:16px;">${fmt(sellDraft.totalCashOut + sellDraft.totalFriction, 2)}</span>
          交易磨损 <span class="num" style="font-weight:600; border-bottom:1px dashed var(--bd2); padding-bottom:2px; color:var(--warn); font-size:14px;">${fmt(sellDraft.totalFriction, 2)}</span>
        </div>
      </div>
    </div>`;
  }
  return html;
}

// ============================================================
// DOM 渲染器 (DOM Renderers)
// ============================================================

function updateClock() {
  const n = new Date();
  document.getElementById("liveTime").textContent = [
    n.getHours(),
    n.getMinutes(),
    n.getSeconds(),
  ]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
  document.getElementById("liveDate").textContent =
    `${n.getFullYear()}/${String(n.getMonth() + 1).padStart(2, "0")}/${String(n.getDate()).padStart(2, "0")} ${DAYS[n.getDay()]}`;
  const state = getMarketState();
  if (state !== _mktState) {
    _mktState = state;
    document.getElementById("mktDot").className =
      "mkt-dot" + (state === "TRADING" ? " open" : "");
    const labels = {
      WEEKEND: "休市·周末",
      BEFORE_PRE: "盘前",
      PRE_MARKET: "盘前集合",
      TRADING: "交易中",
      MID_BREAK: "午休",
      POST_MARKET: "已收盘",
    };
    document.getElementById("mktLabel").textContent = labels[state] || "待机";
  }
}

function calcFlash(results) {
  const fl = {};
  results.forEach((f) => {
    if (f.error) {
      fl[f.code] = { ef: "", of2: "" };
      return;
    }
    const pr = prevData[f.code];
    fl[f.code] = {
      ef:
        pr && pr.estPct !== f.estPct && f.estPct != null
          ? f.estPct > pr.estPct
            ? "flash-up"
            : "flash-down"
          : "",
      of2:
        pr && pr.offPct !== f.offPct && f.offPct != null
          ? f.offPct > pr.offPct
            ? "flash-up"
            : "flash-down"
          : "",
    };
    prevData[f.code] = { estPct: f.estPct, offPct: f.offPct };
  });
  return fl;
}

function renderIndices(map) {
  if (!map || Object.keys(map).length === 0) return;
  document.getElementById("idxBar").innerHTML = INDICES.map((idx) => {
    const d = map[idx.id];
    if (!d || !d.f2)
      return `<div class="idx-cell"><div class="idx-lbl">${idx.lbl}</div><div class="idx-row"><div class="idx-chg flat">—</div></div></div>`;
    const price = typeof d.f2 === "number" ? d.f2.toFixed(2) : String(d.f2);
    const pct = d.f3 ?? 0,
      cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat",
      sign = pct > 0 ? "+" : "";
    const old = idxPrev[idx.id];
    const flash =
      old && old !== price
        ? parseFloat(price) > parseFloat(old)
          ? "flash-up"
          : "flash-down"
        : "";
    idxPrev[idx.id] = price;
    return `<div class="idx-cell ${cls} ${flash}"><div class="idx-lbl">${idx.lbl}</div><div class="idx-row"><div class="idx-chg ${cls}">${sign}${typeof pct === "number" ? pct.toFixed(2) : pct}%</div><div class="idx-price">${price}</div></div></div>`;
  }).join("");
}

function updatePeBar() {
  if (!_peDOMReady) {
    _peDOM.display = document.getElementById("peDisplay");
    _peDOM.status = document.getElementById("peStatus");
    _peDOM.marker = document.getElementById("peTrackMarker");
    _peDOM.eqDiv = document.getElementById("peEquityInfo");
    _peDOM.loEl = document.getElementById("peTrackLo");
    _peDOM.hiEl = document.getElementById("peTrackHi");
    _peDOMReady = true;
  }

  const peData = loadPe();
  // 修复问题2：通过 getIndices() 获取沪深300实时价格，不直接读 data.js 的全局变量
  const rt300Price = getIndices()["000300"]?.f2 ?? null;
  const currentPE = getCurrentPE(peData, rt300Price);

  if (!currentPE) {
    _peDOM.display.textContent = "--.--%";
    _peDOM.display.className = "pe-value pe-normal";
    _peDOM.status.textContent = "未输入PE";
    _peDOM.status.className = "pe-status normal";
    [_peDOM.marker, _peDOM.loEl, _peDOM.hiEl, _peDOM.eqDiv].forEach((el) => {
      if (el) el.style.display = "none";
    });
    return;
  }

  const { value: v, isDynamic, bounds } = currentPE;
  _peDOM.display.innerHTML = `<span class="num">${v.toFixed(2)}%</span>${isDynamic ? `<span style="font-size:10px;color:var(--accent);font-weight:600;margin-left:4px;vertical-align:top">实时</span>` : ""}`;

  const span = (bounds.sellPct - bounds.buyPct) * 2;
  const peMin = (bounds.buyPct + bounds.sellPct) / 2 - span / 2;
  const toPos = (pe) =>
    Math.min(Math.max(((pe - peMin) / span) * 100, 0), 100) + "%";

  if (_peDOM.marker) {
    _peDOM.marker.style.display = "block";
    _peDOM.marker.style.left = toPos(v);
  }
  if (_peDOM.loEl) {
    _peDOM.loEl.style.display = "block";
    _peDOM.loEl.style.left = toPos(bounds.buyPct);
  }
  if (_peDOM.hiEl) {
    _peDOM.hiEl.style.display = "block";
    _peDOM.hiEl.style.left = toPos(bounds.sellPct);
  }

  if (_peDOM.eqDiv) {
    const eqData = calcCurrentEquity(
      loadHoldings(),
      getActiveProducts(),
      getNavByCode,
    );
    const target = getDynamicTarget("neutral", peData?.bucketStr);
    if (eqData && target != null) {
      const diff = eqData.equity - target,
        wrongDir = isEquityWrongDir(v, diff);
      const col = wrongDir
        ? "var(--warn)"
        : Math.abs(diff) < 1 && !wrongDir
          ? "var(--t1)"
          : diff > 0
            ? "var(--sell)"
            : "var(--buy)";
      const diffCol = (Math.abs(diff) < 1 && !wrongDir) ? "var(--t2)" : col;
      _peDOM.eqDiv.innerHTML = `权益<b class="num" style="color:${col};margin-left:2px;">${eqData.equity.toFixed(2)}%</b><span class="num" style="color:${diffCol};margin-left:2px;font-size:10px;vertical-align:baseline;">${diff > 0 ? "+" : ""}${diff.toFixed(2)}%</span><span style="display:inline-block;width:1px;height:10px;background:var(--bd2);vertical-align:middle;margin:0 2px;"></span>目标<b class="num" style="margin-left:2px;">${target}%</b>`;
      _peDOM.eqDiv.style.display = "flex";
    } else _peDOM.eqDiv.style.display = "none";
  }

  if (v <= bounds.buyPct) {
    _peDOM.display.className = "pe-value pe-danger-dn";
    _peDOM.status.textContent = "▲ 增权";
    _peDOM.status.className = "pe-status triggered-buy";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--buy)";
  } else if (v >= bounds.sellPct) {
    _peDOM.display.className = "pe-value pe-danger-up";
    _peDOM.status.textContent = "▼ 降权";
    _peDOM.status.className = "pe-status triggered-sell";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--sell)";
  } else {
    _peDOM.display.className = "pe-value pe-normal";
    _peDOM.status.textContent = "待机";
    _peDOM.status.className = "pe-status normal";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--t1)";
  }
}

function inlinePctHtml(ep, op, stale, ef, of2) {
  const opCls = stale ? "flat" : op.cls,
    staleCls = stale ? " stale-text" : "";
  if (miniMode === 0)
    return `<span class="inline-pct ${ep.cls} ${ef}">${ep.txt}</span>`;
  if (miniMode === 1)
    return `<span class="inline-pct ${opCls} ${of2}${staleCls}">${op.txt}</span>`;
  return `<span class="inline-pct"><span class="${ep.cls} ${ef}">${ep.txt}</span><span style="color:var(--t3);margin:0 3px">|</span><span class="${opCls} ${of2}${staleCls}">${op.txt}</span></span>`;
}

function buildCardInnerHtml(f, fl, today, tradingDay) {
  const dName = getDisplayName(f);
  if (f.error)
    return `<div class="card-top"><span class="drag-handle">⠿</span><div class="card-info"><div class="card-name-box"><div class="card-name" style="color:var(--t3)">${dName}</div><div class="card-code">${f.code}</div></div></div><div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div></div><div style="padding:10px 16px 14px;font-size:12px;color:var(--t3);border-top:1px solid var(--bd)">⚠ 获取超时</div>`;

  const ep = fp(f.estPct),
    op = fp(f.offPct),
    { ef, of2 } = (fl || {})[f.code] || { ef: "", of2: "" };
  const isStale =
    ((f.estTime && f.estTime.slice(0, 10) === today) || tradingDay) &&
    (!f.offDate || f.offDate.slice(0, 10) < today);

  return `<div class="card-top">
    <span class="drag-handle">⠿</span>
    <div class="card-info"><div class="card-name-box"><div class="card-name">${dName}</div><div class="card-code">${f.code}</div></div></div>
    ${inlinePctHtml(ep, op, isStale, ef, of2)}
    <div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div>
  </div>
  <div class="card-data">
    <div class="data-half"><div class="dh-label">盘中估算</div><div class="dh-pct ${ep.cls} ${ef}">${ep.txt}</div><div class="dh-meta"><span>净值 <b>${f.estVal || "--"}</b></span><span>${f.estTime ? f.estTime.slice(11, 16) : "--"}</span></div></div>
    <div class="data-half${isStale ? " stale" : ""}"><div class="dh-label">官方数据</div><div class="dh-pct ${op.cls} ${of2}">${op.txt}</div><div class="dh-meta"><span>净值 <b>${f.offVal || "--"}</b></span><span>${f.offDate ? f.offDate.slice(5) : "--"}</span></div></div>
  </div>`;
}

function renderCards(results, fl, today, tradingDay) {
  const container = document.getElementById("cardView"),
    collapsed = window.matchMedia("(max-width:767px)").matches
      ? !mobileExpanded
      : allCollapsed;
  if (
    !isStructureUnchanged(
      "cardView",
      results.map((r) => r.code),
    )
  ) {
    container.innerHTML = results
      .map((f) => {
        const cc =
          f.estPct != null && !f.error
            ? f.estPct > 0
              ? "up-card"
              : f.estPct < 0
                ? "down-card"
                : ""
            : "";
        return `<div class="fund-card ${cc}${collapsed ? " collapsed" : ""}" data-code="${f.code}">${buildCardInnerHtml(f, fl, today, tradingDay)}</div>`;
      })
      .join("");
    return;
  }
  results.forEach((f) => {
    const el = container.querySelector(`[data-code="${f.code}"]`);
    if (el) {
      el.className = `fund-card ${f.estPct != null && !f.error ? (f.estPct > 0 ? "up-card" : f.estPct < 0 ? "down-card" : "") : ""}${collapsed ? " collapsed" : ""}`;
      el.innerHTML = buildCardInnerHtml(f, fl, today, tradingDay);
    }
  });
}

function buildTableInnerHtml(f, fl, today, tradingDay) {
  const dName = getDisplayName(f);
  if (f.error)
    return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name" style="color:var(--t3)">${dName}</div><div class="tbl-code">${f.code}</div></div></td><td colspan="2" style="color:var(--t3);font-size:12px">⚠ 获取超时</td><td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;
  const ep = fp(f.estPct),
    op = fp(f.offPct),
    { ef, of2 } = (fl || {})[f.code] || { ef: "", of2: "" };
  const tblStale =
    ((f.estTime && f.estTime.slice(0, 10) === today) || tradingDay) &&
    (!f.offDate || f.offDate.slice(0, 10) < today);

  return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name">${dName}</div><div class="tbl-code">${f.code}</div></div></td>
    <td><div class="tbl-pct ${ep.cls} ${ef}">${ep.txt}</div><div class="tbl-nav">净值 <span class="nv">${f.estVal || "--"}</span></div><div class="tbl-time">${f.estTime || "--"}</div></td>
    <td><div style="${tblStale ? "opacity:0.35;filter:grayscale(1)" : ""}"><div class="tbl-pct ${op.cls} ${of2}">${op.txt}</div><div class="tbl-nav">净值 <span class="nv">${f.offVal || "--"}</span></div><div class="tbl-time">${f.offDate || "--"}</div></div></td>
    <td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;
}

function renderTable(results, fl, today, tradingDay) {
  const container = document.getElementById("fundTbody");
  if (
    !isStructureUnchanged(
      "fundTbody",
      results.map((r) => r.code),
    )
  ) {
    container.innerHTML = results
      .map((f) => {
        const cc =
          f.estPct != null && !f.error
            ? f.estPct > 0
              ? "up-row"
              : f.estPct < 0
                ? "down-row"
                : ""
            : "";
        return `<tr class="${cc}" data-code="${f.code}">${buildTableInnerHtml(f, fl, today, tradingDay)}</tr>`;
      })
      .join("");
    return;
  }
  results.forEach((f) => {
    const el = container.querySelector(`[data-code="${f.code}"]`);
    if (el) {
      el.className =
        f.estPct != null && !f.error
          ? f.estPct > 0
            ? "up-row"
            : f.estPct < 0
              ? "down-row"
              : ""
          : "";
      el.innerHTML = buildTableInnerHtml(f, fl, today, tradingDay);
    }
  });
}

function renderTodayProfit(results, mktState, todayStr) {
  const profitElMobile = _getEl("todayProfit"),
    profitElPc = _getEl("todayProfitPc");
  if (!profitElMobile && !profitElPc) return;

  const {
    totalProfit,
    totalYestVal,
    allUpdated,
    hasHoldings,
    isWaitingForOpen,
  } = calcTodayProfit(
    results,
    loadHoldings(),
    getActiveProducts(),
    mktState,
    todayStr,
  );
  let html = isWaitingForOpen ? `<span style="color:var(--t3)">-</span>` : "";

  if (!isWaitingForOpen && hasHoldings) {
    const sign = totalProfit > 0 ? "+" : "",
      cls = totalProfit > 0 ? "up" : totalProfit < 0 ? "down" : "flat";
    const pctText =
      totalYestVal > 0
        ? `(${sign}${((totalProfit / totalYestVal) * 100).toFixed(2)}%)`
        : "";
    const rightBlock = allUpdated
      ? `<span style="display:inline-flex;flex-direction:column;justify-content:center;align-items:flex-start;margin-left:6px"><span style="font-size:9px;color:var(--sell);font-weight:500;line-height:1.2;margin-bottom:1px">已更新</span><span class="num" style="font-size:11px;font-weight:600;line-height:1.2;color:var(--t2)">${pctText}</span></span>`
      : `<span class="num" style="font-size:13px;font-weight:600;margin-left:6px">${pctText}</span>`;
    html = `<span class="${cls}" style="display:flex;align-items:center">${sign}${totalProfit.toFixed(2)}</span>${rightBlock}`;
  }

  if (profitElMobile) profitElMobile.innerHTML = html;
  if (profitElPc) profitElPc.innerHTML = html;
}

// ============================================================
// 响应式订阅更新器 (Topic-based Renderers)
// ============================================================

// 1. 仅指数更新时触发 (每10秒)
function UI_updateIndices() {
  renderIndices(getIndices());
  updatePeBar(); // 沪深300变动会影响 PE 追踪点的位置
}

// 2. 本地配置(定锚/持仓)更新时触发 (手动触发)
function UI_updateLocalConfig() {
  const results = getLastResults(),
    mktState = getMarketState(),
    today = todayDateStr();
  const resultMap = new Map(results.map((r) => [r.code, r]));
  const uiResults = funds.map((c) => resultMap.get(c)).filter(Boolean);

  updatePeBar(); // 重新计算实际权益偏差
  renderTodayProfit(uiResults, mktState, today); // 持仓变了，盈亏也会变
}

// 3. 基金净值更新、或列表增删时触发 (每60秒 / 手动增删)
function UI_updateFunds() {
  const results = getLastResults();
  const fl = calcFlash(results),
    today = todayDateStr(),
    mktState = getMarketState();
  const tradingDay = mktState !== "WEEKEND" && mktState !== "BEFORE_PRE";
  const resultMap = new Map(results.map((r) => [r.code, r]));
  const uiResults = funds.map((c) => resultMap.get(c)).filter(Boolean);

  if (funds.length === 0) {
    const empty = UI_renderEmptyState();
    document.getElementById("cardView").innerHTML = empty.card;
    document.getElementById("fundTbody").innerHTML = empty.table;
  } else if (uiResults.length > 0) {
    renderCards(uiResults, fl, today, tradingDay);
    renderTable(uiResults, fl, today, tradingDay);
  }

  renderTodayProfit(uiResults, mktState, today);
  updatePeBar(); // 净值变动会导致权益市值改变

  const hasData = uiResults.length > 0;
  const chb = _getEl("cardHeaderBar");
  if (chb) chb.style.display = hasData ? "flex" : "none";
  const ppa = _getEl("pcProfitArea");
  if (ppa) ppa.style.visibility = hasData ? "visible" : "hidden";
  const mrb = _getEl("miniRefBtnPc");
  if (mrb) mrb.style.visibility = hasData ? "visible" : "hidden";
}

function toggleAllCollapse() {
  if (window.matchMedia("(max-width:767px)").matches) {
    mobileExpanded = !mobileExpanded;
    document.getElementById("colBtn").textContent = mobileExpanded ? "▴" : "▾";
  } else {
    allCollapsed = !allCollapsed;
    document.getElementById("colBtn").textContent = allCollapsed ? "▾" : "▴";
    document.body.classList.toggle("collapsed-mode", allCollapsed);
  }
  UI_updateFunds();
}

function cycleMiniMode() {
  miniMode = (miniMode + 1) % 3;
  document.getElementById("cycleBtn").textContent = miniLabels[miniMode];
  UI_updateFunds();
}
