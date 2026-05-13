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

  syncCloud("push_now");
  alert("✅ 定锚已更新，云端同步已在后台触发");
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

  const targetEqBuy = getDynamicTarget("buy", peData?.bucketStr);
  const targetEqSell = getDynamicTarget("sell", peData?.bucketStr);

  const buyDraft = calcBuyPlanDraft(
    tempHoldings,
    activeProds,
    getNavByCode,
    targetEqBuy,
  );
  const sellDraft = calcSellExecutionDraft(
    tempHoldings,
    activeProds,
    getNavByCode,
    targetEqSell,
    tempPlan,
    priorityCode,
  );

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
    configArea.style.display = "none";
    btn.textContent = "持仓配置";
    btn.style.background = "var(--accent)";
  }
}

function saveHoldings() {
  const raw = _loadRaw() || {};
  const shares = { ...(raw.shares || {}) };
  const equity = { ...(raw.equity || {}) };
  const shortNames = { ...(raw.shortNames || {}) };
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

  syncCloud("push_now");
  alert("✅ 配置已保存，云端同步已在后台触发");
}

// ---- 云端同步模块 ----
let _syncTimer = null;
let _isSyncingPull = false;

async function manualPull() {
  const ok = await syncCloud("pull");
  if (ok) {
    closeAllDrawers();
    alert("✅ 云端数据已同步到本地");
  } else {
    alert("❌ 拉取失败，请检查网络或 Token 是否有效");
  }
}

function openCloudConfig() {
  const gid = localStorage.getItem(STORE_GIST_ID) || "";
  const gtk = localStorage.getItem(STORE_GIST_TOKEN) || "";

  UI_showDialog({
    title: "☁️ 云同步配置 (GitHub Gist)",
    desc: "输入 Gist ID 和 Token。置空并保存可关闭同步。",
    placeholder: "格式：GistID,Token",
    value: gid && gtk ? `${gid},${gtk}` : "",
    showCancel: true,
    confirmText: "保存配置",
    onConfirm: async (textarea, modal) => {
      const val = textarea.value.trim();
      if (!val) {
        localStorage.removeItem(STORE_GIST_ID);
        localStorage.removeItem(STORE_GIST_TOKEN);
        document.body.removeChild(modal);
        return alert("已关闭云同步");
      }

      const parts = val.split(",");
      if (parts.length === 2) {
        localStorage.setItem(STORE_GIST_ID, parts[0].trim());
        localStorage.setItem(STORE_GIST_TOKEN, parts[1].trim());
        document.body.removeChild(modal);
        alert("✅ 配置已保存，正在拉取云端数据...");
        const ok = await syncCloud("pull");
        if (!ok) alert("⚠️ 云端拉取失败，请检查 Gist ID 和 Token 是否正确。");
      } else {
        alert("❌ 格式错误，请使用英文逗号分隔 ID 和 Token");
      }
    },
  });
}

// 返回 true 表示 pull 成功，false 表示失败或跳过
async function syncCloud(mode = "pull") {
  const gid = localStorage.getItem(STORE_GIST_ID);
  const gtk = localStorage.getItem(STORE_GIST_TOKEN);
  if (!gid || !gtk) return false;

  if (mode === "pull") {
    console.log("☁️ 正在拉取云端数据...");
    _isSyncingPull = true;
    try {
      const remoteData = await cloudFetch(gid, gtk);
      if (remoteData && remoteData.f) {
        const snapshot = btoa(encodeURIComponent(JSON.stringify(remoteData)));
        if (importSnapshot(snapshot)) {
          // await 确保 refreshData 完成后再释放锁，避免 FUNDS 广播在锁释放后触发推送
          await refreshData();
          console.log("✅ 云端数据已覆盖本地");
          return true;
        }
      }
      return false;
    } finally {
      // 无论成功失败都释放锁
      _isSyncingPull = false;
    }
  } else if (mode === "push" || mode === "push_now") {
    // 拉取期间拦截反向推送，防止把云端数据推回覆盖
    if (_isSyncingPull) return false;

    const doPush = async () => {
      console.log("☁️ 正在推送到云端...");
      const data = {
        f: funds,
        h: safeParse(localStorage.getItem(STORE_HOLDINGS), {}),
        p: loadPe(),
        s: safeParse(localStorage.getItem(STORE_SELL_PLAN), {}),
        pr: loadPrioritySell() || null,
      };
      const ok = await cloudUpdate(gid, gtk, data);
      if (ok) console.log("✅ 推送云端成功");
      else console.error("❌ 推送云端失败");
    };

    clearTimeout(_syncTimer);
    if (mode === "push_now") {
      await doPush();
    } else {
      _syncTimer = setTimeout(doPush, 2000);
    }
    return true;
  }

  return false;
}
