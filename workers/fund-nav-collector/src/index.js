// ============================================================
// fund-nav-collector — 官方净值采集器（详见本目录 README 与 docs/02-系统架构.md）
//
// 存在理由：官方净值 19:00–23:00 陆续披露，而那个时段用户大概率没开看板。
// 浏览器里做轮询等于假设有人开着；更要命的是浏览器**只有腾讯一路**——东财
// FundMNFInfo 前端直连被 ErrCode:61136 拦（需 APP 签名），只有服务端调得通。
// 所以「双源抢先」这件事只可能发生在服务端。
//
// ── 存储模型（2026-08-05 重做，取代原来的「按日期存整份记录 + 指针 + 缺谁再回填」）──
// KV 里只有一把钥匙 `nav:funds`，每只基金一个条目、条目里最多两行：
//
//   funds[code] = { name, seeded, rows: [最新净值日, 前一净值日] }
//   row         = { date, nav, pct, src, at, gotAt }
//
//   date  行的**唯一身份**，净值自己的日期（北京时间）。滚不滚动、算不算今天、
//         收益拿谁当基准，全部只看它。
//   at    对外时间戳，日期部分**恒等于 date**。看板按 at 的日期判净值日，
//         所以补抓回来的旧净值必须带自己的日期，绝不能带成抓取当天——
//         否则看板会把昨天的净值当成今天刚出的，今天的收益直接算错。
//   gotAt 真实抓取时刻（北京时间），只作诊断留痕，不参与任何判断。
//
// 由此得到三条不变量，今晚那种「晚上滚动到一半某只基金整个消失」不可能再发生：
//   1. 只增不清：新净值只在 date 更晚时前插，任何情况下不清空已有行。
//   2. 一只基金的两行自带日期，不依赖任何「今天那份 / 昨天那份」的拼接。
//   3. 基金从看板删除 → 整个条目删除，不留残留。
//
// 每分钟一跳：先补种（新基金抓最近两个交易日），再两源并行抢当日净值。
// 全部到齐即早退，后续 cron 空转 ~1ms 不打上游。
// ============================================================

const BJ_OFFSET_MS = 8 * 3_600_000;
const TIMEOUT_MS = 10_000; // 跨境跳 2s 会频繁 flap（见 fund-market-api upstreams.mjs:116），设宽
const CODES_CACHE_MS = 5 * 60_000; // 换产品最多 5 分钟生效
const NAV_KEY = "nav:funds";
const ROWS_PER_FUND = 2; // 最新 + 前一净值日。前一日是收益基准，永远不许被挤掉
const LIVE_SOURCES = new Set(["eastmoney", "tencent"]); // 参与「谁先抢到」的源；history 是补种，不参与

// 北京时间：把 UTC 毫秒加 8 小时后按 UTC 读，等价于北京墙上时间。
// 后台所有日期时间一律走这两个函数，不碰运行环境本机时区。
function bjNow() {
  return new Date(Date.now() + BJ_OFFSET_MS);
}
function bjDateStr() {
  return bjNow().toISOString().slice(0, 10);
}
function bjStamp(ms = Date.now()) {
  return new Date(ms + BJ_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19);
}

function isDateStr(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// 对外时间戳：日期部分锁死为净值日期，时刻部分只是好看。真实抓取时刻在 gotAt 里。
function stampOn(date, gotAt) {
  if (gotAt && gotAt.slice(0, 10) === date) return gotAt;
  return `${date} 00:00:00`;
}

function normalizeRow(row) {
  if (!isDateStr(row?.date) || !(row.nav > 0)) return null;
  const gotAt = typeof row.gotAt === "string" ? row.gotAt : null;
  return {
    date: row.date,
    nav: Number(row.nav),
    pct: Number.isFinite(row.pct) ? Number(row.pct) : null,
    src: typeof row.src === "string" ? row.src : null,
    at: stampOn(row.date, typeof row.at === "string" ? row.at : gotAt),
    gotAt,
  };
}

// KV 里的东西一律当外部输入处理：结构不对的条目直接丢，不让它污染后面的判断。
function normalizeState(raw) {
  const funds = {};
  for (const [code, entry] of Object.entries(raw?.funds || {})) {
    if (!/^\d{6}$/.test(code)) continue;
    const rows = (Array.isArray(entry?.rows) ? entry.rows : [])
      .map(normalizeRow)
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, ROWS_PER_FUND);
    if (!rows.length) continue;
    funds[code] = {
      name: entry?.name || null,
      seeded: entry?.seeded === true,
      rows,
    };
  }
  return { updatedAt: raw?.updatedAt || null, funds };
}

// 唯一的写入口。返回是否真的改了东西——没改就不落盘，省 KV 免费写配额（1000/天）。
//
// 三条判据，缺一不可：
//   · date 比现有最新行更晚 → 前插，挤掉第三行（-2day 自动出局，-1day 必然保留）
//   · date 与某行相同 → **原样不动**（先到先得，src/at/gotAt 不可变）
//   · date 比最新行早、且第二行空缺或更早 → 填进第二行（补种走的就是这条）
function putRow(entry, row) {
  const normalized = normalizeRow(row);
  if (!normalized) return false;
  const rows = entry.rows;
  if (rows.some((existing) => existing.date === normalized.date)) return false;

  if (!rows.length || normalized.date > rows[0].date) {
    rows.unshift(normalized);
    entry.rows = rows.slice(0, ROWS_PER_FUND);
    return true;
  }
  if (rows.length < ROWS_PER_FUND || normalized.date > rows[ROWS_PER_FUND - 1].date) {
    rows.push(normalized);
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    entry.rows = rows.slice(0, ROWS_PER_FUND);
    return true;
  }
  return false;
}

function ensureEntry(state, code) {
  if (!state.funds[code]) state.funds[code] = { name: null, seeded: false, rows: [] };
  return state.funds[code];
}

// 上游抓取使用 cache-busting 参数 + cacheTtl:0：
// 部分上游前面挂第三方 CDN，会按出口 IP 把响应缓存 40+ 分钟不更新。
async function fetchUpstream(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const busted = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
  try {
    const response = await fetch(busted, {
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://quote.eastmoney.com/",
        "User-Agent": "Mozilla/5.0 (compatible; fund-nav-collector/1.0)",
        "Cache-Control": "no-cache",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

const EM_APP_PARAMS = {
  plat: "Android",
  appType: "ttjj",
  product: "EFund",
  Version: "1",
  deviceid: "fund-nav-collector",
};

// 东财 FundMNFInfo：一次批量取**最新一期**。字段 NAV / NAVCHGRT / PDATE，旧版镜像用 DWJZ / JZZZL / FSRQ。
// 注意 NAVCHGRT 只有 2 位小数（"1.98"），腾讯给的是 4 位（"1.9821"）——同一只基金
// 两源精度不同，切源时涨跌幅会有末位跳变，这是上游差异，不是 bug。
async function fetchEastmoney(codes) {
  const params = new URLSearchParams({
    Fcodes: codes.join(","),
    pageIndex: "1",
    pageSize: "200",
    ...EM_APP_PARAMS,
  });
  const response = await fetchUpstream(
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?${params}`,
  );
  const payload = await response.json();
  const out = new Map();
  if (!payload?.Success || !Array.isArray(payload.Datas)) return out;
  for (const item of payload.Datas) {
    const nav = Number(item.NAV ?? item.DWJZ);
    const pct = Number(item.NAVCHGRT ?? item.JZZZL);
    const date = item.PDATE ?? item.FSRQ;
    if (!item.FCODE || !(nav > 0) || !Number.isFinite(pct) || !date) continue;
    out.set(String(item.FCODE), {
      nav,
      pct,
      date: String(date).slice(0, 10),
      name: item.SHORTNAME || null,
    });
  }
  return out;
}

// 腾讯 jj{code}：GBK，必须 TextDecoder("gbk")，UTF-8 会中文乱码且字段错位。
// 字段布局 [1]名称 [2]估算净值 [3]估算% [4]估算时间 [5]官方净值 [6]累计 [7]官方% [8]官方日期
// [2][3] 是已失效的历史估值字段，本采集器只取官方块。
async function fetchTencent(codes) {
  const response = await fetchUpstream(
    `https://qt.gtimg.cn/q=${codes.map((code) => `jj${code}`).join(",")}`,
  );
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const out = new Map();
  for (const match of text.matchAll(/v_jj(\d{6})="([\s\S]*?)"\s*;/g)) {
    const fields = match[2].split("~");
    if (fields.length < 9) continue;
    const nav = Number(fields[5]);
    const pct = Number(fields[7]);
    const date = fields[8];
    if (!(nav > 0) || !Number.isFinite(pct) || !date) continue;
    out.set(match[1], {
      nav,
      pct,
      date: String(date).slice(0, 10),
      name: fields[1] || null,
    });
  }
  return out;
}

// 补种：新基金加进看板时，它在 KV 里一行都没有，而两个实时源只给「最新一期」——
// 单靠它们，新基金要等到当晚自己的净值披露才第一次有数，白天整只是空的（今天下午就是这样）。
// 东财历史净值接口按单只给出最近若干期，取两期正好补齐「最新 + 前一净值日」。
// 只在缺行时打，且成功后打 seeded 标记，避免每分钟都去问同一只。
async function fetchHistory(code) {
  const params = new URLSearchParams({
    FCODE: code,
    pageIndex: "1",
    pageSize: String(ROWS_PER_FUND),
    ...EM_APP_PARAMS,
  });
  const response = await fetchUpstream(
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?${params}`,
  );
  const payload = await response.json();
  if (!payload?.Success || !Array.isArray(payload.Datas)) return null;
  const rows = [];
  for (const item of payload.Datas) {
    const nav = Number(item.DWJZ);
    const pct = Number(item.JZZZL);
    const date = String(item.FSRQ || "").slice(0, 10);
    if (!isDateStr(date) || !(nav > 0)) continue;
    // 补种行的 at 用净值自己的日期，gotAt 记真实抓取时刻——这两者分开正是本次重做的要点。
    rows.push({
      date,
      nav,
      pct: Number.isFinite(pct) ? pct : null,
      src: "history",
      at: stampOn(date, null),
      gotAt: bjStamp(),
    });
  }
  return rows;
}

// 目标基金列表：跟随看板。前端增删基金 → saveFunds → syncCloud("push_config")
// → Gist fm_config.json 的 f 字段，所以这里读它就自动同步，用户无需改配置。
//
// **失败必须可见**：读不到就静默回退 FALLBACK_CODES 的话，token 过期 / 权限不足 /
// Gist 被删这些情况都表现为"Worker 一直采着写死的那几只"，而看板上新加的基金没数据，
// 从日志里完全看不出根因。故返回 { codes, source, error }，一路带到 collect 的返回值里，
// 打一次 /v1/collect 就能看出这一跳的列表到底是从哪来的。
async function fetchGistCodes(env) {
  if (!env.GIST_ID || !env.GIST_TOKEN) {
    return { codes: null, error: "gist_not_configured" };
  }
  try {
    const response = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
      headers: {
        Authorization: `token ${env.GIST_TOKEN}`,
        "User-Agent": "fund-nav-collector",
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      // 401/403 = token 无效或缺 gist 权限；404 = GIST_ID 写错或 Gist 已删
      return { codes: null, error: `gist_http_${response.status}` };
    }
    const gist = await response.json();
    const content = gist?.files?.["fm_config.json"]?.content;
    if (!content) return { codes: null, error: "gist_missing_fm_config" };
    const config = JSON.parse(content);
    const codes = Array.isArray(config.f)
      ? config.f.filter((code) => /^\d{6}$/.test(code))
      : null;
    if (!codes?.length) return { codes: null, error: "gist_empty_f_field" };
    return { codes, error: null };
  } catch (e) {
    return { codes: null, error: `gist_fetch_failed: ${e}` };
  }
}

async function loadCodes(env) {
  const cached = await env.NAV.get("codes", "json");
  if (cached?.codes && Date.now() - cached.ts < CODES_CACHE_MS) {
    return { codes: cached.codes, source: "cache", error: null };
  }
  const { codes: fresh, error } = await fetchGistCodes(env);
  if (fresh) {
    await env.NAV.put("codes", JSON.stringify({ ts: Date.now(), codes: fresh }));
    return { codes: fresh, source: "gist", error: null };
  }
  // Gist 读失败不清空已缓存的列表——宁可用旧列表，也不要因一次网络抖动漏采。
  // 但 source 要如实标成 stale-cache，别让它冒充 gist。
  if (cached?.codes) return { codes: cached.codes, source: "stale-cache", error };
  return {
    codes: String(env.FALLBACK_CODES || "")
      .split(",")
      .map((code) => code.trim())
      .filter((code) => /^\d{6}$/.test(code)),
    source: "fallback",
    error,
  };
}

async function loadState(env) {
  return normalizeState(await env.NAV.get(NAV_KEY, "json"));
}

// 「谁先抢到」只在实时源之间评选，且按 gotAt（真实抓取时刻）排，不按 at。
// 补种行的 at 是净值日期 00:00:00，若参与评选会永远"最早"，把标签变成谎话。
function electFirst(state, date) {
  let winner = null;
  for (const entry of Object.values(state.funds)) {
    const row = entry.rows[0];
    if (!row || row.date !== date || !LIVE_SOURCES.has(row.src)) continue;
    const key = row.gotAt || row.at;
    if (!winner || key < winner.key) winner = { key, src: row.src };
  }
  return winner?.src || null;
}

function latestDate(state) {
  let latest = null;
  for (const entry of Object.values(state.funds)) {
    const date = entry.rows[0]?.date;
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

// 端点响应体（网关 router.mjs 的同名端点必须逐字段一致——看板只认这一份形状）。
// 每只基金自带两行，所以这里不再有任何「今天那份 / 昨天那份」的拼接：
// 谁有数据谁就在，缺谁都不影响别人。
function buildNavPayload(state, today) {
  const date = latestDate(state) || today;
  const first = electFirst(state, date);
  const funds = {};
  let count = 0;
  let firstCount = 0;

  for (const [code, entry] of Object.entries(state.funds)) {
    const [row, previous] = entry.rows;
    if (!row) continue;
    if (row.date === date) {
      count += 1;
      if (first && row.src === first) firstCount += 1;
    }
    const previousNav = previous?.nav > 0 ? previous.nav : null;
    funds[code] = {
      nav: row.nav,
      // 百分比优先由相邻两次官方净值派生，只作快照展示；收益金额从不读它。
      // 两行不全时退回上游自报的官方涨跌幅，仍然不是"用百分比反推净值"。
      pct:
        previousNav == null
          ? (Number.isFinite(row.pct) ? row.pct : null)
          : ((row.nav - previousNav) / previousNav) * 100,
      name: entry.name || null,
      src: row.src,
      at: row.at,
      previousNav,
      previousDate: previousNav == null ? null : previous.date,
      previousPct: previousNav == null || !Number.isFinite(previous.pct) ? null : previous.pct,
    };
  }

  return {
    ok: true,
    date,
    previousDate:
      Object.values(state.funds).reduce(
        (acc, entry) => {
          const d = entry.rows[1]?.date;
          return d && (!acc || d > acc) ? d : acc;
        },
        null,
      ) || null,
    first,
    firstCount,
    count,
    updatedAt: state.updatedAt || null,
    funds,
  };
}

async function collect(env) {
  const today = bjDateStr();
  const state = await loadState(env);

  const { codes, source: codesSource, error: codesError } = await loadCodes(env);
  if (!codes.length) return { status: "no-codes", codesSource, codesError };

  // 僵尸清理：基金已从看板删除，它那两行就该整个走。**必须在早退判断之前**——
  // 放后面的话，当日一旦到齐就再没有跳会走到清理，僵尸能一直赖着，
  // 还会让 count / first 数错人。
  const wanted = new Set(codes);
  let pruned = 0;
  for (const code of Object.keys(state.funds)) {
    if (!wanted.has(code)) {
      delete state.funds[code];
      pruned += 1;
    }
  }

  // **节假日不早退，就是空跑一整天**。这里曾有一套「连续 30 跳没抓到就判非交易日收工」，
  // 实测永远跑不到，而且真跑到反而有害：某跳同时赶上 pruned>0（用户删基金）且没抓到任何
  // 净值时，收工标记会真落盘，把当晚正常的采集整个废掉。空跑的代价只是无效请求，可预测；
  // 误收工的代价是丢一整天净值，正是 2026-07-24 那种后果。别再把它加回来。

  // ── 第一步：补种。新基金在这里就把最近两个交易日补齐，不必等当晚 ──
  let seeded = 0;
  let seedError = null;
  const needSeed = codes.filter((code) => {
    const entry = state.funds[code];
    return !entry || (entry.rows.length < ROWS_PER_FUND && !entry.seeded);
  });
  if (needSeed.length) {
    // 历史接口只给净值，不给基金名。名字另从批量接口顺一次——否则补种出来的基金
    // 在看板上会显示成「基金 007044」，直到它自己的净值某天被实时源抢到才有名字。
    const [results, names] = await Promise.all([
      Promise.allSettled(needSeed.map((code) => fetchHistory(code))),
      fetchEastmoney(needSeed).catch(() => new Map()),
    ]);
    results.forEach((result, index) => {
      const code = needSeed[index];
      if (result.status !== "fulfilled" || !result.value) {
        seedError = seedError || `history_failed: ${result.reason || "empty"}`;
        return;
      }
      const entry = ensureEntry(state, code);
      let changed = false;
      for (const row of result.value) changed = putRow(entry, row) || changed;
      const name = names.get(code)?.name;
      if (name && entry.name !== name) {
        entry.name = name;
        changed = true;
      }
      entry.seeded = true; // 成功问过一次就不再每跳重问；失败不打标记，下一跳还会重试
      if (changed) seeded += 1;
    });
  }

  // ── 第二步：抢当日净值。全部到齐就早退，一个上游都不打 ──
  // complete **不落盘**，每跳按当前列表现算——否则用户 21:00 加一只基金时当晚已 complete，
  // 会一直早退，新基金永远抓不到。
  const complete = codes.every((code) => state.funds[code]?.rows[0]?.date === today);

  let added = 0;
  let renamed = 0; // 只补到名字、没添新行的情况也要落盘
  // 上游诊断，只在真正打了上游的那些跳里有意义；早退跳保持零值
  let diag = { emSize: 0, txSize: 0, emError: null, txError: null };
  if (!complete) {
    // 真竞争：两源谁先返回当日数据就用谁。
    // per-row gotAt 反映实际抢到时刻（毫秒级），跨跳仍先到先得、写入不可变。
    const [em, tx] = await Promise.allSettled([
      fetchEastmoney(codes).then((m) => ({ map: m, doneAt: Date.now() })),
      fetchTencent(codes).then((m) => ({ map: m, doneAt: Date.now() })),
    ]);
    const emRes = em.status === "fulfilled" ? em.value : null;
    const txRes = tx.status === "fulfilled" ? tx.value : null;
    diag = {
      emSize: emRes?.map.size || 0,
      txSize: txRes?.map.size || 0,
      emError: em.status === "rejected" ? String(em.reason) : null,
      txError: tx.status === "rejected" ? String(tx.reason) : null,
    };
    for (const code of codes) {
      const fromEm = emRes?.map.get(code);
      const fromTx = txRes?.map.get(code);
      // 只接受**当日**净值。原前端 bug 的根因正是没判这一条：东财在净值未披露时
      // 返回昨日数据且 size>0，于是整组被采纳，腾讯备源一次都轮不到。
      // 更早的日期不需要在这里兜底——补种已经把历史补齐了。
      const emOk = fromEm?.date === today;
      const txOk = fromTx?.date === today;
      if (!emOk && !txOk) continue;
      // 两源都有当日数据时按完成时间选先到的；只有一方有时用那一方。
      // 平局（doneAt 相等，毫秒级极少见）归东财，保留主源 tiebreaker。
      const useEm = emOk && (!txOk || emRes.doneAt <= txRes.doneAt);
      const picked = useEm
        ? { ...fromEm, src: "eastmoney", gotAt: bjStamp(emRes.doneAt) }
        : { ...fromTx, src: "tencent", gotAt: bjStamp(txRes.doneAt) };
      const entry = ensureEntry(state, code);
      if (picked.name && entry.name !== picked.name) {
        // 名字与净值行分开维护：这一跳可能没添新行（当日已记账），但名字仍可能是第一次拿到
        entry.name = picked.name;
        renamed += 1;
      }
      if (
        putRow(entry, {
          date: picked.date,
          nav: picked.nav,
          pct: picked.pct,
          src: picked.src,
          at: stampOn(picked.date, picked.gotAt),
          gotAt: picked.gotAt,
        })
      ) {
        added += 1;
      }
    }
  }

  // 落盘条件：有新增、有补种或有清理。纯早退跳不写，免得晚间 241 跳
  // 把 KV 免费写配额（1000/天）烧掉四分之一。
  const dirty = added > 0 || seeded > 0 || pruned > 0 || renamed > 0;
  if (dirty) {
    // 这里要的是「本份数据最后一次写盘的时刻」，与每行自己的 gotAt 语义不同，必须现算。
    state.updatedAt = bjStamp();
    await env.NAV.put(NAV_KEY, JSON.stringify(state));
  }

  const have = codes.filter((code) => state.funds[code]?.rows[0]?.date === today).length;
  if (complete) {
    return { status: "complete", have: codes.length, pruned, codesSource, codesError };
  }
  return {
    status: "collected",
    added,
    seeded,
    seedError,
    pruned,
    have,
    want: codes.length,
    first: electFirst(state, today),
    codesSource,
    codesError,
    ...diag,
  };
}

function corsHeaders(env) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "https://fund.bailuzun.com",
    "Cache-Control": "no-store",
  };
}

// collect / buildNavPayload 单独导出供测试用（test/collector.test.mjs）。
// Worker 运行时只认 default 导出，多这一行不影响 Dashboard 粘贴部署。
export { collect, buildNavPayload, normalizeState };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      collect(env)
        .then((result) => {
          console.log(JSON.stringify({ cron: event.cron, ...result }));
        })
        // ⚠️ **这个 catch 不许删**：没有它时 collect 抛错会让 .then 整个跳过，日志里一行都不留，
        // 看上去和"cron 压根没触发"一模一样。2026-07-24 的停采正是这样瞒过两个交易日的——
        // 采集器唯一的健康信号就是每跳这一行 JSON，静默失败等于把它关掉。
        .catch((e) => {
          console.log(
            JSON.stringify({
              cron: event.cron,
              status: "error",
              error: String(e && e.stack ? e.stack : e),
            }),
          );
        }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...corsHeaders(env),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/v1/nav/today") {
      // 与网关 router.mjs 的同名端点同口径。前端实际读网关；这里是调试用，
      // 行为不一致会让排查跑偏。
      const state = await loadState(env);
      return new Response(JSON.stringify(buildNavPayload(state, bjDateStr())), {
        headers: corsHeaders(env),
      });
    }

    // 手动触发，用于部署后立刻验证而不必等下一个整分钟
    if (url.pathname === "/v1/collect") {
      if (!env.COLLECT_TOKEN || url.searchParams.get("token") !== env.COLLECT_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401,
          headers: corsHeaders(env),
        });
      }
      // 手动触发的用途就是「立刻看看现在到底什么状态」，所以先丢掉 codes 缓存，
      // 强制这一跳真去读一次 Gist。否则命中 5 分钟缓存时 codesSource 恒为 "cache"，
      // 想验证 token 通不通反而验不出来。
      await env.NAV.delete("codes");
      // 手动触发是排查入口，异常必须**原样带回响应体**。裸 500 只会显示一句 Worker
      // threw exception，还得回头翻日志——而排查时最想知道的恰恰就是那句 message。
      try {
        const result = await collect(env);
        return new Response(JSON.stringify({ ok: true, ...result }), {
          headers: corsHeaders(env),
        });
      } catch (e) {
        return new Response(
          JSON.stringify({
            ok: false,
            status: "error",
            error: String(e && e.stack ? e.stack : e),
          }),
          { status: 500, headers: corsHeaders(env) },
        );
      }
    }

    return new Response(JSON.stringify({ ok: false, error: "not found" }), {
      status: 404,
      headers: corsHeaders(env),
    });
  },
};
