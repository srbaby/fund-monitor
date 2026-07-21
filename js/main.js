// ============================================================
// main.js - 系统启动与调度中枢
// 职责：初始化、定时器、事件绑定、将 UI 与 Store 绑定
// ============================================================

document.getElementById("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addFund();
});

// 指数到货除了重画指数条，还要重算基准代理（D-022）：代理估值是权益%、持仓总额、
// 最新收益、估算列的共同输入，指数一跳它们全都该跟着动。
// reapplyProxyEstimates 内部走 setLastResults → 广播 FUNDS → UI_updateFunds，
// 故这里不必再显式调 UI_updateFunds；无持仓/无结果时它直接返回，不会空转。
// 这条线也是冷启动竞态的解药：指数晚于净值到货时，那一轮 results 里没有代理值，
// 全靠这里补算——否则顶部会卡在「-」直到 60 秒后的下一次净值刷新。
observeState("INDICES", () => {
  UI_updateIndices();
  reapplyProxyEstimates();
});
// FUNDS 广播由净值刷新和列表增删共同触发，云推送只在配置变更时需要，
// 由 addFund / delFund / saveHoldings / confirmPe 各自显式调用 syncCloud
observeState("FUNDS", UI_updateFunds);
observeState("LOCAL_CONFIG", () => {
  UI_updateLocalConfig();
});

UI_updateIndices();
updateClock();
setInterval(updateClock, 1000);

syncCloud("pull").then((ok) => {
  // pull 成功时 syncCloud 内部已调用 refreshData，无需重复
  if (!ok) refreshData();
  const { id, token } = loadGistConfig();
  if (id && token) _verifyCloudConfig(id, token);
});
pullPeEngine();
// 指数与旁路PE快照同属一次网关调用，fetchIndices 内部已写入 QQIndex
fetchIndices();

setInterval(() => {
  if (!document.hidden) {
    fetchIndices();
  }
}, REFRESH_IDX);
setInterval(() => {
  if (!document.hidden) refreshData();
}, REFRESH_API);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    fetchIndices();
    refreshData();
    pullPeEngine();
    const { id, token } = loadGistConfig();
    if (id && token) _verifyCloudConfig(id, token);
  }
});
