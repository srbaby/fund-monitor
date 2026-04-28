// ============================================================
// interact.js - 控制器层
// 职责：接收用户操作，从 store/data 取数，调用 engine 计算，交给 ui 渲染
// ============================================================

// ---- 抽屉控制 ----
function openDrawer(id) {
  document.getElementById("drawerMask").classList.add("open");
  document.getElementById(id).classList.add("open");
}
function closeAllDrawers() {
  document.getElementById("drawerMask").classList.remove("open");
  document
    .querySelectorAll(".drawer")
    .forEach((d) => d.classList.remove("open"));
}

// ---- 公共复用模块 ----
function _buildSummaryHtml(pe, eqData, targetEq, currentEqVal, eqCol) {
  const totalStr = eqData ? fmtMoney(eqData.total) : "--";
  const curEqStr = currentEqVal != null ? fmt(currentEqVal, 2) + "%" : "--";

  let html = `<div class="dr-card dr-pad dr-sec dr-summary-box">
    <div class="dr-summary-item"><div class="dr-lbl">持仓总额</div><div class="dr-val" style="color:var(--accent); font-weight:600;">${totalStr}</div></div>
    <div class="dr-summary-item" style="border-left:1px solid var(--bd2); border-right:1px solid var(--bd2); padding:0 4px;"><div class="dr-lbl">当前权益</div><div class="dr-val" style="color:${eqCol}; font-weight:600;">${curEqStr}</div></div>
    <div class="dr-summary-item">`;

  if (targetEq != null) {
    html += `<div class="dr-lbl">预案状态</div><div class="dr-val" style="font-weight:600;">${targetEq}</div></div></div>`;
  } else {
    const targetStr = getDynamicTarget("neutral") + "%";
    const diff = eqData ? eqData.equity - getDynamicTarget("neutral") : null;
    const wrongDir = isEquityWrongDir(pe?.value, diff);
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

    html += `<div class="dr-lbl">目标权益</div><div style="display:flex;align-items:center;justify-content:center;gap:4px;"><span class="dr-val" style="font-weight:600;">${targetStr}</span>
        ${diff != null ? `<span class="dr-badge" style="color:${eqCol};background:${bBg};border-color:${bBd};font-weight:500;">${diff > 0 ? "+" : ""}${fmt(diff, 2)}%</span>` : ""}
      </div></div></div>`;
  }
  return html;
}

function _showDialog(options) {
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

// 统一的刷新按钮状态切换
function toggleRefreshBtn(isFetching) {
  ["miniRefBtn", "miniRefBtnPc"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.textContent = isFetching ? "↻" : "↻ 刷新";
      btn.disabled = isFetching;
    }
  });
}

// ---- 数据刷新 ----
let _isFetchingData = false;

async function refreshData() {
  if (_isFetchingData) return;
  _isFetchingData = true;
  toggleRefreshBtn(true);

  try {
    loadFunds();
    fetchIndices();

    if (!funds.length) {
      document.getElementById("cardView").innerHTML =
        `<div class="empty-state"><div class="empty-icon">📭</div><div>暂无关注产品，输入代码添加</div></div>`;
      document.getElementById("fundTbody").innerHTML =
        `<tr><td colspan="4" style="text-align:center;padding:50px;color:var(--t3)">暂无关注产品</td></tr>`;
      return;
    }

    const results = await Promise.all(funds.map(fetchSingleFund));
    renderAll(results);

    if (cardSortable) cardSortable.destroy();
    if (tblSortable) tblSortable.destroy();

    const onEnd = (evt) => {
      const o = Array.from(evt.to.children)
        .map((el) => el.dataset.code)
        .filter(Boolean);
      if (o.length === funds.length) {
        funds = o;
        saveFunds();
      }
    };

    cardSortable = Sortable.create(document.getElementById("cardView"), {
      handle: ".drag-handle",
      animation: 200,
      ghostClass: "sortable-ghost",
      onEnd,
    });
    tblSortable = Sortable.create(document.getElementById("fundTbody"), {
      handle: ".tbl-drag",
      animation: 200,
      ghostClass: "sortable-ghost",
      onEnd,
    });
  } finally {
    _isFetchingData = false;
    toggleRefreshBtn(false);
  }
}

// ---- 基金增删 ----
function addFund() {
  const input = document.getElementById("codeInput");
  const code = input.value.trim();
  if (/^\d{6}$/.test(code) && !funds.includes(code)) {
    funds.push(code);
    saveFunds();
    input.value = "";
    refreshData();
  } else input.value = "";
}

function delFund(code) {
  const fetchedResult = _lastResults.find((r) => r.code === code);
  const name =
    fetchedResult && !fetchedResult.error
      ? fetchedResult.name
      : NAMES[code] || code;
  if (!confirm(`确认删除「${name}」？`)) return;
  funds = funds.filter((c) => c !== code);
  saveFunds();
  refreshData();
}

// ---- 定锚弹窗 ----
function openPeModal() {
  const peData = loadPe() || {};
  document.getElementById("peModalBucket").value = peData.bucketStr || "65,70";
  document.getElementById("peModalInputPct").value = peData.peYest || "";
  document.getElementById("peModalPriceAnchor").value =
    peData.priceAnchor || "";
  document.getElementById("peModalBuyPrice").value = peData.priceBuy || "";
  document.getElementById("peModalSellPrice").value = peData.priceSell || "";
  document.getElementById("peModal").style.display = "flex";
}

function closePeModal() {
  document.getElementById("peModal").style.display = "none";
}

function confirmPe() {
  const bucketStr = document.getElementById("peModalBucket").value;
  const peYest = parseFloat(document.getElementById("peModalInputPct").value);
  const priceAnchor = parseFloat(
    document.getElementById("peModalPriceAnchor").value,
  );
  const priceBuy = parseFloat(document.getElementById("peModalBuyPrice").value);
  const priceSell = parseFloat(
    document.getElementById("peModalSellPrice").value,
  );

  if (isNaN(peYest) || isNaN(priceAnchor))
    return alert("请填写完整的【基准PE】与【基准点位】！");

  savePe({
    bucketStr,
    peYest,
    priceAnchor,
    priceBuy: isNaN(priceBuy) ? null : priceBuy,
    priceSell: isNaN(priceSell) ? null : priceSell,
  });
  updatePeBar();
  closePeModal();
}

// ---- 持仓抽屉 ----
function openHoldingDrawer() {
  const raw = _loadRaw() || {},
    holdings = raw.shares || {},
    equityMap = raw.equity || {},
    shortNameMap = raw.shortNames || {};
  const eqData = calcCurrentEquity(holdings),
    currentPE = getCurrentPE(),
    targetEq = getDynamicTarget("neutral");
  const diff = eqData && targetEq != null ? eqData.equity - targetEq : null;
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
    "display:grid; grid-template-columns: minmax(70px, 1.3fr) minmax(65px, 1fr) 52px minmax(85px, 1.2fr); gap:8px;";
  let html =
    `<div class="dr-header"><span class="dr-tag" style="font-weight:500;">📊 权益校对汇总</span></div>` +
    _buildSummaryHtml(currentPE, eqData, null, eqData?.equity, diffCol);

  const eqAmtStr = eqData
    ? fmtMoney((eqData.total * eqData.equity) / 100)
    : "--";

  html += `
  <div class="dr-sec">
    <div class="dr-header">
      <span class="dr-tag" style="font-weight:500;">📋 资产价值明细</span>
      <span class="dr-lbl">权益总额 <span class="dr-val" style="color:var(--accent);font-size:13px;font-weight:500;">${eqAmtStr}</span></span>
    </div>
    <div class="dr-card" style="padding:4px 0">
      <div style="${gridStyle} padding:8px 12px; border-bottom:1px solid var(--bd2); font-size:11px; color:var(--t3); font-weight:400;">
        <div>产品</div><div style="display:flex;justify-content:flex-end;">市值(¥)</div><div style="display:flex;justify-content:flex-end;">权益档</div><div style="display:flex;justify-content:flex-end;">权益金额(¥)</div>
      </div>`;

  const activeProds = getActiveProducts();
  activeProds.forEach((p, idx) => {
    const val = (holdings[p.code] || 0) * (getNavByCode(p.code) || 0);
    html += `
      <div style="${gridStyle} align-items:center; padding:12px; ${idx === activeProds.length - 1 ? "" : "border-bottom:1px solid var(--bd);"}">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        <div class="dr-val" style="display:flex;justify-content:flex-end;font-size:13px;font-weight:400;color:var(--t2)">${val ? fmt(val, 2) : "--"}</div>
        <div style="display:flex;justify-content:flex-end;"><span class="dr-badge gray" style="font-weight:400;">${fmt(p.equity, 2)}</span></div>
        <div class="dr-val" style="display:flex;justify-content:flex-end;font-size:13px;color:var(--accent);font-weight:400;">${val && p.equity > 0 ? fmt(val * p.equity, 2) : p.equity === 0 ? "0.00" : "--"}</div>
      </div>`;
  });
  html += `</div></div>`;

  html += `
  <div class="dr-sec">
    <div class="dr-header"><span class="dr-tag" style="font-weight:500;">⚙️ 持仓配置</span></div>
    <div class="dr-card">
      <div style="${gridStyle} padding:10px 12px; border-bottom:1px solid var(--bd); background:var(--bg4); font-size:11px; color:var(--t3); font-weight:400;">
        <div>产品</div><div style="text-align:right;">代码</div><div style="text-align:right;">权益档</div><div style="text-align:right;">份额</div>
      </div><div class="dr-col" style="gap:0;">`;

  activeProds.forEach((p, idx) => {
    const fetchedResult = _lastResults.find((r) => r.code === p.code);
    html += `
      <div style="${gridStyle} align-items:center; padding:12px; ${idx === activeProds.length - 1 ? "" : "border-bottom:1px dashed var(--bd2);"}">
        <div style="min-width:0;"><input id="sn_${p.code}" type="text" maxlength="10" class="dr-input-ghost" style="width:100%; font-size:13px; font-weight:500;" value="${shortNameMap[p.code] || ""}" placeholder="${fetchedResult?.name || NAMES[p.code] || p.code}"></div>
        <div style="text-align:right;"><span class="dr-badge gray" style="font-weight:400; padding:3px 4px; font-size:10px;">${p.code}</span></div>
        <div style="min-width:0;"><input id="eq_${p.code}" type="number" step="0.01" min="0" max="1" class="dr-input-ghost num" style="width:100%; text-align:right; font-size:15px; color:var(--accent); font-weight:400;" value="${(equityMap[p.code] != null ? equityMap[p.code] : p.equity).toFixed(2)}" placeholder="0.00"></div>
        <div style="min-width:0;"><input id="hi_${p.code}" type="number" step="0.01" class="dr-input-ghost num" style="width:100%; text-align:right; font-size:15px; font-weight:400;" value="${holdings[p.code] > 0 ? holdings[p.code].toFixed(2) : ""}" placeholder="0.00"></div>
      </div>`;
  });
  html += `</div></div></div>
  <div style="display:flex;gap:10px;margin-top:24px">
    <button onclick="exportToken()" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--bd2);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:500;cursor:pointer;">🔑 导出</button>
    <button onclick="importToken()" style="flex:1;padding:12px;border-radius:10px;border:1px solid var(--bd2);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:500;cursor:pointer;">📥 恢复</button>
  </div>`;

  document.getElementById("holdingDrawerBody").innerHTML = html;
  openDrawer("holdingDrawer");
}

function saveHoldings() {
  const raw = _loadRaw() || {},
    shares = raw.shares || {},
    equity = raw.equity || {},
    shortNames = raw.shortNames || {};

  getActiveProducts().forEach((p) => {
    const sv = parseFloat(document.getElementById("hi_" + p.code)?.value) || 0;
    const ev = parseFloat(document.getElementById("eq_" + p.code)?.value) || 0;
    const sn = (document.getElementById("sn_" + p.code)?.value || "").trim();

    shares[p.code] = Math.max(0, sv);
    equity[p.code] = Math.min(1, Math.max(0, ev));
    if (sn) shortNames[p.code] = sn;
    else delete shortNames[p.code];
  });

  saveHoldingsData(shares, equity, shortNames);
  closeAllDrawers();
  if (_lastResults && _lastResults.length) renderAll(_lastResults);
  alert("✅ 持仓已保存");
}

// ---- 口令备份 ----
function exportToken() {
  const token = exportSnapshot();
  _showDialog({
    title: "🔑 导出备份口令",
    desc: "请查看并复制下方配置口令。",
    value: token,
    readOnly: true,
    showCancel: false,
    confirmText: "保存并确定",
    onConfirm: (textarea, modal) => {
      textarea.select();
      textarea.setSelectionRange(0, 99999);
      try {
        navigator.clipboard?.writeText
          ? navigator.clipboard
              .writeText(token)
              .then(() => alert("✅ 口令已复制！"))
          : document.execCommand("copy");
      } catch (e) {
        alert("❌ 请手动长按复制！");
      }
      document.body.removeChild(modal);
    },
  });
}

function importToken() {
  _showDialog({
    title: "📥 恢复资产配置",
    placeholder: "请在此粘贴备份口令...",
    showCancel: true,
    confirmText: "恢复配置",
    onConfirm: (textarea, modal) => {
      const str = textarea.value.trim();
      if (!str) return;
      if (importSnapshot(str)) {
        document.body.removeChild(modal);
        closeAllDrawers();
        updatePeBar();
        refreshData();
        alert("✅ 资产配置与首页列表全量恢复成功！");
      } else alert("❌ 口令无效或已损坏，请检查粘贴是否完整！");
    },
  });
}

// ---- 预案抽屉 ----
window._prioritySellCode = loadPrioritySell();

function openPlanDrawer() {
  if (!getCurrentPE()) return alert("请先定锚！") || openPeModal();
  window._prioritySellCode = loadPrioritySell();
  renderPlanDrawer();
  openDrawer("planDrawer");
}

function renderPlanDrawer() {
  const currentPE = getCurrentPE(),
    holdings = loadHoldings(),
    buyData = calcBuyPlanDraft(holdings);
  const savedPlan = safeParse(localStorage.getItem(STORE_SELL_PLAN), {}),
    equityProducts = getActiveProducts().filter((p) => p.equity > 0);
  if (!buyData) return;

  const diff = buyData.currentEq - getDynamicTarget("neutral"),
    wrongDir = isEquityWrongDir(currentPE?.value, diff),
    isNeutral = Math.abs(diff) < 1 && !wrongDir;
  const curEqCol = wrongDir
    ? "var(--warn)"
    : isNeutral
      ? "var(--t1)"
      : diff > 0
        ? "var(--sell)"
        : "var(--buy)";

  let activeAction = "none",
    planStatusHtml =
      '<span style="color:var(--t1); font-weight:600;">待机</span>';

  if (currentPE?.bounds) {
    if (currentPE.value <= currentPE.bounds.buyPct) {
      activeAction = "buy";
      planStatusHtml =
        '<span style="color:var(--buy); font-weight:600;">▲ 增权</span>';
    } else if (currentPE.value >= currentPE.bounds.sellPct) {
      activeAction = "sell";
      planStatusHtml =
        '<span style="color:var(--sell); font-weight:600;">▼ 降权</span>';
    }
  }

  if (activeAction === "none" && !isNeutral) {
    if (diff > 0) {
      activeAction = "sell";
      planStatusHtml =
        '<span style="color:var(--sell); font-weight:600;">▼ 降权</span>';
    } else if (diff < 0) {
      activeAction = "buy";
      planStatusHtml =
        '<span style="color:var(--buy); font-weight:600;">▲ 增权</span>';
    }
  }

  const actSty = "transition:all 0.3s ease;",
    inactSty =
      "opacity:0.4; filter:grayscale(1); pointer-events:none; transition:all 0.3s ease;";

  let html = _buildSummaryHtml(
    currentPE,
    { total: buyData.totalVal },
    planStatusHtml,
    buyData.currentEq,
    curEqCol,
  );

  html += `
  <div class="dr-sec" style="${activeAction === "sell" || activeAction === "none" ? inactSty : actSty}">
    <div class="dr-header"><span class="dr-tag buy" style="font-weight:500;">▲ 增权预案评估</span></div>
    <div class="dr-card dr-pad" style="background:var(--buy-bg);border-color:var(--buy-bd);">
      <div class="dr-flex" style="margin-bottom:12px;align-items:center;">
        <div class="dr-col" style="align-items:flex-start;"><div class="dr-lbl">当前权益</div><div class="dr-val" style="color:${curEqCol}; font-weight:400;">${fmt(buyData.currentEq, 2)}%</div></div>
        <div class="dr-col" style="align-items:center;"><div class="dr-lbl">触发后目标</div><div class="dr-val" style="color:var(--buy); font-weight:400;">${buyData.targetEq}%</div></div>
        <div class="dr-col" style="align-items:flex-end;"><div class="dr-lbl">需调配金额</div><div class="dr-val" style="color:var(--buy); font-weight:600;">${fmtMoney(buyData.buyAmt)}</div></div>
      </div>
      <div class="dr-lbl" style="margin-bottom:6px">资金筹集 (转出 ${getProductName(SYS_CONFIG.CODE_XQ)})</div>
      <div class="dr-plan-box sell" style="margin-bottom:12px; background:rgba(0,0,0,0.1);">
        <div style="font-size:13px;font-weight:500">转出份数</div><div class="dr-val lg" style="color:var(--up); font-weight:400;">${fmt(buyData.sellXqShares, 2)} <span style="font-size:11px;font-weight:400;color:var(--t2)">份</span></div>
      </div>
      <div class="dr-lbl" style="margin-bottom:6px">目标分配 (优先A500C，溢出至中证500C)</div><div class="dr-col" style="gap:6px;">
        <div class="dr-plan-box" style="background:rgba(255,255,255,0.03);"><div style="font-size:13px;font-weight:500">转入 A500C</div><div class="dr-val lg" style="color:var(--buy); font-weight:400;">${fmtMoney(buyData.allocA500C)}</div></div>
        ${buyData.allocZZ500C > 1 ? `<div class="dr-plan-box" style="background:rgba(255,255,255,0.03);"><div style="font-size:13px;font-weight:500">转入 中证500C</div><div class="dr-val lg" style="color:var(--buy); font-weight:400;">${fmtMoney(buyData.allocZZ500C)}</div></div>` : ""}
      </div>
    </div>
  </div>`;

  html += `
  <div style="${activeAction === "buy" || activeAction === "none" ? inactSty : actSty}">
    <div class="dr-header"><span class="dr-tag sell" style="font-weight:500;">▼ 降权预案评估</span></div>
    <div class="dr-card dr-pad" style="background:var(--up-dim);border-color:var(--up-bg);">
      <div id="sell_summary_area"></div><div class="dr-lbl" style="margin-bottom:10px">配置减仓比例（空=不参与），摩擦费率 ${fmt(SYS_CONFIG.FEE * 100, 1)}%</div>`;

  equityProducts.forEach((p) => {
    const isPri = window._prioritySellCode === p.code,
      shares = holdings[p.code] || 0,
      holdingVal = (getNavByCode(p.code) || 0) * shares;
    html += `
    <div class="dr-card dr-pad" style="margin-bottom:8px;">
      <div style="display:grid; grid-template-columns: 115px 50px 1fr; align-items:center; margin-bottom:6px;">
        <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
        <div><span class="dr-badge gray" style="font-weight:400;">${fmt(p.equity, 2)}</span></div>
        <div id="sell_calc_shares_${p.code}" class="dr-val" style="text-align:right; color:var(--t3); font-size:13px; font-weight:400;">-- <span style="font-size:11px;font-weight:400">份</span></div>
      </div>
      <div class="dr-flex" style="margin-bottom:2px;">
        <div class="dr-lbl" style="display:flex;align-items:center;white-space:nowrap;">
          持仓 <span class="num" style="margin-left:4px;font-weight:400;color:var(--t1)">${fmt(shares, 2)}</span> <span style="margin-left:2px">份</span><span style="color:var(--bd2);margin:0 8px">|</span><span class="num" style="font-weight:400;color:var(--t1)">${holdingVal ? fmtMoney(holdingVal) : "--"}</span>
        </div>
        <div id="sell_calc_fiat_${p.code}" class="dr-val" style="color:var(--t3);font-size:13px; font-weight:400;">-- 元</div>
      </div>
      <div class="dr-flex" style="margin-top:8px;padding-top:10px;border-top:1px dashed var(--bd2);">
        <button class="pri-btn ${isPri ? "active" : ""}" data-code="${p.code}" onclick="togglePrioritySell('${p.code}')" style="font-weight:500;">${isPri ? "★ 优先" : "☆ 优先"}</button>
        <div style="display:flex;align-items:center;gap:8px"><span class="dr-lbl">减仓权重</span>
          <input type="tel" style="width:60px;height:28px;background:var(--bg);border:1px solid var(--bd2);border-radius:6px;color:var(--t1);text-align:center;font-family:var(--f-num);font-size:14px;outline:none;font-weight:400;" id="ratio_${p.code}" value="${savedPlan[p.code] || ""}" oninput="calcSellPreview()">
        </div>
      </div>
    </div>`;
  });

  html += `<div class="dr-card dr-pad" style="margin-top:12px;" id="sell_preview_result"><span class="dr-lbl">等待输入比例...</span></div></div></div>`;
  document.getElementById("planDrawerBody").innerHTML = html;
  calcSellPreview();
}

function calcSellPreview() {
  const equityProducts = getActiveProducts().filter((p) => p.equity > 0),
    ratios = {};
  equityProducts.forEach((p) => {
    ratios[p.code] =
      parseFloat(document.getElementById("ratio_" + p.code)?.value) || 0;
  });

  const draft = calcSellExecutionDraft(
    loadHoldings(),
    ratios,
    window._prioritySellCode,
  );
  const summaryEl = document.getElementById("sell_summary_area");

  if (summaryEl && !draft.error) {
    const diff = draft.currentEq - getDynamicTarget("neutral"),
      wrongDir = isEquityWrongDir(getCurrentPE()?.value, diff);
    const curEqCol = wrongDir
      ? "var(--warn)"
      : Math.abs(diff) < 1 && !wrongDir
        ? "var(--t1)"
        : diff > 0
          ? "var(--sell)"
          : "var(--buy)";
    summaryEl.innerHTML = `
    <div class="dr-flex" style="margin-bottom:12px;align-items:center;">
      <div class="dr-col" style="align-items:flex-start;"><div class="dr-lbl">当前权益</div><div class="dr-val" style="color:${curEqCol}; font-weight:400;">${fmt(draft.currentEq, 2)}%</div></div>
      <div class="dr-col" style="align-items:center;"><div class="dr-lbl">触发后目标</div><div class="dr-val" style="color:var(--warn); font-weight:400;">${draft.targetEq}%</div></div>
      <div class="dr-col" style="align-items:flex-end;"><div class="dr-lbl">需减比例</div><div class="dr-val" style="color:var(--sell); font-weight:400;">${fmt(draft.diffEqPct, 2)}%</div></div>
    </div>`;
  }

  equityProducts.forEach((p) => {
    const res = draft.results?.[p.code],
      elS = document.getElementById("sell_calc_shares_" + p.code),
      elF = document.getElementById("sell_calc_fiat_" + p.code);
    if (res && res.amt > 0) {
      elS.innerHTML = `<span style="color:var(--up); font-weight:600;">${fmt(res.shares, 2)}</span> <span style="font-size:11px;color:var(--t2);font-weight:400;">份</span>`;
      elF.innerHTML = `<span style="color:var(--sell);font-size:11px;margin-right:8px;font-weight:400">降权 ${fmt(res.eqDropPct, 2)}%</span><span style="color:var(--t1);font-weight:500;">${fmtMoney(res.amt)}</span>`;
    } else {
      elS.innerHTML = `-- <span style="font-size:11px;font-weight:400;">份</span>`;
      elF.innerHTML = `-- 元`;
    }
  });

  const resultEl = document.getElementById("sell_preview_result");
  resultEl.innerHTML = draft.hasAnySell
    ? `
    <div class="dr-flex" style="align-items:center;">
      <div class="dr-col" style="align-items:flex-start;"><div class="dr-lbl">操作后权益</div><div class="dr-val lg" style="color:var(--dn); font-weight:400;">${fmt(draft.afterEqPct, 2)}%</div></div>
      <div class="dr-col" style="align-items:center;"><div class="dr-lbl">转出到账</div><div class="dr-val lg" style="font-weight:600;">${fmtMoney(draft.totalCashOut)}</div></div>
      <div class="dr-col" style="align-items:flex-end;"><div class="dr-lbl">总摩擦</div><div class="dr-val lg" style="color:var(--warn); font-weight:400;">${fmtMoney(draft.totalFriction)}</div></div>
    </div>`
    : `<span class="dr-lbl" style="font-weight:400;">请填写比例或设为优先卖出</span>`;
}

function togglePrioritySell(code) {
  window._prioritySellCode = window._prioritySellCode === code ? null : code;
  window._prioritySellCode
    ? savePrioritySell(window._prioritySellCode)
    : clearPrioritySell();
  document.querySelectorAll(".pri-btn").forEach((btn) => {
    const isPri = btn.dataset.code === window._prioritySellCode;
    btn.className = `pri-btn ${isPri ? "active" : ""}`;
    btn.innerHTML = isPri ? "★ 优先" : "☆ 优先";
  });
  calcSellPreview();
}

function saveSellPlan() {
  const plan = {};
  getActiveProducts()
    .filter((p) => p.equity > 0)
    .forEach((p) => {
      const v = document.getElementById("ratio_" + p.code)?.value || "";
      if (v) plan[p.code] = v;
    });
  localStorage.setItem(STORE_SELL_PLAN, JSON.stringify(plan));
}

function saveAndClosePlan() {
  saveSellPlan();
  closeAllDrawers();
}
