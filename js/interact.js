// ============================================================
// interact.js - 控制器层 (v3.1 架构师重构版 - 肃清越权污染)
// 职责：接收用户事件，调 Engine 计算，向 Store 写数据，或触发 UI 工厂生成抽屉
// 铁律：不再包含任何 HTML 拼接，严禁裸写 localStorage 读写
// ============================================================

function openDrawer(id) {
  document.getElementById("drawerMask").classList.add("open");
  document.getElementById(id).classList.add("open");
  document.body.style.overflow = "hidden"; // 锁定背景滚动
}
function closeAllDrawers() {
  document.getElementById("drawerMask").classList.remove("open");
  document
    .querySelectorAll(".drawer")
    .forEach((d) => d.classList.remove("open"));
  document.body.style.overflow = ""; // 恢复背景滚动
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

let _isFetchingData = false;

async function refreshData(force = false) {
  if (_isFetchingData) return;

  if (force && typeof window.expireOffCache === "function") {
    window.expireOffCache();
  }

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
    setLastResults(results);

    if (cardSortable) cardSortable.destroy();
    if (tblSortable) tblSortable.destroy();

    const onEnd = (evt) => {
      const o = Array.from(evt.to.children)
        .map((el) => el.dataset.code)
        .filter(Boolean);
      if (o.length === funds.length) {
        // [架构师优化]：不再直接覆写全局变量，调用暴露的 API 更新，捍卫 MVC 隔离墙
        updateFundsList(o);
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

function addFund() {
  const input = document.getElementById("codeInput");
  const code = input.value.trim();
  if (/^\d{6}$/.test(code) && !funds.includes(code)) {
    updateFundsList([...funds, code]);
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
  updateFundsList(funds.filter((c) => c !== code));
  refreshData();
}

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

function openHoldingDrawer() {
  // [架构师优化]：严禁越权调用 store.js 的下划线内部私有函数，改走标准的 getter
  const holdings = loadHoldings(),
        equityMap = loadHoldingsEquity(),
        shortNameMap = loadShortNames();
        
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
  // 保持原有对象的内存合并逻辑
  const shares = loadHoldings(),
        equity = loadHoldingsEquity(),
        shortNames = loadShortNames();

  getActiveProducts().forEach((p) => {
    const svStr = document.getElementById("hi_" + p.code)?.value || "";
    const evStr = document.getElementById("eq_" + p.code)?.value || "";
    
    const sv = parseFloat(svStr.replace(/,/g, '')) || 0;
    const ev = parseFloat(evStr.replace(/,/g, '')) || 0;
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

// [架构师优化]：消除污染全局 window 的僵尸变量，替换为局部状态控制变量
let _prioritySellCodeDraft = null;

function openPlanDrawer() {
  const peData = loadPe();
  if (!getCurrentPE(peData, window._rt_csi300_price))
    return alert("请先定锚！") || openPeModal();
    
  _prioritySellCodeDraft = loadPrioritySell();
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

  // [架构师优化]：消除越权，统一通过 store.js 读取预案
  const savedPlan = loadSellPlanConfig();
  const targetEqNeutral = getDynamicTarget("neutral", peData?.bucketStr);

  if (!buyData) return;

  document.getElementById("planDrawerBody").innerHTML = UI_renderPlanDrawerBody(
    currentPE,
    buyData,
    holdings,
    activeProds,
    getNavByCode,
    savedPlan,
    _prioritySellCodeDraft,
    targetEqNeutral,
  );
  calcSellPreview();
}

function calcSellPreview() {
  const activeProds = getActiveProducts();
  const equityProducts = activeProds.filter((p) => p.equity > 0);
  const ratios = {};
  equityProducts.forEach((p) => {
    const rStr = document.getElementById("ratio_" + p.code)?.value || "";
    ratios[p.code] = parseFloat(rStr.replace(/,/g, '')) || 0;
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
    _prioritySellCodeDraft,
  );
  const currentPE = getCurrentPE(peData, window._rt_csi300_price);

  UI_updateSellPreview(draft, equityProducts, currentPE, targetEqNeutral);
}

function togglePrioritySell(code) {
  _prioritySellCodeDraft = _prioritySellCodeDraft === code ? null : code;
  _prioritySellCodeDraft
    ? savePrioritySell(_prioritySellCodeDraft)
    : clearPrioritySell();

  document.querySelectorAll(".pri-btn").forEach((btn) => {
    const isPri = btn.dataset.code === _prioritySellCodeDraft;
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
      const vStr = document.getElementById("ratio_" + p.code)?.value || "";
      const cleaned = vStr.replace(/,/g, '').trim();
      if (cleaned) plan[p.code] = cleaned;
    });
  // [架构师优化]：通过 store 通信，禁止控制器跨级直接触碰 localStorage
  saveSellPlanConfig(plan);
}

function saveAndClosePlan() {
  saveSellPlan();
  closeAllDrawers();
}

setTimeout(() => {
  const _mBtn = document.getElementById("miniRefBtn");
  const _pcBtn = document.getElementById("miniRefBtnPc");
  if (_mBtn) _mBtn.onclick = () => refreshData(true);
  if (_pcBtn) _pcBtn.onclick = () => refreshData(true);
}, 0);
