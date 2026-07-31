// ============================================================
// fund-nav-collector — 官方净值夜间采集器（详见本目录 README 与 docs/02-系统架构.md）
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
const RECORD_TTL_S = 7 * 24 * 3600;

// 北京时间：把 UTC 毫秒加 8 小时后按 UTC 读，等价于北京墙上时间
function bjNow() {
  return new Date(Date.now() + BJ_OFFSET_MS);
}
function bjDateStr() {
  return bjNow().toISOString().slice(0, 10);
}
function bjStamp(ms = Date.now()) {
  return new Date(ms + BJ_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19);
}

function compactRecord(record) {
  if (!record?.date || !record.funds) return null;
  const funds = {};
  for (const [code, item] of Object.entries(record.funds)) {
    if (!(item?.nav > 0)) continue;
    funds[code] = { ...item };
  }
  return Object.keys(funds).length
    ? {
        date: record.date,
        funds,
        first: record.first || null,
        updatedAt: record.updatedAt || null,
      }
    : null;
}

async function findRecordBefore(env, date) {
  const direct = await env.NAV.get("nav:previous", "json");
  if (direct?.date && direct.date < date) return compactRecord(direct);

  const latest = await env.NAV.get("nav:latest", "json");
  if (latest?.date && latest.date < date) return compactRecord(latest);

  for (let days = 1; days <= 10; days += 1) {
    const d = new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const record = await env.NAV.get(`nav:${d}`, "json");
    if (record?.date && record.date < date) return compactRecord(record);
  }
  return null;
}

async function loadNavWindow(env, today) {
  const pointerToday = await env.NAV.get("nav:today", "json");
  const todayRecord = await env.NAV.get(`nav:${today}`, "json");
  const latest = await env.NAV.get("nav:latest", "json");

  const current =
    (todayRecord?.date === today && compactRecord(todayRecord)) ||
    compactRecord(pointerToday) ||
    compactRecord(latest);

  const previous =
    current?.date === today
      ? await findRecordBefore(env, today)
      : current || (await findRecordBefore(env, today));

  return { current, previous };
}

function attachPreviousNav(code, item, previousRecord) {
  const previous = previousRecord?.funds?.[code];
  const previousNav = previous?.nav > 0 ? previous.nav : null;
  return {
    ...item,
    pct:
      previousNav == null
        ? null
        : ((item.nav - previousNav) / previousNav) * 100,
    previousNav,
    previousDate: previousNav == null ? null : previous.at?.slice(0, 10) || previousRecord.date,
    previousPct:
      previousNav == null || !Number.isFinite(previous.pct)
        ? null
        : previous.pct,
  };
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

// 东财 FundMNFInfo：一次批量。字段 NAV / NAVCHGRT / PDATE，旧版镜像用 DWJZ / JZZZL / FSRQ。
// 注意 NAVCHGRT 只有 2 位小数（"1.98"），腾讯给的是 4 位（"1.9821"）——同一只基金
// 两源精度不同，切源时涨跌幅会有末位跳变，这是上游差异，不是 bug。
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

async function collect(env) {
  const today = bjDateStr();
  const key = `nav:${today}`;
  const { current, previous } = await loadNavWindow(env, today);
  const storedToday = await env.NAV.get(key, "json");
  const record = storedToday || (current?.date === today ? current : null) || {
    date: today,
    funds: {},
    first: null,
  };

  const { codes, source: codesSource, error: codesError } = await loadCodes(env);
  if (!codes.length) return { status: "no-codes", codesSource, codesError };

  // 僵尸清理：基金已从看板删除，KV 里那条就该走。**必须在早退判断之前**——
  // 放后面的话，当日一旦 complete 就再没有跳会走到清理，僵尸能赖到记录过期。
  // 不清的代价不只是数据脏：端点的 count / firstCount 数的是 record.funds，
  // 僵尸会让这两个数一直偏大，而 first 还可能锚在一只已经删掉的基金上。
  const wanted = new Set(codes);
  let pruned = 0;
  for (const code of Object.keys(record.funds)) {
    if (!wanted.has(code)) {
      delete record.funds[code];
      pruned += 1;
    }
  }

  // **节假日不早退，就是空跑一整天**。这里曾有一套「连续 30 跳没抓到就判非交易日收工」，
  // 实测永远跑不到：计数器只在 dirty 时落盘，而空跑跳恒不 dirty，于是每跳都从 KV 重建、恒在 1~2
  // 摆动。**别照着注释以为它在保护什么，也别再把它加回来**——真加回来反而有害：某跳同时赶上
  // pruned>0（用户删基金）且 funds 为空时，收工标记会真落盘，把当晚正常的采集整个废掉。
  // 空跑的代价只是无效请求，可预测；误收工的代价是丢一整天净值，正是 2026-07-24 那种后果。

  // 早退：全部到齐。complete **不落盘**，每跳按当前列表现算——
  // 否则用户 21:00 加一只基金时当晚已 complete，会一直早退，新基金永远抓不到。
  const complete = codes.every((code) => record.funds[code]);

  let added = 0;
  // 上游诊断，只在真正打了上游的那些跳里有意义；早退跳保持零值
  let diag = { emSize: 0, txSize: 0, emError: null, txError: null };
  if (!complete) {
    // 真竞争：两源谁先返回当日数据就用谁。
    // per-fund at 反映实际抢到时刻（毫秒级），跨跳仍先到先得、写入不可变。
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
      if (record.funds[code]) continue; // 先到先得：已记账的绝不覆盖，保证 at/src 不可变
      const fromEm = emRes?.map.get(code);
      const fromTx = txRes?.map.get(code);
      const emOk = fromEm?.date === today;
      const txOk = fromTx?.date === today;
      // 只接受**当日**净值。原前端 bug 的根因正是没判这一条：东财在净值未披露时
      // 返回昨日数据且 size>0，于是整组被采纳，腾讯备源一次都轮不到。
      if (!emOk && !txOk) continue;
      // 两源都有当日数据时按完成时间选先到的；只有一方有时用那一方。
      // 平局（doneAt 相等，毫秒级极少见）归东财，保留主源 tiebreaker。
      const useEm = emOk && (!txOk || emRes.doneAt <= txRes.doneAt);
      const picked = useEm
        ? { ...fromEm, src: "eastmoney", at: bjStamp(emRes.doneAt) }
        : { ...fromTx, src: "tencent", at: bjStamp(txRes.doneAt) };
      const previousNav = previous?.funds?.[code]?.nav;
      record.funds[code] = {
        nav: picked.nav,
        // 百分比是两次官方净值的派生结果，只作快照展示；收益金额从不读它。
        pct:
          previousNav > 0
            ? ((picked.nav - previousNav) / previousNav) * 100
            : null,
        name: picked.name,
        src: picked.src,
        at: picked.at,
      };
      added += 1;
    }
  }

  // first = 今晚最早抓到的那条的源。由**时间戳**决定而非写入顺序，
  // 所以任何设备任何时候读，算出来都一样。
  // 放在清理之后统一重算：删掉的可能正是最早那只，那时 first 必须换人。
  const entries = Object.values(record.funds);
  record.first = entries.length
    ? entries.reduce((a, b) => (a.at <= b.at ? a : b)).src
    : null;

  // 落盘条件：有新增或有清理。纯早退跳（两者皆无）不写，免得晚间 241 跳
  // 把 KV 免费写配额（1000/天）烧掉四分之一。
  const dirty = added > 0 || pruned > 0;
  if (dirty) {
    // **必须现算，不许引用循环里的变量**：per-fund 的 at 是各自的抢到时刻，
    // 而这里要的是“本条记录最后一次写盘的时刻”，两者语义不同。曾因误用已删除变量，
    // 导致每次真抓到数据都在写盘前抛错，连 nav:latest 一起停写。
    record.updatedAt = bjStamp();
    await env.NAV.put(key, JSON.stringify(record), { expirationTtl: RECORD_TTL_S });
  }

  // 官方净值窗口：KV 对外始终是 nav:previous + nav:today 两组事实。
  // nav:today 是“最新已公布净值日”，不是北京日历当天；新净值真正采到后才滚动。
  //
  // nav:latest 保留为旧读端兼容指针；新逻辑不把它当收益基准。
  if (entries.length) {
    const latest = await env.NAV.get("nav:latest", "json");
    if (previous?.date && previous.date < record.date) {
      const prevPointer = await env.NAV.get("nav:previous", "json");
      if (dirty || prevPointer?.date !== previous.date) {
        await env.NAV.put("nav:previous", JSON.stringify(previous));
      }
    }
    if (dirty || latest?.date !== record.date) {
      await env.NAV.put("nav:today", JSON.stringify(record));
    }
    if (dirty || latest?.date !== record.date) {
      await env.NAV.put("nav:latest", JSON.stringify(record));
    }
  }

  if (complete) {
    return { status: "complete", have: codes.length, pruned, codesSource, codesError };
  }

  return {
    status: "collected",
    added,
    pruned,
    have: entries.length,
    want: codes.length,
    first: record.first,
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

// collect 单独导出供测试用（test/collector.test.mjs）。Worker 运行时只认 default 导出，
// 多这一行不影响 Dashboard 粘贴部署。
export { collect };

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
      const today = bjDateStr();
      // 与网关 router.mjs 的同名端点同口径：KV 窗口是 nav:today + nav:previous。
      // 前端实际读网关；这里是调试用，行为不一致会让排查跑偏。
      const { current: record, previous } = await loadNavWindow(env, today);
      if (!record) {
        return new Response(
          JSON.stringify({
            ok: true,
            date: today,
            previousDate: previous?.date || null,
            first: null,
            firstCount: 0,
            count: 0,
            updatedAt: null,
            funds: {},
          }),
          { headers: corsHeaders(env) },
        );
      }
      const first = record.first || null;
      const firstCount = first
        ? Object.values(record.funds || {}).filter((item) => item.src === first).length
        : 0;
      const count = Object.keys(record.funds || {}).length;

      const funds = {};
      for (const [code, item] of Object.entries(record.funds || {})) {
        funds[code] = attachPreviousNav(code, item, previous);
      }
      if (previous?.funds) {
        for (const [code, item] of Object.entries(previous.funds)) {
          if (funds[code]) continue;
          funds[code] = { ...item, previousNav: null, previousDate: null, previousPct: null };
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          date: record.date,
          previousDate: previous?.date || null,
          first,
          firstCount,
          count,
          updatedAt: record.updatedAt || null,
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
