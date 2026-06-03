// ============================================================
// interact.js - 控制器层 (v3.2 纯净调度版)
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
    if (o.length === funds.length) {
      saveFunds(o);
      syncCloud("push_config");
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
    syncCloud("push_config");
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
  syncCloud("push_config");
  refreshData();
}

// ---- PE 定锚操作 ----
function openPeModal() {
  const peData = loadPe() || {};
  document.getElementById("peModalBucket").value = peData.bucketStr || "65,70";
  document.getElementById("peModalInputPct").value = peData.peYest || "";
  document.getElementById("peModalPriceAnchor").value =
    peData.priceAnchor || "";
  document.getElementById("peModalPriceBuy").value = peData.priceBuy || "";
  document.getElementById("peModalPriceSell").value = peData.priceSell || "";
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
  const priceBuy = parseFloat(document.getElementById("peModalPriceBuy").value);
  const priceSell = parseFloat(
    document.getElementById("peModalPriceSell").value,
  );

  if (
    isNaN(peYest) ||
    isNaN(priceAnchor) ||
    isNaN(priceBuy) ||
    isNaN(priceSell)
  )
    return alert(
      "请填写完整的【PE百分位】、【收盘点位】、【增权指数】与【降权指数】！",
    );

  savePe({ bucketStr, peYest, priceAnchor, priceBuy, priceSell });

  syncCloud("push_pe_now");
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
  const targetEqNeutral = getDynamicTarget("neutral", peData?.bucketStr);

  // 在 interact 层完成权益计算，传给 UI 工厂
  const eqData = calcCurrentEquity(holdings, activeProds, getNavByCode);

  // 在 interact 层计算各产品今日盈亏，传给 UI 工厂（避免 ui 层自行做计算）
  const lastResults = getLastResults();
  const today = todayDateStr();
  const profitMap = {};
  activeProds.forEach((p) => {
    const shares = holdings[p.code] || 0;
    const f = lastResults.find((r) => r.code === p.code);
    if (!f || f.error || shares <= 0) {
      profitMap[p.code] = null;
      return;
    }
    const offD = f.offDate ? f.offDate.slice(0, 10) : "";
    const estD = f.estTime ? f.estTime.slice(0, 10) : "";
    const isOfficialUpdated = f.offVal && (!estD || offD >= estD);
    const nav = parseFloat(isOfficialUpdated ? f.offVal : f.estVal);
    if (isNaN(nav)) {
      profitMap[p.code] = null;
      return;
    }
    const activePct = isOfficialUpdated ? f.offPct : f.estPct;
    let yestNav = null;
    if (f.baseNav && f.baseDate) yestNav = f.baseNav;
    else if (activePct != null && !isNaN(activePct))
      yestNav = nav / (1 + activePct / 100);
    profitMap[p.code] = yestNav != null ? shares * (nav - yestNav) : null;
  });

  const savedPlan = loadSellPlan();
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
      profitMap,
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
  _refreshCloudBtn();
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
    if (wt !== "") plan[p.code] = parseFloat(wt);
  });

  saveHoldingsData(shares, equity, shortNames);
  saveSellPlan(plan);

  syncCloud("push_config");
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

// 验证完成后直接刷新抽屉内云配置按钮，不重渲染整个抽屉
async function _refreshCloudBtn() {
  const { id, token } = loadGistConfig();
  if (!id || !token) return;
  await _verifyCloudConfig(id, token);
  const cs = getCloudStatus();
  const cfgBtn = document.getElementById("cloudCfgBtn");
  if (!cfgBtn) return;
  const col = cs.ok ? "var(--dn)" : "var(--sell)";
  const bd = cs.ok ? "var(--dn-bd)" : "var(--sell-bd)";
  cfgBtn.style.color = col;
  cfgBtn.style.borderColor = bd;
  cfgBtn.textContent = `⚙ 配置 (${cs.count}/2)`;
}

// 验证已填字段的连通性，结果写入 store（后台静默执行，不阻塞 UI）
async function _verifyCloudConfig(gid, token) {
  const count = [gid, token].filter(Boolean).length;
  setCloudStatus({ count, ok: false });
  if (count < 2) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gid}`, {
      headers: { Authorization: `token ${token}` },
    });
    setCloudStatus({ count, ok: res.ok });
  } catch {
    setCloudStatus({ count, ok: false });
  }
}

function openCloudConfig() {
  const { id: gid, token: gtk } = loadGistConfig();

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
        clearGistConfig();
        setCloudStatus({ count: 0, ok: false });
        document.body.removeChild(modal);
        return alert("已关闭云同步");
      }

      const parts = val.split(",");
      if (parts.length >= 2) {
        const newGid = parts[0].trim();
        const newToken = parts[1].trim();
        saveGistConfig(newGid, newToken);
        document.body.removeChild(modal);
        alert("✅ 配置已保存，正在拉取云端数据...");
        const ok = await syncCloud("pull");
        if (!ok) alert("⚠️ 云端拉取失败，请检查 Gist ID 和 Token 是否正确。");
        _verifyCloudConfig(newGid, newToken);
      } else {
        alert("❌ 格式错误，请使用英文逗号分隔");
      }
    },
  });
}

// 返回 true 表示有实际数据变更，false 表示失败或内容无变化
// mode: "pull" | "push_pe" | "push_pe_now" | "push_config"
async function syncCloud(mode = "pull") {
  const { id: gid, token: gtk } = loadGistConfig();
  if (!gid || !gtk) return false;

  if (mode === "pull") {
    _isSyncingPull = true;
    try {
      // 两文件并行拉取，各自比对，只在内容变化时写入
      const [remotePe, remoteConfig] = await Promise.all([
        cloudFetchPe(gid, gtk),
        cloudFetchConfig(gid, gtk),
      ]);
      if (!remotePe && !remoteConfig) return false; // 两文件均拉取失败
      const peChanged = importPeSnapshot(remotePe);
      const configChanged = importSnapshot(remoteConfig);
      // 本地版本比云端新（上次推送丢失）→ 反向推送自愈，待守卫解除后触发
      if (remoteConfig && loadConfigVer() > (remoteConfig.v || ""))
        setTimeout(() => syncCloud("push_config"), 0);
      if (peChanged || configChanged) console.log("✅ 云端数据已同步");
      await refreshData();
      return true;
    } finally {
      _isSyncingPull = false;
    }
  }

  if (_isSyncingPull) return false;

  if (mode === "push_pe" || mode === "push_pe_now") {
    const doPush = async () => {
      const peData = loadPe();
      const ok = await cloudUpdatePe(gid, gtk, peData);
      fmLog("syncCloud_push_pe", peData);
      if (ok) console.log("✅ PE 推送成功");
      else console.error("❌ PE 推送失败");
    };
    clearTimeout(_syncTimer);
    if (mode === "push_pe_now") await doPush();
    else _syncTimer = setTimeout(doPush, 2000);
    return true;
  }

  if (mode === "push_config") {
    const doPush = async () => {
      const payload = {
        v: loadConfigVer(),
        f: funds,
        h: safeParse(localStorage.getItem(STORE_HOLDINGS), {}),
        s: loadSellPlan(),
        pr: loadPrioritySell() || null,
      };
      const ok = await cloudUpdateConfig(gid, gtk, payload);
      fmLog("syncCloud_push_config", payload);
      if (ok) console.log("✅ Config 推送成功");
      else console.error("❌ Config 推送失败");
    };
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(doPush, 2000);
    return true;
  }

  return false;
}
