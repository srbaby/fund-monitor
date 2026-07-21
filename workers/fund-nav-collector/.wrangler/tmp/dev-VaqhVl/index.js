var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var BJ_OFFSET_MS = 8 * 36e5;
var TIMEOUT_MS = 1e4;
var CODES_CACHE_MS = 5 * 6e4;
var IDLE_GIVE_UP = 30;
var RECORD_TTL_S = 7 * 24 * 3600;
function bjNow() {
  return new Date(Date.now() + BJ_OFFSET_MS);
}
__name(bjNow, "bjNow");
function bjDateStr() {
  return bjNow().toISOString().slice(0, 10);
}
__name(bjDateStr, "bjDateStr");
function bjStamp() {
  return bjNow().toISOString().replace("T", " ").slice(0, 19);
}
__name(bjStamp, "bjStamp");
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
        "Cache-Control": "no-cache"
      },
      cf: { cacheTtl: 0, cacheEverything: false },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchUpstream, "fetchUpstream");
async function fetchEastmoney(codes) {
  const params = new URLSearchParams({
    Fcodes: codes.join(","),
    pageIndex: "1",
    pageSize: "200",
    plat: "Android",
    appType: "ttjj",
    product: "EFund",
    Version: "1",
    deviceid: "fund-nav-collector"
  });
  const response = await fetchUpstream(
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?${params}`
  );
  const payload = await response.json();
  const out = /* @__PURE__ */ new Map();
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
      name: item.SHORTNAME || null
    });
  }
  return out;
}
__name(fetchEastmoney, "fetchEastmoney");
async function fetchTencent(codes) {
  const response = await fetchUpstream(
    `https://qt.gtimg.cn/q=${codes.map((code) => `jj${code}`).join(",")}`
  );
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const out = /* @__PURE__ */ new Map();
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
      name: fields[1] || null
    });
  }
  return out;
}
__name(fetchTencent, "fetchTencent");
async function fetchGistCodes(env) {
  if (!env.GIST_ID || !env.GIST_TOKEN) return null;
  try {
    const response = await fetch(`https://api.github.com/gists/${env.GIST_ID}`, {
      headers: {
        Authorization: `token ${env.GIST_TOKEN}`,
        "User-Agent": "fund-nav-collector",
        Accept: "application/vnd.github+json"
      }
    });
    if (!response.ok) return null;
    const gist = await response.json();
    const content = gist?.files?.["fm_config.json"]?.content;
    if (!content) return null;
    const config = JSON.parse(content);
    const codes = Array.isArray(config.f) ? config.f.filter((code) => /^\d{6}$/.test(code)) : null;
    return codes?.length ? codes : null;
  } catch {
    return null;
  }
}
__name(fetchGistCodes, "fetchGistCodes");
async function loadCodes(env) {
  const cached = await env.NAV.get("codes", "json");
  if (cached?.codes && Date.now() - cached.ts < CODES_CACHE_MS) return cached.codes;
  const fresh = await fetchGistCodes(env);
  if (fresh) {
    await env.NAV.put("codes", JSON.stringify({ ts: Date.now(), codes: fresh }));
    return fresh;
  }
  if (cached?.codes) return cached.codes;
  return String(env.FALLBACK_CODES || "").split(",").map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code));
}
__name(loadCodes, "loadCodes");
async function collect(env) {
  const today = bjDateStr();
  const key = `nav:${today}`;
  const record = await env.NAV.get(key, "json") || {
    date: today,
    funds: {},
    first: null,
    idle: 0
  };
  const codes = await loadCodes(env);
  if (!codes.length) return { status: "no-codes" };
  if (record.done) return { status: "done-earlier", have: Object.keys(record.funds).length };
  if (codes.every((code) => record.funds[code])) {
    return { status: "complete", have: codes.length };
  }
  const [em, tx] = await Promise.allSettled([fetchEastmoney(codes), fetchTencent(codes)]);
  const emMap = em.status === "fulfilled" ? em.value : /* @__PURE__ */ new Map();
  const txMap = tx.status === "fulfilled" ? tx.value : /* @__PURE__ */ new Map();
  const at = bjStamp();
  let added = 0;
  for (const code of codes) {
    if (record.funds[code]) continue;
    const fromEm = emMap.get(code);
    const fromTx = txMap.get(code);
    const emOk = fromEm?.date === today;
    const txOk = fromTx?.date === today;
    if (!emOk && !txOk) continue;
    const picked = emOk ? { ...fromEm, src: "eastmoney" } : { ...fromTx, src: "tencent" };
    record.funds[code] = {
      nav: picked.nav,
      pct: picked.pct,
      name: picked.name,
      src: picked.src,
      at
    };
    added += 1;
  }
  const entries = Object.values(record.funds);
  if (entries.length) {
    record.first = entries.reduce((a, b) => a.at <= b.at ? a : b).src;
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
    txError: tx.status === "rejected" ? String(tx.reason) : null
  };
}
__name(collect, "collect");
function corsHeaders(env) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "https://fund.bailuzun.com",
    "Cache-Control": "no-store"
  };
}
__name(corsHeaders, "corsHeaders");
var src_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      collect(env).then((result) => {
        console.log(JSON.stringify({ cron: event.cron, ...result }));
      })
    );
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...corsHeaders(env),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
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
          firstCount: first ? codes.filter((code) => funds[code].src === first).length : 0,
          count: codes.length,
          updatedAt: record?.updatedAt || null,
          funds
        }),
        { headers: corsHeaders(env) }
      );
    }
    if (url.pathname === "/v1/collect") {
      if (!env.COLLECT_TOKEN || url.searchParams.get("token") !== env.COLLECT_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
          status: 401,
          headers: corsHeaders(env)
        });
      }
      const result = await collect(env);
      return new Response(JSON.stringify({ ok: true, ...result }), {
        headers: corsHeaders(env)
      });
    }
    return new Response(JSON.stringify({ ok: false, error: "not found" }), {
      status: 404,
      headers: corsHeaders(env)
    });
  }
};

// C:/Users/yuanf/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/yuanf/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-K49HnK/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// C:/Users/yuanf/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-K49HnK/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
