// ============================================================
// ui.js - 渲染层 (v3.3 架构师重构版 - 字体排版精修)
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

const DEHYDRATION_EVENTS = `onfocus="this.value=this.value.replace(/,/g,'')" onblur="if(this.value) this.value=parseFloat(this.value.replace(/,/g,'')||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})"`;

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
function getDisplayName(fundItem) {
  return fundItem.name || NAMES[fundItem.code] || fundItem.code;
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
  document.getElementById("cardView").innerHTML = emptyHtml;
  document.getElementById("fundTbody").innerHTML =
    `<tr><td colspan="4" style="background:transparent; border:none; padding:0;">${emptyHtml}</td></tr>`;
}

function UI_buildSummaryHtml(
  currentPE,
  eqData,
  targetEqStr,
  currentEqVal,
  eqCol,
  targetNeutralNum,
) {
  const totalStr = eqData ? fmtMoney(eqData.total) : "--";
  const curEqStr = currentEqVal != null ? fmt(currentEqVal, 2) + "%" : "--";

  let html = `<div class="dr-card dr-pad dr-sec dr-summary-box">
    <div class="dr-summary-item" style="flex: 1.25; padding-right: 8px;">
      <div class="dr-lbl">持仓总额</div>
      <div class="dr-val-lg" style="color:var(--accent); letter-spacing: -0.5px;">${totalStr}</div>
    </div>
    <div class="dr-summary-item" style="flex: 0.85; border-left:1px solid var(--bd2); border-right:1px solid var(--bd2); padding:0 8px;">
      <div class="dr-lbl">当前权益</div>
      <div class="dr-val-lg" style="color:${eqCol};">${curEqStr}</div>
    </div>
    <div class="dr-summary-item" style="flex: 1.1; padding-left: 8px;">`;

  if (targetEqStr != null && typeof targetEqStr === "string") {
    // [架构师优化]：彻底剥离 dr-val-lg 的强制干预，将控制权交还给传入的 targetEqStr
    html += `<div class="dr-lbl">预案状态</div>
      <div style="display:flex;align-items:center;justify-content:center;width:100%;margin-top:2px;">
        ${targetEqStr}
      </div>
    </div></div>`;
  } else {
    const targetStr = targetNeutralNum != null ? targetNeutralNum + "%" : "--";
    const diff =
      eqData && targetNeutralNum != null
        ? eqData.equity - targetNeutralNum
        : null;
    const wrongDir = isEquityWrongDir(currentPE?.value, diff);
    const isNeutral = diff != null && Math.abs(diff) < 1 && !wrongDir;
    const bBg = wrongDir
      ? "var(--up-dim)"
      : isNeutral
        ? "transparent"
        : diff > 0
          ? "var(--sell-bg)"
          : "var(--buy-bg)";
    const bBd = wrongDir
      ? "var(--up-bd)"
      : isNeutral
        ? "var(--bd2)"
        : diff > 0
          ? "var(--sell-bd)"
          : "var(--buy-bd)";

    html += `<div class="dr-lbl">目标权益</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:4px;">
        <span class="dr-val-lg">${targetStr}</span>
        ${diff != null ? `<span class="dr-badge" style="color:${eqCol};background:${bBg};border-color:${bBd}; padding: 1px 4px;">${diff > 0 ? "+" : ""}${fmt(diff, 2)}%</span>` : ""}
      </div>
    </div></div>`;
  }
  return html;
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

  let html =
    `<div class="dr-header"><span class="dr-tag">📊 权益校对汇总</span></div>` +
    UI_buildSummaryHtml(
      currentPE,
      eqData,
      null,
      eqData?.equity,
      diffCol,
      targetEqNeutral,
    );

  const eqAmtStr = eqData
    ? fmtMoney((eqData.total * eqData.equity) / 100)
    : "--";

  html += `
  <div class="dr-sec">
    <div class="dr-header"><span class="dr-tag">📋 资产价值明细</span><span class="dr-lbl">权益总额 <span class="dr-val-md" style="color:var(--accent);">${eqAmtStr}</span></span></div>
    <div class="dr-card" style="padding:4px 0">
      <div class="dr-grid-holding" style="padding:10px 16px; border-bottom:1px solid var(--bd2);">
        <div class="dr-lbl">产品</div><div class="dr-lbl" style="text-align:right;">市值(¥)</div><div class="dr-lbl" style="text-align:right;">权益档</div><div class="dr-lbl" style="text-align:right;">权益金额(¥)</div>
      </div>`;

  activeProds.forEach((p, idx) => {
    const val = (holdings[p.code] || 0) * (getNavFn(p.code) || 0);
    html += `
      <div class="dr-grid-holding" style="align-items:center; padding:14px 16px; ${idx === activeProds.length - 1 ? "" : "border-bottom:1px solid var(--bd);"}">
        <div class="dr-item-name">${p.name}</div>
        <div class="dr-val-sm" style="text-align:right; color:var(--t2)">${val ? fmt(val, 2) : "--"}</div>
        <div style="text-align:right;"><span class="dr-badge gray">${fmt(p.equity, 2)}</span></div>
        <div class="dr-val-sm" style="text-align:right; color:var(--accent);">${val && p.equity > 0 ? fmt(val * p.equity, 2) : p.equity === 0 ? "0.00" : "--"}</div>
      </div>`;
  });
  html += `</div></div>`;

  html += `
  <div class="dr-sec">
    <div class="dr-header"><span class="dr-tag">⚙️ 持仓配置</span></div>
    <div class="dr-card">
      <div class="dr-grid-holding" style="padding:10px 16px; border-bottom:1px solid var(--bd); background:var(--bg4);">
        <div class="dr-lbl">产品</div><div class="dr-lbl" style="text-align:right;">代码</div><div class="dr-lbl" style="text-align:right;">权益档</div><div class="dr-lbl" style="text-align:right;">份额</div>
      </div><div class="dr-col" style="gap:0;">`;

  activeProds.forEach((p, idx) => {
    const fetchedResult = lastResults.find((r) => r.code === p.code);
    html += `
      <div class="dr-grid-holding" style="align-items:center; padding:14px 16px; ${idx === activeProds.length - 1 ? "" : "border-bottom:1px dashed var(--bd2);"}">
        <div style="min-width:0;"><input id="sn_${p.code}" type="text" maxlength="10" class="dr-input-ghost dr-item-name" style="width:100%;" value="${shortNameMap[p.code] || ""}" placeholder="${fetchedResult?.name || NAMES[p.code] || p.code}"></div>
        <div style="text-align:right;"><span class="dr-badge gray" style="font-size:11px;">${p.code}</span></div>
        <div style="min-width:0;"><input id="eq_${p.code}" type="text" inputmode="decimal" class="dr-input-ghost dr-val-md" style="width:100%; text-align:right; color:var(--accent);" value="${fmt(equityMap[p.code] != null ? equityMap[p.code] : p.equity, 2)}" placeholder="0.00" ${DEHYDRATION_EVENTS}></div>
        <div style="min-width:0;"><input id="hi_${p.code}" type="text" inputmode="decimal" class="dr-input-ghost dr-val-md" style="width:100%; text-align:right;" value="${holdings[p.code] > 0 ? fmt(holdings[p.code], 2) : ""}" placeholder="0.00" ${DEHYDRATION_EVENTS}></div>
      </div>`;
  });
  html += `</div></div></div>
  <div style="display:flex;gap:10px;margin-top:24px">
    <button onclick="exportToken()" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--bd2);background:var(--bg3);color:var(--t2);font-size:14px;font-weight:500;cursor:pointer;">🔑 导出</button>
    <button onclick="importToken()" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--bd2);background:var(--bg3);color:var(--t2);font-size:14px;font-weight:500;cursor:pointer;">📥 恢复</button>
  </div>`;

  return html;
}

function UI_renderPlanDrawerBody(
  currentPE,
  buyData,
  holdings,
  activeProds,
  getNavFn,
  savedPlan,
  priorityCode,
  targetEqNeutral,
) {
  const equityProducts = activeProds.filter((p) => p.equity > 0);
  const diff = buyData.currentEq - targetEqNeutral,
    wrongDir = isEquityWrongDir(currentPE?.value, diff),
    isNeutral = Math.abs(diff) < 1 && !wrongDir;
  const curEqCol = wrongDir
    ? "var(--warn)"
    : isNeutral
      ? "var(--t1)"
      : diff > 0
        ? "var(--sell)"
        : "var(--buy)";

  // [架构师优化]：精准设置状态中文字体栈(--f-zh)与16px字号，匹配18px数字的视觉体量
  let activeAction = "none",
    planStatusHtml = '<span style="font-family:var(--f-zh); font-size:16px; font-weight:600; color:var(--t1);">待机</span>';

  if (currentPE?.bounds) {
    if (currentPE.value <= currentPE.bounds.buyPct) {
      activeAction = "buy";
      planStatusHtml = '<span style="font-family:var(--f-zh); font-size:16px; font-weight:600; color:var(--buy);">▲ 增权</span>';
    } else if (currentPE.value >= currentPE.bounds.sellPct) {
      activeAction = "sell";
      planStatusHtml = '<span style="font-family:var(--f-zh); font-size:16px; font-weight:600; color:var(--sell);">▼ 降权</span>';
    }
  }

  if (activeAction === "none" && !isNeutral) {
    if (diff > 0) {
      activeAction = "sell";
      planStatusHtml = '<span style="font-family:var(--f-zh); font-size:16px; font-weight:600; color:var(--sell);">▼ 降权</span>';
    } else if (diff < 0) {
      activeAction = "buy";
      planStatusHtml = '<span style="font-family:var(--f-zh); font-size:16px; font-weight:600; color:var(--buy);">▲ 增权</span>';
    }
  }

  const actSty = "transition:all 0.3s ease;",
    inactSty = "opacity:0.4; filter:grayscale(1); pointer-events:none; transition:all 0.3s ease;";

  let html = UI_buildSummaryHtml(
    currentPE,
    { total: buyData.totalVal },
    planStatusHtml,
    buyData.currentEq,
    curEqCol,
    targetEqNeutral,
  );

  html += `
  <div class="dr-sec" style="${activeAction === "sell" || activeAction === "none" ? inactSty : actSty}">
    <div class="dr-header"><span class="dr-tag buy">▲ 增权预案评估</span></div>
    <div class="dr-card dr-pad" style="background:var(--buy-bg);border-color:var(--buy-bd);">
      <div class="dr-flex" style="margin-bottom:16px;">
        <div class="dr-col" style="align-items:flex-start;"><div class="dr-lbl">当前权益</div><div class="dr-val-md" style="color:${curEqCol};">${fmt(buyData.currentEq, 2)}%</div></div>
        <div class="dr-col" style="align-items:center;"><div class="dr-lbl">触发后目标</div><div class="dr-val-md" style="color:var(--buy);">${buyData.targetEq}%</div></div>
        <div class="dr-col" style="align-items:flex-end;"><div class="dr-lbl">需调配金额</div><div class="dr-val-md" style="color:var(--buy);">${fmtMoney(buyData.buyAmt)}</div></div>
      </div>
      <div class="dr-lbl" style="margin-bottom:6px">资金筹集 (转出 ${getProductName(SYS_CONFIG.CODE_XQ)})</div>
      <div class="dr-plan-box sell" style="margin-bottom:16px; background:rgba(0,0,0,0.1);">
        <div class="dr-item-name" style="font-weight:400;">转出份数</div><div class="dr-val-lg" style="color:var(--up);">${fmt(buyData.sellXqShares, 2)} <span class="dr-lbl">份</span></div>
      </div>
      <div class="dr-lbl" style="margin-bottom:6px">目标分配 (优先A500C，溢出至中证500C)</div><div class="dr-col" style="gap:8px;">
        <div class="dr-plan-box" style="background:rgba(255,255,255,0.03);"><div class="dr-item-name" style="font-weight:400;">转入 A500C</div><div class="dr-val-lg" style="color:var(--buy);">${fmtMoney(buyData.allocA500C)}</div></div>
        ${buyData.allocZZ500C > 1 ? `<div class="dr-plan-box" style="background:rgba(255,255,255,0.03);"><div class="dr-item-name" style="font-weight:400;">转入 中证500C</div><div class="dr-val-lg" style="color:var(--buy);">${fmtMoney(buyData.allocZZ500C)}</div></div>` : ""}
      </div>
    </div>
  </div>`;

  html += `
  <div style="${activeAction === "buy" || activeAction === "none" ? inactSty : actSty}">
    <div class="dr-header"><span class="dr-tag sell">▼ 降权预案评估</span></div>
    <div class="dr-card dr-pad" style="background:var(--up-dim);border-color:var(--up-bg);">
      <div id="sell_summary_area"></div><div class="dr-lbl" style="margin-bottom:12px">配置减仓比例（空=不参与），摩擦费率 ${fmt(SYS_CONFIG.FEE * 100, 1)}%</div>`;

  equityProducts.forEach((p) => {
    const isPri = priorityCode === p.code,
      shares = holdings[p.code] || 0;
    const nav = getNavFn(p.code);
    const holdingVal = nav ? shares * nav : 0;
    const holdingValStr = holdingVal ? fmtMoney(holdingVal) : "--";

    html += `
    <div class="dr-card dr-pad" style="margin-bottom:10px;">
      <div style="display:grid; grid-template-columns: 200px 1fr; gap:8px; align-items:center; margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <div class="dr-item-name" style="width:85px; flex-shrink:0;">${p.name}</div>
          <span class="dr-badge gray">${fmt(p.equity, 2)}</span>
        </div>
        <div id="sell_calc_shares_${p.code}" class="dr-val-sm" style="color:var(--t3); text-align:left;">-- <span class="dr-lbl">份</span></div>

        <div class="dr-lbl" style="white-space:nowrap;">
          <span class="num" style="color:var(--t1)">${fmt(shares, 2)}</span> 份
          <span style="color:var(--bd2);margin:0 4px">|</span>
          <span class="num" style="color:var(--t1)">${holdingValStr}</span>
        </div>
        <div id="sell_calc_fiat_${p.code}" class="dr-val-sm" style="color:var(--t3); white-space:nowrap; text-align:left;">-- 元</div>
      </div>
      <div class="dr-flex" style="padding-top:12px; border-top:1px dashed var(--bd2);">
        <button class="pri-btn ${isPri ? "active" : ""}" data-code="${p.code}" onclick="togglePrioritySell('${p.code}')">${isPri ? "★ 优先" : "☆ 优先"}</button>
        <div style="display:flex;align-items:center;gap:10px"><span class="dr-lbl">减仓权重</span>
          <input type="tel" style="width:60px;height:30px;background:var(--bg);border:1px solid var(--bd2);border-radius:6px;color:var(--t1);text-align:center;font-family:var(--f-num);font-size:15px;outline:none;font-weight:500;" id="ratio_${p.code}" value="${savedPlan[p.code] || ""}" oninput="calcSellPreview()">
        </div>
      </div>
    </div>`;
  });

  html += `<div class="dr-card dr-pad" style="margin-top:14px;" id="sell_preview_result"><span class="dr-lbl">等待输入比例...</span></div></div></div>`;
  return html;
}

function UI_updateSellPreview(
  draft,
  equityProducts,
  currentPE,
  targetEqNeutral,
) {
  const summaryEl = document.getElementById("sell_summary_area");
  if (summaryEl && !draft.error) {
    const diff = draft.currentEq - targetEqNeutral,
      wrongDir = isEquityWrongDir(currentPE?.value, diff);
    const curEqCol = wrongDir
      ? "var(--warn)"
      : Math.abs(diff) < 1 && !wrongDir
        ? "var(--t1)"
        : diff > 0
          ? "var(--sell)"
          : "var(--buy)";
    summaryEl.innerHTML = `
    <div class="dr-flex" style="margin-bottom:16px;">
      <div class="dr-col" style="align-items:flex-start;"><div class="dr-lbl">当前权益</div><div class="dr-val-md" style="color:${curEqCol};">${fmt(draft.currentEq, 2)}%</div></div>
      <div class="dr-col" style="align-items:center;"><div class="dr-lbl">触发后目标</div><div class="dr-val-md" style="color:var(--warn);">${draft.targetEq}%</div></div>
      <div class="dr-col" style="align-items:flex-end;"><div class="dr-lbl">需减比例</div><div class="dr-val-md" style="color:var(--sell);">${fmt(draft.diffEqPct, 2)}%</div></div>
    </div>`;
  }

  equityProducts.forEach((p) => {
    const res = draft.results?.[p.code],
      elS = document.getElementById("sell_calc_shares_" + p.code),
      elF = document.getElementById("sell_calc_fiat_" + p.code);
    if (res && res.amt > 0) {
      if (elS)
        elS.innerHTML = `<span class="dr-val-md" style="color:var(--up);">${fmt(res.shares, 2)}</span> <span class="dr-lbl">份</span>`;
      if (elF)
        elF.innerHTML = `<span class="dr-lbl" style="color:var(--sell);margin-right:4px;">降权 ${fmt(res.eqDropPct, 2)}%</span> <span class="dr-val-sm">${fmtMoney(res.amt)}</span>`;
    } else {
      if (elS)
        elS.innerHTML = `-- <span class="dr-lbl">份</span>`;
      if (elF) elF.innerHTML = `-- 元`;
    }
  });

  const resultEl = document.getElementById("sell_preview_result");
  if (resultEl) {
    resultEl.innerHTML = draft.hasAnySell
      ? `
      <div class="dr-flex">
        <div class="dr-col" style="align-items:flex-start;"><div class="dr-lbl">操作后权益</div><div class="dr-val-lg" style="color:var(--dn);">${fmt(draft.afterEqPct, 2)}%</div></div>
        <div class="dr-col" style="align-items:center;"><div class="dr-lbl">转出到账</div><div class="dr-val-lg">${fmtMoney(draft.totalCashOut)}</div></div>
        <div class="dr-col" style="align-items:flex-end;"><div class="dr-lbl">总摩擦</div><div class="dr-val-lg" style="color:var(--warn);">${fmtMoney(draft.totalFriction)}</div></div>
      </div>`
      : `<span class="dr-lbl">请填写比例或设为优先卖出</span>`;
  }
}

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
  const flashMap = {};
  results.forEach((fundItem) => {
    if (fundItem.error) {
      flashMap[fundItem.code] = { estFlashClass: "", offFlashClass: "" };
      return;
    }
    const prevRecord = prevData[fundItem.code];
    flashMap[fundItem.code] = {
      estFlashClass:
        prevRecord && prevRecord.estPct !== fundItem.estPct && fundItem.estPct != null
          ? fundItem.estPct > prevRecord.estPct
            ? "flash-up"
            : "flash-down"
          : "",
      offFlashClass:
        prevRecord && prevRecord.offPct !== fundItem.offPct && fundItem.offPct != null
          ? fundItem.offPct > prevRecord.offPct
            ? "flash-up"
            : "flash-down"
          : "",
    };
    prevData[fundItem.code] = { estPct: fundItem.estPct, offPct: fundItem.offPct };
  });
  return flashMap;
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
  if (!_peDOM.display) {
    _peDOM.display = document.getElementById("peDisplay");
    _peDOM.status = document.getElementById("peStatus");
    _peDOM.marker = document.getElementById("peTrackMarker");
    _peDOM.planBtn = document.getElementById("planBtn");
    _peDOM.eqDiv = document.getElementById("peEquityInfo");
    _peDOM.loEl = document.getElementById("peTrackLo");
    _peDOM.hiEl = document.getElementById("peTrackHi");
  }

  const peData = loadPe();
  const currentPE = getCurrentPE(peData, window._rt_csi300_price);

  if (!currentPE) {
    _peDOM.display.textContent = "--.--%";
    _peDOM.display.className = "pe-value pe-normal";
    _peDOM.status.textContent = "未输入PE";
    _peDOM.status.className = "pe-status normal";
    _peDOM.planBtn.className = "pe-plan-btn neutral";
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
            
      _peDOM.eqDiv.innerHTML = `实际 <b class="num" style="color:${col}; font-size:13px;">${eqData.equity.toFixed(2)}%</b> <span style="color:var(--bd2); margin:0 6px">|</span> 目标 <b class="num" style="font-size:13px;">${target}%</b> <span class="num" style="color:${col}">${diff > 0 ? "+" : ""}${diff.toFixed(2)}%</span>`;
      _peDOM.eqDiv.style.display = "flex";
    } else _peDOM.eqDiv.style.display = "none";
  }

  if (v <= bounds.buyPct) {
    _peDOM.display.className = "pe-value pe-danger-dn";
    _peDOM.status.textContent = "▲ 增权";
    _peDOM.status.className = "pe-status triggered-buy";
    _peDOM.planBtn.className = "pe-plan-btn buy";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--buy)";
  } else if (v >= bounds.sellPct) {
    _peDOM.display.className = "pe-value pe-danger-up";
    _peDOM.status.textContent = "▼ 降权";
    _peDOM.status.className = "pe-status triggered-sell";
    _peDOM.planBtn.className = "pe-plan-btn sell";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--sell)";
  } else {
    _peDOM.display.className = "pe-value pe-normal";
    _peDOM.status.textContent = "待机";
    _peDOM.status.className = "pe-status normal";
    _peDOM.planBtn.className = "pe-plan-btn neutral";
    if (_peDOM.marker) _peDOM.marker.style.background = "var(--t1)";
  }
}

function inlinePctHtml(estPayload, offPayload, isDataStale, estFlashClass, offFlashClass) {
  const offStatusClass = isDataStale ? "flat" : offPayload.cls;
  const staleTextClass = isDataStale ? " stale-text" : "";

  if (miniMode === 0)
    return `<span class="inline-pct ${estPayload.cls} ${estFlashClass}">${estPayload.txt}</span>`;
  if (miniMode === 1)
    return `<span class="inline-pct ${offStatusClass} ${offFlashClass}${staleTextClass}">${offPayload.txt}</span>`;
  return `<span class="inline-pct"><span class="${estPayload.cls} ${estFlashClass}">${estPayload.txt}</span><span style="color:var(--t3);margin:0 3px">|</span><span class="${offStatusClass} ${offFlashClass}${staleTextClass}">${offPayload.txt}</span></span>`;
}

function buildCardInnerHtml(fundItem, flashMap, today, tradingDay) {
  const displayName = getDisplayName(fundItem);
  if (fundItem.error)
    return `<div class="card-top"><span class="drag-handle">⠿</span><div class="card-info"><div class="card-name-box"><div class="card-name" style="color:var(--t3)">${displayName}</div><div class="card-code">${fundItem.code}</div></div></div><div class="card-actions"><button class="del-btn" onclick="delFund('${fundItem.code}')">删除</button></div></div><div style="padding:10px 16px 14px;font-size:12px;color:var(--t3);border-top:1px solid var(--bd)">⚠ 获取超时</div>`;

  const estPayload = fp(fundItem.estPct),
    offPayload = fp(fundItem.offPct),
    { estFlashClass, offFlashClass } = (flashMap || {})[fundItem.code] || { estFlashClass: "", offFlashClass: "" };
  const isDataStale =
    ((fundItem.estTime && fundItem.estTime.slice(0, 10) === today) || tradingDay) &&
    (!fundItem.offDate || fundItem.offDate.slice(0, 10) < today);

  return `<div class="card-top">
    <span class="drag-handle">⠿</span>
    <div class="card-info"><div class="card-name-box"><div class="card-name">${displayName}</div><div class="card-code">${fundItem.code}</div></div></div>
    ${inlinePctHtml(estPayload, offPayload, isDataStale, estFlashClass, offFlashClass)}
    <div class="card-actions"><button class="del-btn" onclick="delFund('${fundItem.code}')">删除</button></div>
  </div>
  <div class="card-data">
    <div class="data-half"><div class="dh-label">盘中估算</div><div class="dh-pct ${estPayload.cls} ${estFlashClass}">${estPayload.txt}</div><div class="dh-meta"><span>净值 <b>${fundItem.estVal || "--"}</b></span><span>${fundItem.estTime ? fundItem.estTime.slice(11, 16) : "--"}</span></div></div>
    <div class="data-half${isDataStale ? " stale" : ""}"><div class="dh-label">官方数据</div><div class="dh-pct ${offPayload.cls} ${offFlashClass}">${offPayload.txt}</div><div class="dh-meta"><span>净值 <b>${fundItem.offVal || "--"}</b></span><span>${fundItem.offDate ? fundItem.offDate.slice(5) : "--"}</span></div></div>
  </div>`;
}

function renderCards(results, flashMap, today, tradingDay) {
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
      .map((fundItem) => {
        const cardTrendClass =
          fundItem.estPct != null && !fundItem.error
            ? fundItem.estPct > 0
              ? "up-card"
              : fundItem.estPct < 0
                ? "down-card"
                : ""
            : "";
        return `<div class="fund-card ${cardTrendClass}${collapsed ? " collapsed" : ""}" data-code="${fundItem.code}">${buildCardInnerHtml(fundItem, flashMap, today, tradingDay)}</div>`;
      })
      .join("");
    return;
  }
  results.forEach((fundItem) => {
    const el = container.querySelector(`[data-code="${fundItem.code}"]`);
    if (el) {
      const cardTrendClass = fundItem.estPct != null && !fundItem.error ? (fundItem.estPct > 0 ? "up-card" : fundItem.estPct < 0 ? "down-card" : "") : "";
      el.className = `fund-card ${cardTrendClass}${collapsed ? " collapsed" : ""}`;
      el.innerHTML = buildCardInnerHtml(fundItem, flashMap, today, tradingDay);
    }
  });
}

function buildTableInnerHtml(fundItem, flashMap, today, tradingDay) {
  const displayName = getDisplayName(fundItem);
  if (fundItem.error)
    return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name" style="color:var(--t3)">${displayName}</div><div class="tbl-code">${fundItem.code}</div></div></td><td colspan="2" style="color:var(--t3);font-size:12px">⚠ 获取超时</td><td><button class="tbl-del" onclick="delFund('${fundItem.code}')">删除</button></td>`;
  const estPayload = fp(fundItem.estPct),
    offPayload = fp(fundItem.offPct),
    { estFlashClass, offFlashClass } = (flashMap || {})[fundItem.code] || { estFlashClass: "", offFlashClass: "" };
  const isTableStale =
    ((fundItem.estTime && fundItem.estTime.slice(0, 10) === today) || tradingDay) &&
    (!fundItem.offDate || fundItem.offDate.slice(0, 10) < today);

  return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name">${displayName}</div><div class="tbl-code">${fundItem.code}</div></div></td>
    <td><div class="tbl-pct ${estPayload.cls} ${estFlashClass}">${estPayload.txt}</div><div class="tbl-nav">净值 <span class="nv">${fundItem.estVal || "--"}</span></div><div class="tbl-time">${fundItem.estTime || "--"}</div></td>
    <td><div style="${isTableStale ? "opacity:0.35;filter:grayscale(1)" : ""}"><div class="tbl-pct ${offPayload.cls} ${offFlashClass}">${offPayload.txt}</div><div class="tbl-nav">净值 <span class="nv">${fundItem.offVal || "--"}</span></div><div class="tbl-time">${fundItem.offDate || "--"}</div></div></td>
    <td><button class="tbl-del" onclick="delFund('${fundItem.code}')">删除</button></td>`;
}

function renderTable(results, flashMap, today, tradingDay) {
  const container = document.getElementById("fundTbody");
  if (
    !isStructureUnchanged(
      "fundTbody",
      results.map((r) => r.code),
    )
  ) {
    container.innerHTML = results
      .map((fundItem) => {
        const cardTrendClass =
          fundItem.estPct != null && !fundItem.error
            ? fundItem.estPct > 0
              ? "up-row"
              : fundItem.estPct < 0
                ? "down-row"
                : ""
            : "";
        return `<tr class="${cardTrendClass}" data-code="${fundItem.code}">${buildTableInnerHtml(fundItem, flashMap, today, tradingDay)}</tr>`;
      })
      .join("");
    return;
  }
  results.forEach((fundItem) => {
    const el = container.querySelector(`[data-code="${fundItem.code}"]`);
    if (el) {
      el.className =
        fundItem.estPct != null && !fundItem.error
          ? fundItem.estPct > 0
            ? "up-row"
            : fundItem.estPct < 0
              ? "down-row"
              : ""
          : "";
      el.innerHTML = buildTableInnerHtml(fundItem, flashMap, today, tradingDay);
    }
  });
}

function renderTodayProfit(results, mktState, todayStr) {
  const profitElMobile = document.getElementById("todayProfit"),
    profitElPc = document.getElementById("todayProfitPc");
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

function UI_updateIndices() {
  renderIndices(getIndices());
  updatePeBar();
}

function UI_updateLocalConfig() {
  const results = getLastResults(),
    mktState = getMarketState(),
    today = todayDateStr();
  const resultMap = new Map(results.map((r) => [r.code, r]));
  const uiResults = funds.map((c) => resultMap.get(c)).filter(Boolean);

  updatePeBar();
  renderTodayProfit(uiResults, mktState, today);
}

function UI_updateFunds() {
  const results = getLastResults();
  const flashMap = calcFlash(results),
    today = todayDateStr(),
    mktState = getMarketState();
  const tradingDay = mktState !== "WEEKEND" && mktState !== "BEFORE_PRE";
  const resultMap = new Map(results.map((r) => [r.code, r]));
  const uiResults = funds.map((c) => resultMap.get(c)).filter(Boolean);

  if (funds.length === 0) {
    UI_renderEmptyState();
  } else if (uiResults.length > 0) {
    renderCards(uiResults, flashMap, today, tradingDay);
    renderTable(uiResults, flashMap, today, tradingDay);
  }

  renderTodayProfit(uiResults, mktState, today);
  updatePeBar();

  const hasData = uiResults.length > 0;
  if (document.getElementById("cardHeaderBar"))
    document.getElementById("cardHeaderBar").style.display = hasData
      ? "flex"
      : "none";
  if (document.getElementById("pcProfitArea"))
    document.getElementById("pcProfitArea").style.visibility = hasData
      ? "visible"
      : "hidden";
  if (document.getElementById("miniRefBtnPc"))
    document.getElementById("miniRefBtnPc").style.visibility = hasData
      ? "visible"
      : "hidden";
}

function toggleAllCollapse() {
  if (window.matchMedia("(max-width:767px)").matches) {
    mobileExpanded = !mobileExpanded;
    document.getElementById("colBtn").textContent = mobileExpanded
      ? "收窄"
      : "展开";
    document.getElementById("cycleBtn").style.display = mobileExpanded
      ? "none"
      : "";
  } else {
    allCollapsed = !allCollapsed;
    document.getElementById("colBtn").textContent = allCollapsed
      ? "展开"
      : "收窄";
    document.getElementById("cycleBtn").style.display = allCollapsed
      ? ""
      : "none";
    document.body.classList.toggle("collapsed-mode", allCollapsed);
  }
  UI_updateFunds();
}

function cycleMiniMode() {
  miniMode = (miniMode + 1) % 3;
  document.getElementById("cycleBtn").textContent = miniLabels[miniMode];
  UI_updateFunds();
}
