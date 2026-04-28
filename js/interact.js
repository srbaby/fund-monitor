// ============================================================
// interact.js - 控制器层 (v3.0 纯净调度版)
// 职责：接收用户事件，调 Engine 计算，向 Store 写数据，或触发 UI 工厂生成抽屉
// 铁律：不再包含任何 HTML 拼接，不含手动 renderAll，全靠 store 通知
// ============================================================

// ---- 抽屉基础控制 ----
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

function toggleRefreshBtn(isFetching) {
  ["miniRefBtn", "miniRefBtnPc"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.textContent = isFetching ? "↻" : "↻ 刷新";
      btn.disabled = isFetching;
    }
  });
}

// ---- 数据刷新调度 ----
let _isFetchingData = false;

async function refreshData() {
  if (_isFetchingData) return;
  _isFetchingData = true;
  toggleRefreshBtn(true);

  try {
    loadFunds();
    fetchIndices();

    if (!funds.length) {
      UI_renderEmptyState();
      return;
    }

    const results = await Promise.all(funds.map(fetchSingleFund));
    // 💥 核心：只管把数据塞给 store，由于引入了观察者模式，store 内部会自动触发界面的 renderAll
    setLastResults(results);

    // 重置拖拽插件（若有新基金加入）
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

// ---- 基金增删操作 ----
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
  const fetchedResult = getLastResults().find((r) => r.code === code);
  const name =
    fetchedResult && !fetchedResult.error
      ? fetchedResult.name
      : NAMES[code] || code;
  if (!confirm(`确认删除「${name}」？`)) return;
  funds = funds.filter((c) => c !== code);
  saveFunds();
  refreshData();
}

// ---- PE 定锚操作 ----
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

  // 💥 核心：调用 store 保存。store 会通过 observer 广播更改，界面自动更新 peBar，不再手动调 updatePeBar()
  savePe({
    bucketStr,
    peYest,
    priceAnchor,
    priceBuy: isNaN(priceBuy) ? null : priceBuy,
    priceSell: isNaN(priceSell) ? null : priceSell,
  });
  closePeModal();
}

// ---- 持仓抽屉调度 ----
function openHoldingDrawer() {
  const raw = _loadRaw() || {},
    holdings = raw.shares || {},
    equityMap = raw.equity || {},
    shortNameMap = raw.shortNames || {};
  const activeProds = getActiveProducts();
  const peData = loadPe();
  const currentPE = getCurrentPE(peData, window._rt_csi300_price);
  const eqData = calcCurrentEquity(holdings, activeProds, getNavByCode);
  const targetEqNeutral = getDynamicTarget("neutral", peData?.bucketStr);

  document.getElementById("holdingDrawerBody").innerHTML =
    UI_renderHoldingDrawerBody(
      activeProds,
      holdings,
      equityMap,
      shortNameMap,
      getNavByCode,
      eqData,
      currentPE,
      targetEqNeutral,
      getLastResults(),
    );
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
  alert("✅ 持仓已保存");
}

// ---- 口令备份调度 ----
function exportToken() {
  const token = exportSnapshot();
  UI_showDialog({
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
  UI_showDialog({
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
        refreshData();
        alert("✅ 资产配置与首页列表全量恢复成功！");
      } else alert("❌ 口令无效或已损坏，请检查粘贴是否完整！");
    },
  });
}

// ---- 预案抽屉调度 ----
window._prioritySellCode = loadPrioritySell();

function openPlanDrawer() {
  const peData = loadPe();
  if (!getCurrentPE(peData, window._rt_csi300_price))
    return alert("请先定锚！") || openPeModal();
  window._prioritySellCode = loadPrioritySell();
  renderPlanDrawer();
  openDrawer("planDrawer");
}

function renderPlanDrawer() {
  const peData = loadPe();
  const currentPE = getCurrentPE(peData, window._rt_csi300_price);
  const holdings = loadHoldings();
  const activeProds = getActiveProducts();
  const targetEqBuy = getDynamicTarget("buy", peData?.bucketStr);
  const buyData = calcBuyPlanDraft(
    holdings,
    activeProds,
    getNavByCode,
    targetEqBuy,
  );

  const savedPlan = safeParse(localStorage.getItem(STORE_SELL_PLAN), {});
  const targetEqNeutral = getDynamicTarget("neutral", peData?.bucketStr);

  if (!buyData) return;

  document.getElementById("planDrawerBody").innerHTML = UI_renderPlanDrawerBody(
    currentPE,
    buyData,
    holdings,
    activeProds,
    getNavByCode,
    savedPlan,
    window._prioritySellCode,
    targetEqNeutral,
  );
  calcSellPreview();
}

function calcSellPreview() {
  const activeProds = getActiveProducts();
  const equityProducts = activeProds.filter((p) => p.equity > 0);
  const ratios = {};
  equityProducts.forEach((p) => {
    ratios[p.code] =
      parseFloat(document.getElementById("ratio_" + p.code)?.value) || 0;
  });

  const peData = loadPe();
  const targetEqSell = getDynamicTarget("sell", peData?.bucketStr);
  const targetEqNeutral = getDynamicTarget("neutral", peData?.bucketStr);

  const draft = calcSellExecutionDraft(
    loadHoldings(),
    activeProds,
    getNavByCode,
    targetEqSell,
    ratios,
    window._prioritySellCode,
  );
  const currentPE = getCurrentPE(peData, window._rt_csi300_price);

  UI_updateSellPreview(draft, equityProducts, currentPE, targetEqNeutral);
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
