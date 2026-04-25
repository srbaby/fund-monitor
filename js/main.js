// Jany 基金看板 - 系统启动与调度中枢
// 职责：初始化、定时器、事件绑定，保持极简

document.getElementById('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') addFund(); });

updateClock();
setInterval(updateClock, 1000);
updatePeBar();
refreshData();

setInterval(() => { if (!document.hidden) fetchIndices(); }, SYS_CONFIG.REFRESH_IDX);
setInterval(() => { if (!document.hidden) refreshData(); }, SYS_CONFIG.REFRESH_API);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { fetchIndices(); refreshData(); } });