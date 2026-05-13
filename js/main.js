// ============================================================
// main.js - 系统启动与调度中枢
// 职责：初始化、定时器、事件绑定、将 UI 与 Store 绑定
// ============================================================

document.getElementById("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFund();
});

observeState("INDICES", UI_updateIndices);
observeState("FUNDS", () => {
  UI_updateFunds();
  syncCloud("push");
});
observeState("LOCAL_CONFIG", () => {
  UI_updateLocalConfig();
  syncCloud("push");
});

updateClock();
setInterval(updateClock, 1000);

syncCloud("pull").then((ok) => {
  // pull 成功时 syncCloud 内部已调用 refreshData，无需重复
  if (!ok) refreshData();
});

setInterval(() => {
  if (!document.hidden) fetchIndices();
}, SYS_CONFIG.REFRESH_IDX);
setInterval(() => {
  if (!document.hidden) refreshData();
}, SYS_CONFIG.REFRESH_API);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    fetchIndices();
    refreshData();
  }
});
