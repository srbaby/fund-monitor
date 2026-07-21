// ============================================================
// fund-nav-collector — 官方净值夜间采集器（详见 docs/DECISIONS.md D-023）
//
// 存在理由：官方净值 19:00–23:00 陆续披露，而那个时段用户大概率没开看板。
// 浏览器里做轮询等于假设有人开着；更要命的是浏览器**只有腾讯一路**——东财
// FundMNFInfo 前端直连被 ErrCode:61136 拦（需 APP 签名），只有服务端调得通。
// 所以「双源抢先」这件事只可能发生在服务端。
//
// 每分钟一跳，两源并行，逐只取当日净值，先到先得记账（谁先给出就记谁 + 记时刻）。
// 全部到齐即早退，后续 cron 空转 ~1ms 不打上游。
// ============================================================

const BJ_OFFSET_MS = 8 * 3_600_000;
const TIMEOUT_MS = 10_000; // 跨境跳 2s 会频繁 flap（见 fund-market-api upstreams.mjs:116），设宽
const CODES_CACHE_MS = 5 * 60_000; // 换产品最多 5 分钟生效
const IDLE_GIVE_UP = 30; // 连续 30 跳一条都没抓到 → 判为非交易日，当晚收工
const RECORD_TTL_S = 7 * 24 * 3600;

// 北京时间：把 UTC 毫秒加 8 小时后按 UTC 读，等价于北京墙上时间
function bjNow() {
  return new Date(Date.now() + BJ_OFFSET_MS);
}
function bjDateStr() {
  return bjNow().toISOString().slice(0, 10);
}
function bjStamp() {
  return bjNow().toISOString().replace("T", " ").slice(0, 19);
}

// 上游抓取。cache-busting 参数 + cacheTtl:0 是 D-009 的结论：
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

// 东财 FundMNFInfo：一次批量。字段 NAV / NAVCHGRT / PDATE，旧版镜像用 DWJZ / JZZZL / FSRQ。
// 注意 NAVCHGRT 只有 2 位小数（"1.98"），腾讯给的是 4 位（"1.9821"）——同一只基金
// 两源精度不同，切源时涨跌幅会有末位跳变，这是上游差异不是 bug（D-023 代价栏）。
async function fetchEastmoney(codes) {
  const params = new URLSearchParams({
    Fcodes: codes.join(","),
    pageIndex: "1",
    pageSize: "200",
    plat: "Android",
    appType: "ttjj",
    product: "EFund",
    Version: "1",
    deviceid: "fund-nav-collector",
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
// （[2][3] 自 2026-01 监管要求下线估值后恒为 0，见 D-015，本采集器只取官方块）
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

// 目标基金列表：跟随看板。前端增删基金 → saveFunds → syncCloud("push_config")
// → Gist fm_config.json 的 f 字段，所以这里读它就自动同步，用户无需改配置。
async function fetchGistCodes(env) {
  if (!env.GIST_ID || !env.GIST_TOKEN) return null;
  try {
    const response = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
      headers: {
        Authorization: `token ${env.GIST_TOKEN}`,
        "User-Agent": "fund-nav-collector",
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) return null;
    const gist = await response.json();
    const content = gist?.files?.["fm_config.json"]?.content;
    if (!content) return null;
    const config = JSON.parse(content);
    const codes = Array.isArray(config.f)
      ? config.f.filter((code) => /^\d{6}$/.test(code))
      : null;
    return codes?.length ? codes : null;
  } catch {
    return null;
  }
}

async function loadCodes(env) {
  const cached = await env.NAV.get("codes", "json");
  if (cached?.codes && Date.now() - cached.ts < CODES_CACHE_MS) return cached.codes;
  const fresh = await fetchGistCodes(env);
  if (fresh) {
    await env.NAV.put("codes", JSON.stringify({ ts: Date.now(), codes: fresh }));
    return fresh;
  }
  // Gist 读失败不清空已缓存的列表——宁可用旧列表，也不要因一次网络抖动漏采
  if (cached?.codes) return cached.codes;
  return String(env.FALLBACK_CODES || "")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => /^\d{6}$/.test(code));
}

async function collect(env) {
  const today = bjDateStr();
  const key = `nav:${today}`;
  const record = (await env.NAV.get(key, "json")) || {
    date: today,
    funds: {},
    first: null,
    idle: 0,
  };

  const codes = await loadCodes(env);
  if (!codes.length) return { status: "no-codes" };

  // 非交易日：连续 IDLE_GIVE_UP 跳一条都没抓到就收工，避免整晚空打上游。
  // 判据要求 funds 为空——已抓到一部分只是某几只发布晚，不能据此收工。
  if (record.done) return { status: "done-earlier", have: Object.keys(record.funds).length };

  // 早退：全部到齐。complete **不落盘**，每跳按当前列表现算——
  // 否则用户 21:00 加一只基金时当晚已 complete，会一直早退，新基金永远抓不到。
  if (codes.every((code) => record.funds[code])) {
    return { status: "complete", have: codes.length };
  }

  const [em, tx] = await Promise.allSettled([fetchEastmoney(codes), fetchTencent(codes)]);
  const emMap = em.status === "fulfilled" ? em.value : new Map();
  const txMap = tx.status === "fulfilled" ? tx.value : new Map();

  const at = bjStamp();
  let added = 0;
  for (const code of codes) {
    if (record.funds[code]) continue; // 先到先得：已记账的绝不覆盖，保证 at/src 不可变
    const fromEm = emMap.get(code);
    const fromTx = txMap.get(code);
    const emOk = fromEm?.date === today;
    const txOk = fromTx?.date === today;
    // 只接受**当日**净值。原前端 bug 的根因正是没判这一条：东财在净值未披露时
    // 返回昨日数据且 size>0，于是整组被采纳，腾讯备源一次都轮不到。
    if (!emOk && !txOk) continue;
    const picked = emOk ? { ...fromEm, src: "eastmoney" } : { ...fromTx, src: "tencent" };
    record.funds[code] = {
      nav: picked.nav,
      pct: picked.pct,
      name: picked.name,
      src: picked.src,
      at,
    };
    added += 1;
  }

  // first = 今晚最早抓到的那条的源。由**时间戳**决定而非写入顺序，
  // 所以任何设备任何时候读，算出来都一样。
  const entries = Object.values(record.funds);
  if (entries.length) {
    record.first = entries.reduce((a, b) => (a.at <= b.at ? a : b)).src;
  }

  record.idle = added > 0 ? 0 : (record.idle || 0) + 1;
  if (record.idle >= IDLE_GIVE_UP && entries.length === 0) record.done = true;
  record.updatedAt = at;

  await env.NAV.put(key, JSON.stringify(record), { expirationTtl: RECORD_TTL_S });

  return {
    status: "collected",
    added,
    have: entries.length,
    want: codes.length,
    first: record.first,
    emSize: emMap.size,
    txSize: txMap.size,
    emError: em.status === "rejected" ? String(em.reason) : null,
    txError: tx.status === "rejected" ? String(tx.reason) : null,
  };
}

function corsHeaders(env) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "https://fund.bailuzun.com",
    "Cache-Control": "no-store",
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      collect(env).then((result) => {
        console.log(JSON.stringify({ cron: event.cron, ...result }));
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
      const today = bjDateStr();
      const record = await env.NAV.get(`nav:${today}`, "json");
      const funds = record?.funds || {};
      const codes = Object.keys(funds);
      const first = record?.first || null;
      return new Response(
        JSON.stringify({
          ok: true,
          date: today,
          first,
          // 赢者抓到的只数——表头标签「腾讯 2」里的那个 2
          firstCount: first
            ? codes.filter((code) => funds[code].src === first).length
            : 0,
          count: codes.length,
          updatedAt: record?.updatedAt || null,
          funds,
        }),
        { headers: corsHeaders(env) },
      );
    }

    // 手动触发，用于部署后立刻验证而不必等下一个整分钟
    if (url.pathname === "/v1/collect") {
      if (!env.COLLECT_TOKEN || url.searchParams.get("token") !== env.COLLECT_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401,
          headers: corsHeaders(env),
        });
      }
      const result = await collect(env);
      return new Response(JSON.stringify({ ok: true, ...result }), {
        headers: corsHeaders(env),
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "not found" }), {
      status: 404,
      headers: corsHeaders(env),
    });
  },
};
