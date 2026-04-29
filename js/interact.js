// ============================================================
// interact.js - 控制器层 (v3.1 纯净调度版)
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

function rebuildSortable() {
  if (cardSortable) cardSortable.destroy();
  if (tblSortable) tblSortable.destroy();
  const onEnd = (evt) => {
    const o = Array.from(evt.to.children)
      .map((el) => el.dataset.code)
      .filter(Boolean);
    if (o.length === funds.length) saveFunds(o);
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
}

async function refreshData() {
  if (_isFetchingData) return;
  _isFetchingData = true;
  toggleRefreshBtn(true);

  try {
    loadFunds();
    fetchIndices();

    const results = await Promise.all(funds.map(fetchSingleFund));
    setLastResults(results);

    if (funds.length > 0) rebuildSortable();
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
    saveFunds([...funds, code]);
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
  saveFunds(funds.filter((c) => c !== code));
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

  savePe({
    bucketStr,
    peYest,
    priceAnchor,
    priceBuy: isNaN(priceBuy) ? null : priceBuy,
    priceSell: isNaN(priceSell) ? null : priceSell,
  });
  closePeModal();
}

// ---- 持仓抽屉 ----

// 实时提取输入数据，在 interact 层完成 engine 计算，再传给 UI 工厂渲染
function liveUpdateHoldingPlan() {
  const planArea = document.getElementById("holdingPlanArea");
  if (!planArea) return;

  const activeProds = getActiveProducts();
  const peData = loadPe();
  const rt300Price = getIndices()["000300"]?.f2 ?? null;
  const currentPE = getCurrentPE(peData, rt300Price);
  const targetEqNeutral = getDynamicTarget("neutral", peData?.bucketStr);

  // 叠加当前表单未保存的内容
  const tempHoldings = { ...loadHoldings() };
  const tempPlan = {};
  activeProds.forEach((p) => {
    const sv = document.getElementById("hi_" + p.code)?.value;
    if (sv !== undefined && sv !== "")
      tempHoldings[p.code] = parseFloat(sv) || 0;
    const wt = document.getElementById("wt_" + p.code)?.value;
    if (wt !== undefined && wt !== "") tempPlan[p.code] = parseFloat(wt) || 0;
  });

  const priorityCode = getPrioritySellCode();
  const eqData = calcCurrentEquity(tempHoldings, activeProds, getNavByCode);
  if (!eqData || targetEqNeutral == null) {
    planArea.innerHTML = "";
    return;
  }

  const diff = eqData.equity - targetEqNeutral;
  const targetEqBuy = getDynamicTarget("buy", peData?.bucketStr);
  const targetEqSell = getDynamicTarget("sell", peData?.bucketStr);

  const buyDraft =
    diff < 0
      ? calcBuyPlanDraft(
          tempHoldings,
          activeProds,
          getNavByCode,
          targetEqBuy,
        )
      : null;
  const sellDraft =
    diff > 0
      ? calcSellExecutionDraft(
          tempHoldings,
          activeProds,
          getNavByCode,
          targetEqSell,
          tempPlan,
          priorityCode,
        )
      : null;

  planArea.innerHTML = UI_buildHoldingPlanHtml(
    activeProds,
    currentPE,
    targetEqNeutral,
    eqData,
    buyDraft,
    sellDraft,
  );
}

function openHoldingDrawer() {
  const holdings = loadHoldings(),
    equityMap = loadHoldingsEquity(),
    shortNameMap = loadShortNames();
  const activeProds = getActiveProducts();
  const peData = loadPe();
  const rt300Price = getIndices()["000300"]?.f2 ?? null;
  const currentPE = getCurrentPE(peData, rt300Price);
  const eqData = calcCurrentEquity(holdings, activeProds, getNavByCode);
  const targetEqNeutral = getDynamicTarget("neutral", peData?.bucketStr);

  const savedPlan = safeParse(localStorage.getItem(STORE_SELL_PLAN), {});
  const priorityCode = loadPrioritySell();
  setPrioritySellCode(priorityCode);

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
      savedPlan,
      priorityCode,
    );

  const btn = document.getElementById("btnHoldingAction");
  if (btn) {
    btn.textContent = "持仓配置";
    btn.style.background = "var(--accent)";
  }

  liveUpdateHoldingPlan();
  openDrawer("holdingDrawer");
}

function toggleHoldingPriority(code) {
  let currentCode = getPrioritySellCode();
  currentCode = currentCode === code ? null : code;
  setPrioritySellCode(currentCode);
  currentCode ? savePrioritySell(currentCode) : clearPrioritySell();

  getActiveProducts().forEach((p) => {
    const btn = document.getElementById("pri_btn_" + p.code);
    if (btn) {
      const isPri = p.code === currentCode;
      btn.textContent = isPri ? "优先" : "—";
      btn.style.color = isPri ? "var(--sell)" : "var(--t3)";
      btn.style.borderColor = isPri ? "var(--sell-bd)" : "var(--bd2)";
      btn.style.background = isPri ? "var(--sell-bg)" : "transparent";
    }
  });

  liveUpdateHoldingPlan();
}

function handleHoldingAction() {
  const configArea = document.getElementById("holdingConfigArea");
  const btn = document.getElementById("btnHoldingAction");

  if (!configArea || !btn) return;

  if (configArea.style.display === "none") {
    configArea.style.display = "block";
    btn.textContent = "保存配置";
    btn.style.background = "var(--up)";
    setTimeout(() => {
      document.getElementById("holdingDrawerBody").scrollTop = 9999;
    }, 50);
  } else {
    saveHoldings();
  }
}

function saveHoldings() {
  const shares = loadHoldings(),
    equity = loadHoldingsEquity(),
    shortNames = loadShortNames();
  const plan = {};

  getActiveProducts().forEach((p) => {
    const sv = parseFloat(document.getElementById("hi_" + p.code)?.value) || 0;
    const ev = parseFloat(document.getElementById("eq_" + p.code)?.value) || 0;
    const sn = (document.getElementById("sn_" + p.code)?.value || "").trim();
    const wt = document.getElementById("wt_" + p.code)?.value || "";

    shares[p.code] = Math.max(0, sv);
    equity[p.code] = Math.min(1, Math.max(0, ev));
    if (sn) shortNames[p.code] = sn;
    else delete shortNames[p.code];

    if (wt !== "") plan[p.code] = wt;
  });

  saveHoldingsData(shares, equity, shortNames);
  localStorage.setItem(STORE_SELL_PLAN, JSON.stringify(plan));

  alert("✅ 配置已保存");

  // 保存后收起配置区，重置按钮状态
  const configArea = document.getElementById("holdingConfigArea");
  const btn = document.getElementById("btnHoldingAction");
  if (configArea) configArea.style.display = "none";
  if (btn) {
    btn.textContent = "持仓配置";
    btn.style.background = "var(--accent)";
  }
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
