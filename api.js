// 全局状态跨文件共享
window._rt_csi300_price = null; 
window._rt_csi300_yest = null; 
window.jsonpResolvers = {};

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
// 3. 获取官方净值 (东方财富 HTML 爬取队列)
// ==========================================
const offQ = []; let offBusy = false;
function fetchOff(code) {
  return new Promise(r => { offQ.push({code, resolve: r}); drainOff(); });
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