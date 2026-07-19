import { latestQuoteAt } from "./parsers.mjs";
import {
  fetchBackupEstimates,
  fetchBackupIndices,
  fetchBackupOfficial,
  fetchPrimaryEstimates,
  fetchPrimaryIndices,
  fetchPrimaryOfficial,
} from "./upstreams.mjs";

const SUCCESS_TTL = { indices: 3_000, estimate: 15_000, official: 60_000 };
const cache = new Map();

const SOURCE = {
  indices: {
    primary: ["tencent", "腾讯指数"],
    backup: ["eastmoney", "东方财富指数（缺PE与总市值）"],
    unavailable: [null, "不可用 · 顶部指数"],
  },
  estimate: {
    primary: ["eastmoney", "天天基金盘中估算"],
    backup: ["tencent", "腾讯基金估算"],
    unavailable: [null, "不可用 · 盘中估算"],
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

async function selectGroup(kind, force, fetcher, codes) {
  const loaders = {
    indices: [() => fetchPrimaryIndices(fetcher), () => fetchBackupIndices(fetcher)],
    estimate: [() => fetchPrimaryEstimates(fetcher, codes), () => fetchBackupEstimates(fetcher, codes)],
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
  return data.map((item) => item.estimateAt || item.officialAt).filter(Boolean).sort().at(-1) || null;
}

export function resetGatewayCache() {
  cache.clear();
}

export async function handleRequest(request, env = {}, context, dependencies = {}) {
  if (request.method === "OPTIONS") return response({}, 204);
  if (request.method !== "GET") return response({ ok: false, error: "method_not_allowed" }, 405);

  const url = new URL(request.url);
  const endpoint = {
    "/v1/indices": "indices",
    "/v1/funds/estimate": "estimate",
    "/v1/funds/official": "official",
  }[url.pathname];
  if (!endpoint) return response({ ok: false, error: "not_found" }, 404);

  const force = getForce(url, request, env);
  if (force === "invalid") return response({ ok: false, error: "invalid_force" }, 400);
  if (force === "forbidden") return response({ ok: false, error: "diagnostic_forbidden" }, 403);

  const codes = endpoint === "indices" ? null : parseCodes(url.searchParams.get("codes"));
  if (endpoint !== "indices" && !codes) return response({ ok: false, error: "valid_codes_required" }, 400);

  const cacheKey = `${endpoint}:${codes?.join(",") || "fixed"}`;
  const cached = !force && cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SUCCESS_TTL[endpoint]) return response(cached.payload);

  const selected = await selectGroup(endpoint, force, dependencies.fetch || fetch, codes);
  const status = selected.data ? selected.status : "unavailable";
  const payload = makePayload(endpoint, status, selected.data, selected.data ? quoteAtFor(endpoint, selected.data) : null);
  if (force) payload.diagnostic = selected.diagnostics;
  if (!force && status !== "unavailable") cache.set(cacheKey, { createdAt: Date.now(), payload });
  return response(payload);
}
