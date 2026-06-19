// ============================================================
// data.js - 数据获取层
// 职责：网络请求、数据标准化输出、更新 store 状态
// ============================================================

window.jsonpResolvers = {};

window.jsonpgz = function (data) {
  if (data?.fundcode && window.jsonpResolvers[data.fundcode]) {
    window.jsonpResolvers[data.fundcode](data);
    delete window.jsonpResolvers[data.fundcode];
  }
};

function injectScript(url, timeoutMs, onResolve) {
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
  s.onerror = () => fin(null);
  setTimeout(() => fin(null), timeoutMs);
  document.head.appendChild(s);
  return fin;
}

function fetchEst(code) {
  return new Promise((resolve) => {
    const fin = injectScript(
      `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`,
      SYS_CONFIG.FETCH_EST_TIMEOUT,
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
        : timeNum >= SYS_CONFIG.T_OFF_UPDATE
          ? 5 * 60000
          : 3600000;
    if (now.getTime() - cached.ts < ttl) return Promise.resolve(cached.data);
  }
  return new Promise((resolve) => {
    offQ.push({
      code,
      resolve: (val) => {
        if (val) offCache[code] = { ts: Date.now(), data: val };
        resolve(val);
      },
    });
    drainOff();
  });
}

function drainOff() {
  if (offBusy || !offQ.length) return;
  offBusy = true;
  const { code, resolve } = offQ.shift();

  const s = document.createElement("script");
  let done = false;
  const fin = (val) => {
    if (!done) {
      done = true;
      s.remove();
      window.apidata = undefined;
      offBusy = false;
      resolve(val);
      setTimeout(drainOff, SYS_CONFIG.FETCH_OFF_DRAIN_DELAY);
    }
  };

  s.onload = () => {
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
  };
  s.onerror = () => fin(null);
  setTimeout(() => fin(null), SYS_CONFIG.FETCH_OFF_TIMEOUT);
  s.src = `https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=1&v=${Date.now()}`;
  document.head.appendChild(s);
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
let _indicesPromise = null;
let _qqScriptQueue = Promise.resolve();

function _numberOrNaN(value) {
  if (value == null || value === "") return NaN;
  return Number(value);
}

function _isValidIndices(map) {
  return INDICES.every(({ id }) => {
    const d = map?.[id];
    return (
      d?.f12 === id &&
      Number.isFinite(d.f2) &&
      d.f2 > 0 &&
      Number.isFinite(d.f3)
    );
  });
}

function _latestQuoteAt(map) {
  const values = Object.values(map)
    .map((d) => d.quoteAt || d.f124)
    .filter(Boolean);
  values.sort();
  return values.length ? values[values.length - 1] : null;
}

function _fetchPrimaryIndices() {
  return new Promise((resolve) => {
    const cb = "_idx_" + Date.now() + "_" + _idxCounter++;
    const s = document.createElement("script");
    let done = false;
    const finish = (map) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.remove();
      delete window[cb];
      resolve(map);
    };
    const timer = setTimeout(
      () => finish(null),
      SYS_CONFIG.FETCH_INDEX_TIMEOUT,
    );

    window[cb] = (data) => {
      try {
        const map = {};
        (data?.data?.diff || []).forEach((raw) => {
          const id = raw.f12 === "HSI" ? "HSI" : String(raw.f12 || "");
          map[id] = {
            ...raw,
            f2: _numberOrNaN(raw.f2),
            f3: _numberOrNaN(raw.f3),
            f12: id,
            quoteAt: raw.f124 || null,
          };
        });
        finish(_isValidIndices(map) ? map : null);
      } catch (e) {
        finish(null);
      }
    };
    s.onerror = () => finish(null);
    s.src = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14,f124&secids=1.000300,1.000510,1.000905,1.000832,1.000012,116.HSI,124.HSI,100.HSI&cb=${cb}&_=${Date.now()}`;
    document.head.appendChild(s);
  });
}

function _loadQQQuotes(query, variableNames) {
  const task = _qqScriptQueue.then(
    () =>
      new Promise((resolve) => {
        const s = document.createElement("script");
        s.charset = "GBK";
        let done = false;
        const finish = (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          s.remove();
          variableNames.forEach((name) => {
            window[name] = undefined;
          });
          resolve(result);
        };
        const timer = setTimeout(
          () => finish(null),
          SYS_CONFIG.FETCH_INDEX_TIMEOUT,
        );

        variableNames.forEach((name) => {
          window[name] = undefined;
        });
        s.onload = () => {
          const result = {};
          variableNames.forEach((name) => {
            result[name] = window[name];
          });
          finish(result);
        };
        s.onerror = () => finish(null);
        s.src = `https://qt.gtimg.cn/q=${query}&r=${Date.now()}`;
        document.head.appendChild(s);
      }),
  );
  _qqScriptQueue = task.catch(() => null);
  return task;
}

async function _fetchFallbackIndices() {
  const variableMap = {
    "000300": "v_sh000300",
    "000510": "v_sh000510",
    "000905": "v_sh000905",
    "000832": "v_sh000832",
    "000012": "v_sh000012",
    HSI: "v_hkHSI",
  };
  const rawMap = await _loadQQQuotes(
    "sh000300,sh000510,sh000905,sh000832,sh000012,hkHSI",
    Object.values(variableMap),
  );
  if (!rawMap) return null;

  const map = {};
  Object.entries(variableMap).forEach(([id, variableName]) => {
    const raw = rawMap[variableName];
    if (typeof raw !== "string") return;
    const f = raw.split("~");
    map[id] = {
      f2: _numberOrNaN(f[3]),
      f3: _numberOrNaN(f[32]),
      f12: id,
      f14: f[1] || INDICES.find((idx) => idx.id === id)?.lbl || id,
      f124: f[30] || null,
      quoteAt: f[30] || null,
    };
  });
  return _isValidIndices(map) ? map : null;
}

function fetchIndices() {
  if (_indicesPromise) return _indicesPromise;
  _indicesPromise = (async () => {
    const primary = await _fetchPrimaryIndices();
    if (primary) {
      setIndices(primary, {
        mode: "live",
        source: "primary",
        receivedAt: Date.now(),
        quoteAt: _latestQuoteAt(primary),
      });
      return;
    }

    const fallback = await _fetchFallbackIndices();
    if (fallback) {
      setIndices(fallback, {
        mode: "live",
        source: "fallback",
        receivedAt: Date.now(),
        quoteAt: _latestQuoteAt(fallback),
      });
      return;
    }
    setIndicesUnavailable();
  })().finally(() => {
    _indicesPromise = null;
  });
  return _indicesPromise;
}

// 腾讯指数快照：取沪深300实时总市值/PE_TTM（旁路PE引擎数据源）
// qt.gtimg 返回 `v_sh000300="..."` 全局变量赋值，~分隔：[3]点位 [30]时间戳 [39]PE [45]总市值(亿)
let _qqBusy = false;
function fetchQQIndex() {
  if (_qqBusy) return;
  _qqBusy = true;
  _loadQQQuotes("sh000300", ["v_sh000300"])
    .then((quotes) => {
      try {
        const raw = quotes?.v_sh000300;
        if (typeof raw === "string") {
          const f = raw.split("~");
          const d = {
            price: parseFloat(f[3]),
            ts: f[30] || "",
            pe: parseFloat(f[39]),
            mcap: parseFloat(f[45]),
          };
          if (d.price > 0) setQQIndex(d);
        }
      } catch (e) {}
    })
    .finally(() => {
      _qqBusy = false;
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

async function _cloudReadFile(gistId, token, filename) {
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: { Authorization: `token ${token}` },
    });
    const data = await res.json();
    return JSON.parse(data.files[filename].content);
  } catch (e) {
    console.error("Cloud Pull Failed", filename, e);
    return null;
  }
}

async function _cloudWriteFile(gistId, token, filename, payload) {
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: { [filename]: { content: JSON.stringify(payload) } },
      }),
    });
    return res.ok;
  } catch (e) {
    console.error("Cloud Push Failed", filename, e);
    return false;
  }
}

function cloudFetchPe(gistId, token) {
  return _cloudReadFile(gistId, token, GIST_FILE_PE);
}
function cloudFetchConfig(gistId, token) {
  return _cloudReadFile(gistId, token, GIST_FILE_CONFIG);
}
function cloudFetchPeEngine(gistId, token) {
  return _cloudReadFile(gistId, token, GIST_FILE_PE_ENGINE);
}
function cloudUpdatePe(gistId, token, peData) {
  return _cloudWriteFile(gistId, token, GIST_FILE_PE, peData);
}
function cloudUpdateConfig(gistId, token, payload) {
  return _cloudWriteFile(gistId, token, GIST_FILE_CONFIG, payload);
}
