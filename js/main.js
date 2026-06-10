// ============================================================
// main.js - 系统启动与调度中枢
// 职责：初始化、定时器、事件绑定、将 UI 与 Store 绑定
// ============================================================

document.getElementById("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFund();
});

observeState("INDICES", UI_updateIndices);
// FUNDS 广播由净值刷新和列表增删共同触发，云推送只在配置变更时需要，
// 由 addFund / delFund / saveHoldings / confirmPe 各自显式调用 syncCloud
observeState("FUNDS", UI_updateFunds);
observeState("LOCAL_CONFIG", () => {
  UI_updateLocalConfig();
});

updateClock();
setInterval(updateClock, 1000);

syncCloud("pull").then((ok) => {
  // pull 成功时 syncCloud 内部已调用 refreshData，无需重复
  if (!ok) refreshData();
  const { id, token } = loadGistConfig();
  if (id && token) _verifyCloudConfig(id, token);
});
pullPeEngine();
fetchQQIndex();

setInterval(() => {
  if (!document.hidden) {
    fetchIndices();
    fetchQQIndex();
  }
}, SYS_CONFIG.REFRESH_IDX);
setInterval(() => {
  if (!document.hidden) refreshData();
}, SYS_CONFIG.REFRESH_API);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    fetchIndices();
    fetchQQIndex();
    refreshData();
    pullPeEngine();
    const { id, token } = loadGistConfig();
    if (id && token) _verifyCloudConfig(id, token);
  }
});
