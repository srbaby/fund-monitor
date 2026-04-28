// ============================================================
// data.js - 数据获取层 (v3.1 架构师重构版 - 消灭并发冲突)
// 职责：网络请求、数据标准化输出、更新 store 状态
// ============================================================

window._rt_csi300_price = null;
window.jsonpResolvers = {};

window.jsonpgz = function (data) {
  if (data?.fundcode && window.jsonpResolvers[data.fundcode]) {
    window.jsonpResolvers[data.fundcode](data);
    delete window.jsonpResolvers[data.fundcode];
  }
};

// [架构师优化]：增加了 onScriptLoad 闭包传参，精确锁定宿主元素，彻底解决 DOM 抓取引发的并发劫持
function injectScript(url, timeoutMs, onResolve, onScriptLoad) {
  let done = false;
  const s = document.createElement("script");
  const fin = (val) => {
    if (!done) {
      done = true;
      s.remove();
      onResolve(val);
    }
  };
  s.src = url;
  if (onScriptLoad) {
    s.onload = () => onScriptLoad(fin);
  }
  s.onerror = () => fin(null);
  setTimeout(() => fin(null), timeoutMs);
  document.head.appendChild(s);
  return fin;
}

function fetchEst(code) {
  return new Promise((resolve) => {
    const fin = injectScript(
      `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`,
      3000,
      (v) => {
        delete window.jsonpResolvers[code];
        resolve(v);
      },
    );
    window.jsonpResolvers[code] = fin;
  });
}

const offCache = {};
const offQ = [];
let offBusy = false;

window.expireOffCache = function() {
  for (let k in offCache) {
    offCache[k].ts = 0; 
  }
};

function fetchOff(code) {
  const now = new Date(),
    timeNum = now.getHours() * 60 + now.getMinutes(),
    day = now.getDay(),
    cached = offCache[code];

  if (cached) {
    const isTodayData = cached.data?.date === todayDateStr();
    const ttl =
      isTodayData || day === 0 || day === 6
        ? 12 * 3600000
        : timeNum >= 19 * 60 + 30
          ? 5 * 60000
          : 3600000;
    if (now.getTime() - cached.ts < ttl) return Promise.resolve(cached.data);
  }

  return new Promise((resolve) => {
    offQ.push({
      code,
      resolve: (val) => {
        if (val) {
          offCache[code] = { ts: Date.now(), data: val };
          resolve(val);
        } else {
          if (cached) {
            offCache[code].ts = Date.now(); 
            resolve(cached.data);
          } else {
            resolve(null);
          }
        }
      },
    });
    drainOff();
  });
}

function drainOff() {
  if (offBusy || !offQ.length) return;
  offBusy = true;
  const { code, resolve } = offQ.shift();

  // [架构师优化]：直接通过第四个参数将解析逻辑绑定在当前脚本的 onload 上，逻辑绝对严密
  injectScript(
    `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=1&v=${Date.now()}`,
    3000,
    (v) => {
      window.apidata = undefined;
      offBusy = false;
      resolve(v);
      setTimeout(drainOff, 30);
    },
    (fin) => {
      try {
        const html = window.apidata?.content;
        if (html) {
          const tr = html.match(/<tbody>\s*<tr>(.*?)<\/tr>/i);
          if (tr) {
            const tds = tr[1]
              .match(/<td[^>]*>(.*?)<\/td>/g)
              .map((td) => td.replace(/<[^>]+>/g, "").trim());
            if (tds.length >= 4) {
              const pct =
                tds[3] && tds[3] !== "---"
                  ? parseFloat(tds[3].replace("%", ""))
                  : null;
              return fin({
                nav: Number(tds[1]).toFixed(4),
                pct: pct != null ? pct.toFixed(2) : null,
                date: tds[0],
              });
            }
          }
        }
        fin(null);
      } catch (e) {
        fin(null);
      }
    }
  );
}

async function fetchSingleFund(code) {
  const [est, off] = await Promise.all([fetchEst(code), fetchOff(code)]);
  if (!est && !off) return { code, error: true };
  return {
    code,
    error: false,
    name: est?.name || NAMES[code] || `基金 ${code}`,
    estPct:
      est?.gszzl != null && est.gszzl !== "" ? parseFloat(est.gszzl) : null,
    estVal: est?.gsz || null,
    estTime: est?.gztime || null,
    offPct: off?.pct != null ? parseFloat(off.pct) : null,
    offVal: off?.nav || est?.dwjz || null,
    offDate: off?.date || est?.jzrq || null,
    baseNav: est?.dwjz ? parseFloat(est.dwjz) : null,
    baseDate: est?.jzrq || null,
  };
}

let _idxCounter = 0;

function fetchIndices() {
  return new Promise((resolve) => {
    const cb = "_idx_" + Date.now() + "_" + _idxCounter++;
    const fin = injectScript(
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14&secids=1.000300,1.000510,1.000905,2.H30269,1.000012,116.HSI,124.HSI,100.HSI&cb=${cb}&_=${Date.now()}`,
      5000,
      () => {
        delete window[cb];
        resolve();
      },
    );

    window[cb] = function (data) {
      fin();
      const diff = data?.data?.diff;
      if (!diff) return;
      const map = {};
      diff.forEach((d) => {
        map[d.f12] = d;
      });
      if (map["000300"]?.f2)
        window._rt_csi300_price = parseFloat(map["000300"].f2);

      setIndices(map);
    };
  });
}

function getNavByCode(code) {
  const f = getLastResults().find((r) => r.code === code);
  if (!f) return null;
  const offD = f.offDate ? f.offDate.slice(0, 10) : "",
    estD = f.estTime ? f.estTime.slice(0, 10) : "";
  if (f.offVal && (!estD || offD >= estD)) return parseFloat(f.offVal);
  if (f.estVal) return parseFloat(f.estVal);
  return null;
}
