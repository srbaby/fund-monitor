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

const SRC_LABELS = {
  tencent: "腾讯",
  eastmoney: "东财",
  sina: "新浪",
  backup: "备用",
  proxy: "代理",
  collector: "采集",
};

// 主线路不出声，只在数据不新鲜时挂两个小字。
// backup / stale 由网关给定，stale 代表网关退回了上次好数据（D-001）。
// cached / gist 是直连模式的本地/跨设备回退（D-018）——**它们本身不代表旧**：
// 收盘后沿用当日 14:59 那笔仍是当日数据，标成陈旧反而不准。故按数据自带日期判，
// 不按来源判。dataDate 取自条目的 estimateAt / officialAt，旁边 meta 行显示的就是它。
function srcTag(source, dataDate, today) {
  // 一律标注数据来源，主源也出声——源分离后「这个数字打哪来」不再是常识。
  // 代理也出声（标「代理」）：否则估算列表头恒为空，看不出"还在用代理"与"源恢复了"的区别，
  // 而估算源复活是个没有通知的事件，全靠这一格变字来发现。
  const sourceLabels = SRC_LABELS;
  if (sourceLabels[source]) {
    // 备用源与代理加 is-alt 上告警色：数字能用但打了折扣。主源保持常规灰。
    // 于是"恢复"表现为标签同时变字又变色，扫一眼就能察觉。
    const alt = source === "sina" || source === "backup" || source === "proxy";
    return `<span class="src-tag${alt ? " is-alt" : ""}">${sourceLabels[source]}</span>`;
  }
  if (source === "stale") return '<span class="src-tag is-stale">陈旧</span>';
  if ((source === "cached" || source === "gist") && dataDate && dataDate !== today)
    return '<span class="src-tag is-stale">陈旧</span>';
  return "";
}

// 数据源标签在表头出现一次，手机卡片视图则挂在卡片上方那条（#cardSrcTags）。
// **卡片视图原本刻意不挂**（D-020 C 节「手机收窄本就该少字」），D-023 改为挂——
// 手机是主力入口，而"官方净值今晚是哪一路抢先、抢到几只"恰恰是手机上最该看见的一格。
//
// 估算那列**可能混源**：代理是逐只让路的，某只估算源复活时其余仍是代理（D-020 恢复路径）。
// 故分两轮取：先找非代理的真实源，找不到才退回代理。这样任何一只恢复都能把表头顶成「腾讯」，
// 而这一格变字正是察觉"估算源活了"的唯一信号——反过来（代理优先）会把恢复整个盖住。
function renderSourceTags(results, today) {
  const pick = (srcKey, dateKey) => {
    const tagOf = (f) => srcTag(f[srcKey], f[dateKey]?.slice(0, 10), today);
    const usable = results.filter((f) => !f.error);
    for (const f of usable) {
      if (f[srcKey] === "proxy") continue;
      const tag = tagOf(f);
      if (tag) return tag;
    }
    for (const f of usable) {
      const tag = tagOf(f);
      if (tag) return tag;
    }
    return "";
  };

  const estTag = pick("estSource", "estTime");
  const offTag = pickWinnerTag(results, today, pick);

  const est = _getEl("thEstSrc"),
    off = _getEl("thOffSrc"),
    card = _getEl("cardSrcTags");
  if (est) est.innerHTML = estTag;
  if (off) off.innerHTML = offTag;
  // 手机只挂官方那格。估算源标签（当前恒为「代理」）在手机上是常态噪音——
  // 它天天挂着不变，而这一格的价值全在"变字"。桌面表头仍然保留它，
  // D-020 说的"估算源复活的唯一信号"因此没有丢，只是不在手机上抢位置。
  if (card) card.innerHTML = offTag;
}

// 官方列标签 =「今晚最早抢到的那一路 + 它抢到的只数」，例：`腾讯 2`。
// 不复用 pick()：那是为估算列写的"取第一个能出标签的"，官方列没有主次关系，
// 抽样第一只等于以偏概全。而采集器逐只记了 offAt，可以精确算。
//
// first 由**时间戳**决定而非写入顺序，所以任何设备、任何时刻读，算出来都一样。
// 采集器无数据时（未部署 / 当晚还没开始 / 盘中）offAt 全空，退回原来的源名标签。
function pickWinnerTag(results, today, pick) {
  const claimed = results.filter((f) => !f.error && f.offAt && SRC_LABELS[f.offSource]);
  if (!claimed.length) return pick("offSource", "offDate");
  const first = claimed.reduce((a, b) => (a.offAt <= b.offAt ? a : b)).offSource;
  const count = claimed.filter((f) => f.offSource === first).length;
  return `<span class="src-tag">${SRC_LABELS[first]} ${count}</span>`;
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
    <div class="data-half"><div class="dh-label">盘中估算</div><div class="dh-pct num ${ep.cls} ${ef}">${ep.txt}</div><div class="dh-meta"><span>净值 <b class="num">${f.estVal || "--"}</b></span><span class="num">${f.estTime ? f.estTime.slice(11, 16) : "--"}</span></div></div>
    <div class="data-half${isStale ? " stale" : ""}"><div class="dh-label">官方数据</div><div class="dh-pct num ${op.cls} ${of2}">${op.txt}</div><div class="dh-meta"><span>净值 <b class="num">${f.offVal || "--"}</b></span><span class="num">${f.offDate ? f.offDate.slice(5) : "--"}</span></div></div>
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
    isWaitingForData,
  } = calcTodayProfit(results, holdings, activeProds, mktState, todayStr);
  let html = isWaitingForData ? `<span style="color:var(--t3)">-</span>` : "";

  if (!isWaitingForData && hasHoldings) {
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

// LOCAL_CONFIG 频道：PE 定锚、持仓/降权预案/优先卖出变更时触发
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

// FUNDS 频道：净值刷新（每 60 秒）、或列表增删时触发
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
    // results 入库前已由 refreshData 回填代理（D-022），渲染层直接用，不再另做副本
    renderCards(uiResults, fl, today, tradingDay);
    renderTable(uiResults, fl, today, tradingDay);
    renderSourceTags(uiResults, today);
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


