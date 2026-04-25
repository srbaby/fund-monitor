// Jany 基金看板 - 系统启动与调度中枢
// 职责：初始化、定时器、事件绑定，保持极简

document.getElementById('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') addFund(); });

// 手机端默认收窄，在 refreshData 渲染卡片之前设置，卡片直接以收窄状态渲染
if (window.innerWidth < 768) {
  allCollapsed = true;
  document.body.classList.add('collapsed-mode');
  document.getElementById('colBtn').textContent = '展开';
  document.getElementById('cycleBtn').style.display = '';
}

updateClock();
setInterval(updateClock, 1000);
updatePeBar();
refreshData();

setInterval(() => { if (!document.hidden) fetchIndices(); }, SYS_CONFIG.REFRESH_IDX);
setInterval(() => { if (!document.hidden) refreshData(); }, SYS_CONFIG.REFRESH_API);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { fetchIndices(); refreshData(); } });
