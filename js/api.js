// ==========================================
// 全局状态跨文件共享
// ==========================================
window._rt_csi300_price = null; 
window._rt_csi300_yest = null; 
window.jsonpResolvers = {};

// 官方净值防刷缓存字典
const offCache = {}; 

// ==========================================
// 1. 获取大盘指数 (东方财富 API)
// ==========================================
function fetchIndices() {
  return new Promise(resolve => {
    const cb = '_idx_' + Date.now();
    let done = false;
    const s = document.createElement('script');
    const fin = () => { if(!done){ done=true; s.remove(); resolve(); }};
    
    window[cb] = function(data) {
      fin(); delete window[cb];
      const diff = data?.data?.diff; if(!diff) return;
      const map = {}; diff.forEach(d => { map[d.f12] = d; });
      
      // 更新沪深300全局点位，用于拉格朗日定锚
      if(map['000300'] && map['000300'].f2 && map['000300'].f18) {
        window._rt_csi300_price = parseFloat(map['000300'].f2);
        window._rt_csi300_yest = parseFloat(map['000300'].f18);
        if(typeof updatePeBar === 'function' && document.getElementById('peModal')?.style.display !== 'flex') {
            updatePeBar();
        }
      }

      if(typeof renderIndices === 'function') renderIndices(map);
    };
    s.src = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14,f18&secids=1.000300,1.000510,1.000905,2.H30269,1.000012,116.HSI,124.HSI,100.HSI&cb=${cb}&_=${Date.now()}`;
    s.onerror = fin; setTimeout(fin, 5000); document.head.appendChild(s);
  });
}

// ==========================================
// 2. 获取盘中估算 (天天基金 JSONP)
// ==========================================
window.jsonpgz = function(data) {
  if(data?.fundcode && window.jsonpResolvers[data.fundcode]){
    window.jsonpResolvers[data.fundcode](data);
    delete window.jsonpResolvers[data.fundcode];
  }
};

function fetchEst(code) {
  return new Promise(resolve => {
    let done = false; const s = document.createElement('script');
    const fin = v => { if(!done){ done=true; delete window.jsonpResolvers[code]; s.remove(); resolve(v); }};
    window.jsonpResolvers[code] = fin;
    s.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    s.onerror = () => fin(null); setTimeout(() => fin(null), 3000); document.head.appendChild(s);
  });
}

// ==========================================
// 3. 获取官方净值 (带智能时间窗口的动态 TTL 短路机制)
// ==========================================
const offQ = []; let offBusy = false;

function fetchOff(code) {
  const now = new Date();
  const nowTs = now.getTime();
  const h = now.getHours();
  const m = now.getMinutes();
  const day = now.getDay();
  const timeNum = h * 60 + m; // 当前分钟数 (0-1439)
  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  const cached = offCache[code];

  if (cached) {
    let ttl = 30 * 60 * 1000; // 默认 30 分钟
    const isTodayData = cached.data && cached.data.date === todayStr;

    if (isTodayData) {
      // 【终极短路】已刷出今日最新净值，锁定至明天，绝不再发请求
      ttl = 12 * 60 * 60 * 1000; 
    } else if (day === 0 || day === 6) {
      // 【周末短路】官方周末不更新，超长待机
      ttl = 12 * 60 * 60 * 1000;
    } else if (timeNum >= 19 * 60 + 30) {
      // 【盲盒开奖期】交易日 19:30 - 24:00，且还没拿到今日数据：每 5 分钟探测一次
      ttl = 5 * 60 * 1000;
    } else {
      // 【日间静默期】交易日 00:00 - 19:30，绝不可能有今日数据，1小时探测一次即可
      ttl = 60 * 60 * 1000;
    }

    // 缓存未过期，直接返回内存数据，阻断真实网络请求
    if (nowTs - cached.ts < ttl) {
      return Promise.resolve(cached.data);
    }
  }

  return new Promise(r => { 
    // 拦截请求成功的回调，将结果写入缓存字典
    const cacheInterceptResolve = (val) => {
      if (val) offCache[code] = { ts: Date.now(), data: val };
      r(val);
    };
    offQ.push({code, resolve: cacheInterceptResolve}); 
    drainOff(); 
  });
}

function drainOff() {
  if(offBusy || !offQ.length) return;
  offBusy = true; const {code, resolve} = offQ.shift(); let done = false;
  const s = document.createElement('script');
  const fin = v => { if(!done){ done=true; window.apidata=undefined; s.remove(); resolve(v); offBusy=false; setTimeout(drainOff, 30); }};
  
  s.src = `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=1&v=${Date.now()}`;
  s.onload = () => {
    try {
      const html = window.apidata?.content;
      if(html){
        const tr = html.match(/<tbody>\s*<tr>(.*?)<\/tr>/i);
        if(tr){
          const tds = tr[1].match(/<td[^>]*>(.*?)<\/td>/g).map(td => td.replace(/<[^>]+>/g,'').trim());
          if(tds.length >= 4){
            const date = tds[0], nav = tds[1]; let pct = null;
            if(tds[3] && tds[3] !== '---') pct = parseFloat(tds[3].replace('%',''));
            fin({ nav: Number(nav).toFixed(4), pct: pct != null ? pct.toFixed(2) : null, date });
            return;
          }
        }
      }
      fin(null);
    } catch(e) { fin(null); }
  };
  s.onerror = () => fin(null); setTimeout(() => fin(null), 3000); document.head.appendChild(s);
}

// ==========================================
// 4. 合并组装单一基金数据
// ==========================================
async function fetchSingleFund(code) {
  const [est, off] = await Promise.all([fetchEst(code), fetchOff(code)]);
  if(!est && !off) return { code, error: true };
  return {
    code, error: false,
    name: est?.name || NAMES[code] || `基金 ${code}`,
    estPct: est?.gszzl != null && est.gszzl !== '' ? parseFloat(est.gszzl) : null,
    estVal: est?.gsz || null,
    estTime: est?.gztime || null,
    offPct: off?.pct != null ? parseFloat(off.pct) : null,
    offVal: off?.nav || est?.dwjz || null,
    offDate: off?.date || est?.jzrq || null
  };
}