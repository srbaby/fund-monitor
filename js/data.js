// ============================================================
// data.js - 数据获取层
// 职责：所有网络请求、JSONP 管理、TTL 缓存、数据标准化输出
// 不含 DOM 操作，不含业务计算
// ============================================================

// ---- 全局状态 ----
window._rt_csi300_price = null;

// ---- 估算数据 JSONP ----
window.jsonpResolvers = {};
window.jsonpgz = function(data) {
  if (data?.fundcode && window.jsonpResolvers[data.fundcode]) {
    window.jsonpResolvers[data.fundcode](data);
    delete window.jsonpResolvers[data.fundcode];
  }
};

function fetchEst(code) {
  return new Promise(resolve => {
    let done = false;
    const s   = document.createElement('script');
    const fin = v => { if (!done) { done = true; delete window.jsonpResolvers[code]; s.remove(); resolve(v); } };
    window.jsonpResolvers[code] = fin;
    s.src     = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    s.onerror = () => fin(null);
    setTimeout(() => fin(null), 3000);
    document.head.appendChild(s);
  });
}

// ---- 官方净值（串行队列 + TTL 缓存）----
const offCache = {};
const offQ     = [];
let   offBusy  = false;

function fetchOff(code) {
  const now      = new Date();
  const nowTs    = now.getTime();
  const timeNum  = now.getHours() * 60 + now.getMinutes();
  const day      = now.getDay();
  const todayStr = todayDateStr();
  const cached   = offCache[code];

  if (cached) {
    const isTodayData = cached.data?.date === todayStr;
    const ttl = (isTodayData || day === 0 || day === 6) ? 12 * 3600000
      : timeNum >= 19 * 60 + 30 ? 5 * 60000
      : 3600000;
    if (nowTs - cached.ts < ttl) return Promise.resolve(cached.data);
  }

  return new Promise(r => {
    const resolve = val => { if (val) offCache[code] = {ts: Date.now(), data: val}; r(val); };
    offQ.push({code, resolve});
    drainOff();
  });
}

function drainOff() {
  if (offBusy || !offQ.length) return;
  offBusy = true;
  const {code, resolve} = offQ.shift();
  let done = false;
  const s   = document.createElement('script');
  const fin = v => { if (!done) { done = true; window.apidata = undefined; s.remove(); resolve(v); offBusy = false; setTimeout(drainOff, 30); } };

  s.src    = `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=1&v=${Date.now()}`;
  s.onload = () => {
    try {
      const html = window.apidata?.content;
      if (html) {
        const tr = html.match(/<tbody>\s*<tr>(.*?)<\/tr>/i);
        if (tr) {
          const tds = tr[1].match(/<td[^>]*>(.*?)<\/td>/g).map(td => td.replace(/<[^>]+>/g, '').trim());
          if (tds.length >= 4) {
            const date = tds[0], nav = tds[1];
            const pct  = (tds[3] && tds[3] !== '---') ? parseFloat(tds[3].replace('%', '')) : null;
            fin({nav: Number(nav).toFixed(4), pct: pct != null ? pct.toFixed(2) : null, date});
            return;
          }
        }
      }
      fin(null);
    } catch(e) { fin(null); }
  };
  s.onerror = () => fin(null);
  setTimeout(() => fin(null), 3000);
  document.head.appendChild(s);
}

// ---- 单只基金合并拉取 ----
async function fetchSingleFund(code) {
  const [est, off] = await Promise.all([fetchEst(code), fetchOff(code)]);
  if (!est && !off) return {code, error: true};
  return {
    code,  error: false,
    name:    est?.name || NAMES[code] || `基金 ${code}`,
    estPct:  est?.gszzl != null && est.gszzl !== '' ? parseFloat(est.gszzl) : null,
    estVal:  est?.gsz   || null,
    estTime: est?.gztime || null,
    offPct:  off?.pct != null ? parseFloat(off.pct) : null,
    offVal:  off?.nav  || est?.dwjz || null,
    offDate: off?.date || est?.jzrq || null,
    baseNav:  est?.dwjz ? parseFloat(est.dwjz) : null,
    baseDate: est?.jzrq || null
  };
}

// ---- 指数拉取 ----
function fetchIndices() {
  return new Promise(resolve => {
    const cb  = '_idx_' + Date.now();
    let done  = false;
    const s   = document.createElement('script');
    const fin = () => { if (!done) { done = true; s.remove(); resolve(); } };

    window[cb] = function(data) {
      fin(); delete window[cb];
      const diff = data?.data?.diff; if (!diff) return;
      const map  = {};
      diff.forEach(d => { map[d.f12] = d; });
      if (map['000300']?.f2) {
        window._rt_csi300_price = parseFloat(map['000300'].f2);
        if (document.getElementById('peModal')?.style.display !== 'flex') updatePeBar();
      }
      renderIndices(map);
    };

    s.src     = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14&secids=1.000300,1.000510,1.000905,2.H30269,1.000012,116.HSI,124.HSI,100.HSI&cb=${cb}&_=${Date.now()}`;
    s.onerror = fin;
    setTimeout(fin, 5000);
    document.head.appendChild(s);
  });
}

// ---- 净值取用（供 engine.js 使用）----
function getNavByCode(code) {
  const f = _lastResults.find(r => r.code === code);
  if (!f) return null;
  const offD = f.offDate ? f.offDate.slice(0, 10) : '';
  const estD = f.estTime ? f.estTime.slice(0, 10) : '';
  if (f.offVal && (!estD || offD >= estD)) return parseFloat(f.offVal);
  if (f.estVal) return parseFloat(f.estVal);
  return null;
}