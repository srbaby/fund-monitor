// ============================================================
// ui.js - 渲染层 (v3.2 响应式与微模板版)
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
const prevData = {};
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
function getDisplayName(f) {
  return f.name || NAMES[f.code] || f.code;
}

// 备用线路的两个小字，只在整组降级时出现；主线路不出声
// 主线路不出声。备用与陈旧各自就近挂两个小字：
// 陈旧代表网关退回了上次好数据（D-001），旁边 meta 行的时间戳就是那份数据的原始时间。
function srcTag(source) {
  if (source === "backup") return '<span class="src-tag">备用</span>';
  if (source === "stale") return '<span class="src-tag is-stale">陈旧</span>';
  return "";
}

// 判断某基金结果当前应使用官方净值还是估算净值
function getActivePct(f, today, tradingDay) {
  if (f.error) return null;
  const offD = f.offDate ? f.offDate.slice(0, 10) : "",
    estD = f.estTime ? f.estTime.slice(0, 10) : "";
  const isOff = offD === today || !tradingDay || (estD && offD && offD >= estD);
  return isOff && f.offPct != null ? f.offPct : f.estPct;
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
  document.getElementById("liveDate").innerHTML =
    `<span class="num">${n.getFullYear()}/${String(n.getMonth() + 1).padStart(2, "0")}/${String(n.getDate()).padStart(2, "0")}</span> ${DAYS[n.getDay()]}`;
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

function buildCardInnerHtml(f, fl, today, tradingDay) {
  const dName = getDisplayName(f);
  if (f.error)
    return `<div class="card-top"><span class="drag-handle">⠿</span><div class="card-info"><div class="card-name-box"><div class="card-name" style="color:var(--t3)">${dName}</div><div class="card-code num">${f.code}</div></div></div><div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div></div><div style="padding:10px 16px 14px;font-size:12px;color:var(--t3);border-top:1px solid var(--bd)">⚠ 获取超时</div>`;

  const ep = fp(f.estPct),
    op = fp(f.offPct),
    { ef, of2 } = (fl || {})[f.code] || { ef: "", of2: "" };
  const isStale =
    ((f.estTime && f.estTime.slice(0, 10) === today) || tradingDay) &&
    (!f.offDate || f.offDate.slice(0, 10) < today);

  return `<div class="card-top">
    <span class="drag-handle">⠿</span>
    <div class="card-info"><div class="card-name-box"><div class="card-name">${dName}</div><div class="card-code num">${f.code}</div></div></div>
    ${inlinePctHtml(ep, op, isStale, ef, of2)}
    <div class="card-actions"><button class="del-btn" onclick="delFund('${f.code}')">删除</button></div>
  </div>
  <div class="card-data">
    <div class="data-half"><div class="dh-label">盘中估算${srcTag(f.estSource)}</div><div class="dh-pct num ${ep.cls} ${ef}">${ep.txt}</div><div class="dh-meta"><span>净值 <b class="num">${f.estVal || "--"}</b></span><span class="num">${f.estTime ? f.estTime.slice(11, 16) : "--"}</span></div></div>
    <div class="data-half${isStale ? " stale" : ""}"><div class="dh-label">官方数据${srcTag(f.offSource)}</div><div class="dh-pct num ${op.cls} ${of2}">${op.txt}</div><div class="dh-meta"><span>净值 <b class="num">${f.offVal || "--"}</b></span><span class="num">${f.offDate ? f.offDate.slice(5) : "--"}</span></div></div>
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
        const pct = getActivePct(f, today, tradingDay);
        const cc =
          pct != null ? (pct > 0 ? "up-card" : pct < 0 ? "down-card" : "") : "";
        return `<div class="fund-card ${cc}${collapsed ? " collapsed" : ""}" data-code="${f.code}">${buildCardInnerHtml(f, fl, today, tradingDay)}</div>`;
      })
      .join("");
    return;
  }
  results.forEach((f) => {
    const el = container.querySelector(`[data-code="${f.code}"]`);
    if (el) {
      const pct = getActivePct(f, today, tradingDay);
      const cc =
        pct != null ? (pct > 0 ? "up-card" : pct < 0 ? "down-card" : "") : "";
      el.className = `fund-card ${cc}${collapsed ? " collapsed" : ""}`;
      el.innerHTML = buildCardInnerHtml(f, fl, today, tradingDay);
    }
  });
}

function buildTableInnerHtml(f, fl, today, tradingDay) {
  const dName = getDisplayName(f);
  if (f.error)
    return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name" style="color:var(--t3)">${dName}</div><div class="tbl-code num">${f.code}</div></div></td><td colspan="2" style="color:var(--t3);font-size:12px">⚠ 获取超时</td><td><button class="tbl-del" onclick="delFund('${f.code}')">删除</button></td>`;
  const ep = fp(f.estPct),
    op = fp(f.offPct),
    { ef, of2 } = (fl || {})[f.code] || { ef: "", of2: "" };
  const tblStale =
    ((f.estTime && f.estTime.slice(0, 10) === today) || tradingDay) &&
    (!f.offDate || f.offDate.slice(0, 10) < today);

  return `<td><span class="tbl-drag">⠿</span><div style="display:inline-block;vertical-align:top"><div class="tbl-name">${dName}</div><div class="tbl-code num">${f.code}</div></div></td>
    <td><div class="tbl-pct num ${ep.cls} ${ef}">${ep.txt}</div><div class="tbl-nav">净值 <span class="nv num">${f.estVal || "--"}</span></div><div class="tbl-time num">${f.estTime || "--"}</div></td>
    <td><div style="${tblStale ? "opacity:0.35;filter:grayscale(1)" : ""}"><div class="tbl-pct num ${op.cls} ${of2}">${op.txt}</div><div class="tbl-nav">净值 <span class="nv num">${f.offVal || "--"}</span></div><div class="tbl-time num">${f.offDate || "--"}</div></div></td>
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
        const pct = getActivePct(f, today, tradingDay);
        const cc =
          pct != null ? (pct > 0 ? "up-row" : pct < 0 ? "down-row" : "") : "";
        return `<tr class="${cc}" data-code="${f.code}">${buildTableInnerHtml(f, fl, today, tradingDay)}</tr>`;
      })
      .join("");
    return;
  }
  results.forEach((f) => {
    const el = container.querySelector(`[data-code="${f.code}"]`);
    if (el) {
      const pct = getActivePct(f, today, tradingDay);
      el.className =
        pct != null ? (pct > 0 ? "up-row" : pct < 0 ? "down-row" : "") : "";
      el.innerHTML = buildTableInnerHtml(f, fl, today, tradingDay);
    }
  });
}

function renderTodayProfit(results, holdings, activeProds, mktState, todayStr) {
  const profitElMobile = _getEl("todayProfit"),
    profitElPc = _getEl("todayProfitPc");
  if (!profitElMobile && !profitElPc) return;

  const {
    totalProfit,
    totalYestVal,
    allUpdated,
    hasHoldings,
    isWaitingForOpen,
  } = calcTodayProfit(results, holdings, activeProds, mktState, todayStr);
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
    html = `<span class="num ${cls}" style="display:flex;align-items:center">${sign}${totalProfit.toFixed(2)}</span>${rightBlock}`;
  }

  if (profitElMobile) profitElMobile.innerHTML = html;
  if (profitElPc) profitElPc.innerHTML = html;
}

// ============================================================
// 响应式订阅更新器 (Topic-based Renderers)
// ============================================================

// 1. 仅指数更新时触发 (每10秒)
function UI_updateLocalConfig() {
  const results = getLastResults(),
    mktState = getMarketState(),
    today = todayDateStr();
  const resultMap = new Map(results.map((r) => [r.code, r]));
  const uiResults = funds.map((c) => resultMap.get(c)).filter(Boolean);

  updatePeBar();
  renderTodayProfit(
    uiResults,
    loadHoldings(),
    getActiveProducts(),
    mktState,
    today,
  );
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

  renderTodayProfit(
    uiResults,
    loadHoldings(),
    getActiveProducts(),
    mktState,
    today,
  );
  updatePeBar();

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


