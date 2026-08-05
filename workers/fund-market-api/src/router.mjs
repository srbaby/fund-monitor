import { readLastKnownGood, saveLastKnownGood, stalePayload } from "./lkg.mjs";
import { latestQuoteAt } from "./parsers.mjs";
import {
  fetchBackupIndices,
  fetchBackupOfficial,
  fetchPrimaryIndices,
  fetchPrimaryOfficial,
} from "./upstreams.mjs";

// 看板每 10 秒取一次指数，故 8 秒的 TTL 对它每次都过期、拿到的照样是新数据；
// 但突发流量下把上游从最多 20 次/分钟压到 7 次/分钟。这三个 TTL 与其说是缓存，
// 不如说是上游的限流器——bailuzun.com 不在 CF zone 内，没有 WAF 可用。
const SUCCESS_TTL = { indices: 8_000, official: 60_000 };
const cache = new Map();
const inflight = new Map();

const SOURCE = {
  indices: {
    primary: ["tencent", "腾讯指数"],
    backup: ["eastmoney", "东方财富指数（缺PE与总市值）"],
    unavailable: [null, "不可用 · 顶部指数"],
  },
  official: {
    primary: ["eastmoney", "天天基金移动批量"],
    backup: ["eastmoney", "天天基金历史净值"],
    unavailable: [null, "不可用 · 官方净值"],
  },
};

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "https://fund.bailuzun.com",
      "access-control-allow-headers": "content-type, x-diagnostic-token",
      "cache-control": "no-store",
    },
  });
}

function parseCodes(value) {
  if (!value) return null;
  const codes = [...new Set(value.split(",").map((item) => item.trim().padStart(6, "0")))];
  return codes.length > 0 && codes.length <= 50 && codes.every((code) => /^\d{6}$/.test(code)) ? codes : null;
}

// bailuzun.com 的权威 DNS 在腾讯，不是 Cloudflare zone，因此拿不到任何 WAF/速率
// 限制规则——唯一能收口的地方就是这里。*.pages.dev 与预览部署地址同样能触发上游
// 请求，却连自定义域那点约束都没有，故对外只认自定义域；带诊断密钥时放行，
// 给证书或 DNS 出问题时留一条调试退路。
const ALLOWED_HOST = "fund-api.bailuzun.com";

function hostAllowed(url, request, env) {
  if (url.hostname === ALLOWED_HOST) return true;
  const token = request.headers.get("x-diagnostic-token");
  return !!(env?.DIAGNOSTIC_TOKEN && token === env.DIAGNOSTIC_TOKEN);
}

function getForce(url, request, env) {
  const force = url.searchParams.get("force");
  if (!force) return null;
  if (force !== "primary" && force !== "backup") return "invalid";
  const token = request.headers.get("x-diagnostic-token");
  return env?.DIAGNOSTIC_TOKEN && token === env.DIAGNOSTIC_TOKEN ? force : "forbidden";
}

function makePayload(kind, status, data, quoteAt) {
  const [source, sourceLabel] = SOURCE[kind][status];
  return { ok: status !== "unavailable", status, source, sourceLabel, quoteAt: quoteAt || null, data: data || [] };
}

// ── 官方净值读端点（2026-08-05 起以 nav:funds 为准）──
// 采集器现在按「每只基金两行、行的身份是净值日期（北京时间）」存放，
// 见 workers/fund-nav-collector/src/index.js 顶部的存储模型说明。
// 这里只负责把它照原样铺成看板要的形状：**响应字段一个都不许变**，前端不动。
//
// 下面 compactRecord / findNavBefore / readNavWindow 那一套是旧的按日期整份记录，
// 保留为过渡兜底：nav:funds 还没写出来时（首次部署、KV 未回填）仍能出数，
// 不让看板在切换那一刻空一次（红线 #3）。等 nav:funds 稳定跑满一轮后可以删。
const NAV_KEY = "nav:funds";
const LIVE_SOURCES = new Set(["eastmoney", "tencent"]);

function navRows(entry) {
  return (Array.isArray(entry?.rows) ? entry.rows : []).filter(
    (row) => /^\d{4}-\d{2}-\d{2}$/.test(row?.date || "") && row.nav > 0,
  );
}

async function readNavState(env) {
  const raw = await env.NAV.get(NAV_KEY, "json");
  const funds = {};
  for (const [code, entry] of Object.entries(raw?.funds || {})) {
    const rows = navRows(entry);
    if (rows.length) funds[code] = { name: entry?.name || null, rows };
  }
  return Object.keys(funds).length ? { updatedAt: raw?.updatedAt || null, funds } : null;
}

// 「谁先抢到」按 gotAt（真实抓取时刻）在实时源之间评选。补种行（src:"history"）的
// at 是净值日期 00:00:00，让它参选会永远"最早"，把标签变成谎话。
function electNavFirst(state, date) {
  let winner = null;
  for (const entry of Object.values(state.funds)) {
    const row = entry.rows[0];
    if (!row || row.date !== date || !LIVE_SOURCES.has(row.src)) continue;
    const key = row.gotAt || row.at;
    if (!winner || key < winner.key) winner = { key, src: row.src };
  }
  return winner?.src || null;
}

function buildNavPayload(state, today) {
  let date = null;
  let previousDate = null;
  for (const entry of Object.values(state.funds)) {
    const [row, previous] = entry.rows;
    if (row?.date && (!date || row.date > date)) date = row.date;
    if (previous?.date && (!previousDate || previous.date > previousDate)) previousDate = previous.date;
  }
  date = date || today;

  const first = electNavFirst(state, date);
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
      // 百分比优先由相邻两次官方净值派生；两行不全时退回上游自报的官方涨跌幅。
      // 无论哪种，收益金额都不读它（红线 #1）。
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

  return { ok: true, date, previousDate, first, firstCount, count, updatedAt: state.updatedAt || null, funds };
}

function compactRecord(record) {
  if (!record?.date || !record.funds) return null;
  return record;
}

async function findNavBefore(env, date) {
  const previous = compactRecord(await env.NAV.get("nav:previous", "json"));
  if (previous?.date && previous.date < date) return previous;

  const latest = compactRecord(await env.NAV.get("nav:latest", "json"));
  if (latest?.date && latest.date < date) return latest;

  for (let days = 1; days <= 10; days += 1) {
    const d = new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const record = compactRecord(await env.NAV.get(`nav:${d}`, "json"));
    if (record?.date && record.date < date) return record;
  }
  return null;
}

async function readNavWindow(env, today) {
  const dateRecord = compactRecord(await env.NAV.get(`nav:${today}`, "json"));
  const pointerToday = compactRecord(await env.NAV.get("nav:today", "json"));
  const latest = compactRecord(await env.NAV.get("nav:latest", "json"));
  const current = dateRecord || pointerToday || latest;
  const previous = current?.date ? await findNavBefore(env, current.date) : null;
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

async function selectGroup(kind, force, fetcher, codes) {
  const loaders = {
    indices: [() => fetchPrimaryIndices(fetcher), () => fetchBackupIndices(fetcher)],
    official: [() => fetchPrimaryOfficial(fetcher, codes), () => fetchBackupOfficial(fetcher, codes)],
  }[kind];
  const diagnostics = [];
  const attempt = async (index, route) => {
    try {
      const data = await loaders[index]();
      if (!data) diagnostics.push({ route, reason: "incomplete_payload" });
      return data;
    } catch (error) {
      diagnostics.push({ route, reason: error instanceof Error ? error.message : "upstream_error" });
      return null;
    }
  };
  if (force === "primary") return { status: "primary", data: await attempt(0, "primary"), diagnostics };
  if (force === "backup") return { status: "backup", data: await attempt(1, "backup"), diagnostics };
  const primary = await attempt(0, "primary");
  if (primary) return { status: "primary", data: primary, diagnostics };
  return { status: "backup", data: await attempt(1, "backup"), diagnostics };
}

function quoteAtFor(kind, data) {
  if (kind === "indices") return latestQuoteAt(data);
  return data.map((item) => item.officialAt).filter(Boolean).sort().at(-1) || null;
}

export function resetGatewayCache() {
  cache.clear();
  inflight.clear();
}

export async function handleRequest(request, env = {}, context, dependencies = {}) {
  if (request.method === "OPTIONS") return response({}, 204);
  if (request.method !== "GET") return response({ ok: false, error: "method_not_allowed" }, 405);

  const url = new URL(request.url);
  if (!hostAllowed(url, request, env)) {
    return response({ ok: false, error: "host_not_allowed" }, 403);
  }

  // 官方净值采集器的**读**端点。数据由 workers/fund-nav-collector 每分钟写入
  // 同一个 KV，这里只做读出，不打任何上游、不走主备那套。
  //
  // 为什么读写分在两个部署里：采集要 Cron，而本项目是 Pages Functions 没有 Cron；
  // 反过来采集 Worker 又拿不到可达域名——bailuzun.com 的权威 DNS 在腾讯不是 CF zone，
  // Worker 的 Custom Domain / Routes 都要求 zone 在 CF，只剩 *.workers.dev 而它在
  // 大陆常年不可达。于是 Worker 只写、网关只读，KV 是两者唯一的交接点。
  if (url.pathname === "/v1/nav/today") {
    if (!env?.NAV) return response({ ok: false, error: "nav_kv_unbound" }, 503);
    // 北京日期，与采集器同口径（后台不碰运行环境本机时区）
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

    // 主路径：每只基金两行，谁有数据谁就在，缺谁都不影响别人。
    const state = await readNavState(env);
    if (state) return response(buildNavPayload(state, today));

    // 过渡兜底：旧的按日期整份记录。nav:funds 写出来之后这段自然不再命中。
    const { current: record, previous: previousRecord } = await readNavWindow(env, today);
    if (!record) {
      return response({
        ok: true,
        date: today,
        previousDate: previousRecord?.date || null,
        first: null,
        firstCount: 0,
        count: 0,
        updatedAt: null,
        funds: {},
      });
    }
    const first = record.first || null;
    const firstCount = first
      ? Object.values(record.funds || {}).filter((item) => !item.backfilled && item.src === first).length
      : 0;
    const count = Object.keys(record.funds || {}).length;

    const funds = {};
    for (const [code, item] of Object.entries(record.funds || {})) {
      funds[code] = attachPreviousNav(code, item, previousRecord);
    }
    if (previousRecord?.funds) {
      for (const [code, item] of Object.entries(previousRecord.funds)) {
        if (funds[code]) continue;
        funds[code] = { ...item, previousNav: null, previousDate: null, previousPct: null };
      }
    }

    return response({
      ok: true,
      date: record.date,
      previousDate: previousRecord?.date || null,
      first,
      firstCount,
      count,
      updatedAt: record.updatedAt || null,
      funds,
    });
  }

  const endpoint = {
    "/v1/indices": "indices",
    "/v1/funds/official": "official",
  }[url.pathname];
  if (!endpoint) return response({ ok: false, error: "not_found" }, 404);

  const force = getForce(url, request, env);
  if (force === "invalid") return response({ ok: false, error: "invalid_force" }, 400);
  if (force === "forbidden") return response({ ok: false, error: "diagnostic_forbidden" }, 403);

  const codes = endpoint === "indices" ? null : parseCodes(url.searchParams.get("codes"));
  if (endpoint !== "indices" && !codes) return response({ ok: false, error: "valid_codes_required" }, 400);

  const cacheKey = `${endpoint}:${codes?.join(",") || "fixed"}`;

  // in-flight 去重：有正在跑的请求就搭车等结果，不重复打上游
  if (!force && inflight.has(cacheKey)) return inflight.get(cacheKey);

  const cached = !force && cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SUCCESS_TTL[endpoint]) return response(cached.payload);

  const upstream = (async () => {
    try {
      const selected = await selectGroup(endpoint, force, dependencies.fetch || fetch, codes);
      const status = selected.data ? selected.status : "unavailable";
      const payload = makePayload(endpoint, status, selected.data, selected.data ? quoteAtFor(endpoint, selected.data) : null);
      if (force) payload.diagnostic = selected.diagnostics;

      // 这一次取不到，不等于把用户已有的数据清空。退回上次好数据并标记陈旧，
      // 真的连 LKG 都没有（首次访问、换了基金列表、超出保质期）才如实返回不可用。
      if (status === "unavailable") {
        const record = await readLastKnownGood(env, cacheKey);
        if (!record) return response(payload);
        const stale = stalePayload(record);
        if (force) stale.diagnostic = selected.diagnostics;
        return response(stale);
      }

      if (!force) {
        cache.set(cacheKey, { createdAt: Date.now(), payload });
        saveLastKnownGood(env, context, cacheKey, payload);
      }
      return response(payload);
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  if (!force) inflight.set(cacheKey, upstream);
  return upstream;
}
