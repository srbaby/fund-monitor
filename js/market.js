// Jany 基金看板 - 大盘市场模块
// 职责：市场状态机、时钟、指数拉取与渲染

let _mktOpen = null;
const idxPrev = {};

// 市场状态机
function getMarketState() {
  const n = new Date();
  const d = n.getDay(), t = n.getHours() * 60 + n.getMinutes();
  if (d === 0 || d === 6) return 'WEEKEND';
  if (t < SYS_CONFIG.T_PRE_MARKET) return 'BEFORE_PRE';
  if (t < SYS_CONFIG.T_OPEN) return 'PRE_MARKET';
  if ((t >= SYS_CONFIG.T_OPEN && t < SYS_CONFIG.T_MID_BREAK) ||
      (t >= SYS_CONFIG.T_AFTERNOON && t < SYS_CONFIG.T_CLOSE)) return 'TRADING';
  if (t >= SYS_CONFIG.T_MID_BREAK && t < SYS_CONFIG.T_AFTERNOON) return 'MID_BREAK';
  return 'POST_MARKET';
}

// 今日日期字符串（全局复用）
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 时钟与市场状态标签
function updateClock() {
  const n = new Date();
  document.getElementById('liveTime').textContent = [n.getHours(), n.getMinutes(), n.getSeconds()].map(v => String(v).padStart(2, '0')).join(':');
  document.getElementById('liveDate').textContent = `${n.getFullYear()}/${String(n.getMonth()+1).padStart(2,'0')}/${String(n.getDate()).padStart(2,'0')} ${DAYS[n.getDay()]}`;

  const state = getMarketState();
  if (state !== _mktOpen) {
    _mktOpen = state;
    document.getElementById('mktDot').className = 'mkt-dot' + (state === 'TRADING' ? ' open' : '');
    const labels = {
      WEEKEND: '休市·周末', BEFORE_PRE: '盘前', PRE_MARKET: '盘前集合',
      TRADING: '交易中', MID_BREAK: '午休', POST_MARKET: '已收盘'
    };
    document.getElementById('mktLabel').textContent = labels[state] || '待机';
  }
}

// 指数拉取
function fetchIndices() {
  return new Promise(resolve => {
    const cb = '_idx_' + Date.now();
    let done = false;
    const s = document.createElement('script');
    const fin = () => { if (!done) { done = true; s.remove(); resolve(); } };

    window[cb] = function(data) {
      fin(); delete window[cb];
      const diff = data?.data?.diff; if (!diff) return;
      const map = {};
      diff.forEach(d => { map[d.f12] = d; });

      if (map['000300']?.f2 && map['000300']?.f18) {
        window._rt_csi300_price = parseFloat(map['000300'].f2);
        window._rt_csi300_yest = parseFloat(map['000300'].f18);
        if (typeof updatePeBar === 'function' && document.getElementById('peModal')?.style.display !== 'flex') {
          updatePeBar();
        }
      }
      renderIndices(map);
    };

    s.src = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14,f18&secids=1.000300,1.000510,1.000905,2.H30269,1.000012,116.HSI,124.HSI,100.HSI&cb=${cb}&_=${Date.now()}`;
    s.onerror = fin;
    setTimeout(fin, 5000);
    document.head.appendChild(s);
  });
}

// 指数栏渲染
function renderIndices(map) {
  document.getElementById('idxBar').innerHTML = INDICES.map(idx => {
    const d = map[idx.id];
    if (!d || !d.f2) return `<div class="idx-cell"><div class="idx-lbl">${idx.lbl}</div><div class="idx-row"><div class="idx-chg flat">—</div></div></div>`;

    const price = typeof d.f2 === 'number' ? d.f2.toFixed(2) : String(d.f2);
    const pct = d.f3 ?? 0;
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const sign = pct > 0 ? '+' : '';
    const old = idxPrev[idx.id];
    const flash = old && old !== price ? (parseFloat(price) > parseFloat(old) ? 'flash-up' : 'flash-down') : '';
    idxPrev[idx.id] = price;

    return `<div class="idx-cell ${cls} ${flash}">
      <div class="idx-lbl">${idx.lbl}</div>
      <div class="idx-row">
        <div class="idx-chg ${cls}">${sign}${typeof pct === 'number' ? pct.toFixed(2) : pct}%</div>
        <div class="idx-price">${price}</div>
      </div>
    </div>`;
  }).join('');
}