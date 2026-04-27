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

// PWA 全局下拉强制重载整个系统 (绕过缓存)
let _tsY = 0;
document.addEventListener('touchstart', e => { 
  if (window.scrollY <= 0) _tsY = e.touches[0].clientY; 
}, {passive: true});

document.addEventListener('touchend', e => {
  // 当页面在顶部，且向下拉动超过 150px 时触发强刷
  if (window.scrollY <= 0 && _tsY > 0 && (e.changedTouches[0].clientY - _tsY > 150)) {
    window.location.href = window.location.pathname + '?_t=' + Date.now();
  }
  _tsY = 0;
});
