// ============================================================
// main.js - 系统启动与调度中枢
// 职责：初始化、定时器、事件绑定、将 UI 与 Store 绑定
// ============================================================

document.getElementById("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFund();
});

// 💥 见证极致性能：不同频道的数据变化，触发不同范围的 DOM 重绘
observeState("INDICES", UI_updateIndices);
observeState("FUNDS", UI_updateFunds);
observeState("LOCAL_CONFIG", UI_updateLocalConfig);

updateClock();
setInterval(updateClock, 1000);

refreshData(); // 这一句执行完后，整个齿轮就开始自动化运转了

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
