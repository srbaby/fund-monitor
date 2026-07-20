import assert from "node:assert/strict";
import test from "node:test";
import { parseEastmoneyIndices, parseFundGz, parseTencentEstimates } from "../src/parsers.mjs";
import { resetLkgThrottle } from "../src/lkg.mjs";
import { handleRequest, resetGatewayCache } from "../src/router.mjs";

const CODES = ["003949", "160622"];

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function textResponse(text) {
  return new Response(text, { status: 200 });
}

function eastmoneyIndices(omit = false) {
  const codes = ["000300", "000510", "000905", "000832", "000012", "HSI"];
  return { data: { diff: codes.filter((code) => !omit || code !== "000905").map((code, index) => ({ f12: code, f14: `指数${code}`, f2: 1000 + index, f3: 1.2, f124: "20260719103000", f115: 12.3, f116: 456 })) } };
}

// Real Tencent fund shape, captured live: ten fields where [2..4] carry the
// intraday estimate and [5..8] the official NAV block. Outside a trading
// session Tencent zeroes the estimate and leaves its timestamp empty.
function qqIndices({ anchorPe = "13.98", anchorMcap = "536149.80" } = {}) {
  return ["sh000300", "sh000510", "sh000905", "sh000832", "sh000012", "hkHSI"].map((code, index) => {
    const fields = Array(46).fill("");
    const isAnchor = code === "sh000300";
    fields[1] = `指数${code}`;
    fields[3] = String(1000 + index);
    fields[30] = "20260719103000";
    fields[32] = "0.5";
    fields[39] = isAnchor ? anchorPe : "10";
    fields[45] = isAnchor ? anchorMcap : "1000";
    return `v_${code}="${fields.join("~")}";`;
  }).join("\n");
}

function qqEstimates(codes, { session = "open" } = {}) {
  return codes.map((code, index) => {
    const fields = [code, `基金${code}`, "0.0000", "0.0000", "", "9.9999", "1.4152", "0.0081", "2026-07-17", ""];
    if (session === "open") {
      fields[2] = String(1.2 + index / 10);
      fields[3] = "0.88";
      fields[4] = "2026-07-20 10:30";
    }
    return `v_jj${code}="${fields.join("~")}";`;
  }).join("\n");
}

test("fundgz parser requires every intraday estimate field", () => {
  assert.equal(parseFundGz('jsonpgz({"fundcode":"003949","gsz":"1.2345","gszzl":"0.45","gztime":"2026-07-19 10:30:00"});', "003949").estimateNav, 1.2345);
  assert.equal(parseFundGz('jsonpgz({"fundcode":"003949","gsz":"1.2345","gszzl":"","gztime":"2026-07-19 10:30:00"});', "003949"), null);
});

test("Tencent estimate parser never uses field 5 official NAV", () => {
  const parsed = parseTencentEstimates(qqEstimates(["003949"]), ["003949"]);
  assert.equal(parsed[0].estimateNav, 1.2);
  assert.equal(parsed[0].estimateAt, "2026-07-20 10:30");
  assert.notEqual(parsed[0].estimateNav, 9.9999);
});

test("Tencent estimates are unavailable outside a trading session", () => {
  assert.equal(parseTencentEstimates(qqEstimates(["003949"], { session: "closed" }), ["003949"]), null);
});

test("Eastmoney HSI mirror responses collapse to one canonical HSI record", () => {
  const payload = eastmoneyIndices();
  payload.data.diff.push({
    f12: "HSI",
    f14: "恒生指数镜像",
    f2: 24563,
    f3: -1.7,
    f124: "20260719103000",
  });
  const parsed = parseEastmoneyIndices(payload);
  assert.equal(parsed.length, 6);
  assert.equal(parsed.filter((item) => item.code === "HSI").length, 1);
});

test("the Tencent primary group carries the HS300 PE anchor fields", async () => {
  resetGatewayCache();
  const fetcher = async (url) =>
    url.includes("qt.gtimg.cn") ? textResponse(qqIndices()) : Promise.reject(new Error("backup must not run"));
  const result = await handleRequest(new Request("https://fund-api.bailuzun.com/v1/indices"), {}, null, { fetch: fetcher });
  const body = await result.json();
  assert.equal(body.status, "primary");
  assert.equal(body.source, "tencent");
  const anchor = body.data.find((item) => item.code === "000300");
  assert.equal(anchor.pe, 13.98);
  assert.equal(anchor.marketCap, 536149.8);
});

// Without realtime market cap the 1.0 bypass path silently freezes the PE bar
// at yesterday's close, so a Tencent group missing it is not a usable primary.
test("indices fall back to Eastmoney when Tencent drops the HS300 market cap", async () => {
  resetGatewayCache();
  const fetcher = async (url) => {
    if (url.includes("qt.gtimg.cn")) return textResponse(qqIndices({ anchorMcap: "0" }));
    if (url.includes("eastmoney.com/api/qt/ulist")) return jsonResponse(eastmoneyIndices());
    throw new Error(`unexpected ${url}`);
  };
  const result = await handleRequest(new Request("https://fund-api.bailuzun.com/v1/indices"), {}, null, { fetch: fetcher });
  const body = await result.json();
  assert.equal(body.status, "backup");
  assert.equal(body.source, "eastmoney");
  assert.equal(body.data.length, 6);
});

test("official data never mixes an incomplete primary group with backup records", async () => {
  resetGatewayCache();
  const fetcher = async (url) => {
    if (url.includes("FundMNFInfo")) return jsonResponse({ Success: true, Datas: [{ FCODE: CODES[0], NAV: "1.1", NAVCHGRT: "0.1", PDATE: "2026-07-18" }] });
    if (url.includes("FundMNHisNetList")) {
      const code = new URL(url).searchParams.get("FCODE");
      return jsonResponse({ Datas: [{ DWJZ: code === CODES[0] ? "2.1" : "2.2", JZZZL: "0.2", FSRQ: "2026-07-18" }] });
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await handleRequest(new Request(`https://fund-api.bailuzun.com/v1/funds/official?codes=${CODES.join(",")}`), {}, null, { fetch: fetcher });
  const body = await result.json();
  assert.equal(body.status, "backup");
  assert.deepEqual(body.data.map((item) => item.officialNav), [2.1, 2.2]);
});

test("forced diagnostics require the configured token", async () => {
  resetGatewayCache();
  const denied = await handleRequest(new Request("https://fund-api.bailuzun.com/v1/indices?force=primary"), { DIAGNOSTIC_TOKEN: "secret" });
  assert.equal(denied.status, 403);
  const fetcher = async (url) => url.includes("qt.gtimg.cn") ? textResponse(qqIndices()) : Promise.reject(new Error("backup must not run"));
  const allowed = await handleRequest(new Request("https://fund-api.bailuzun.com/v1/indices?force=primary", { headers: { "x-diagnostic-token": "secret" } }), { DIAGNOSTIC_TOKEN: "secret" }, null, { fetch: fetcher });
  assert.equal((await allowed.json()).status, "primary");
});

// bailuzun.com 不在 Cloudflare zone 内（权威 DNS 在腾讯），拿不到 WAF 规则，
// 收口只能在代码里做：对外只认自定义域，pages.dev 与预览地址一律拒绝。
test("only the custom domain may reach the API anonymously", async () => {
  resetGatewayCache();
  const fetcher = async () => { throw new Error("upstream must not be reached"); };
  for (const host of [
    "https://fund-market-api.pages.dev/v1/indices",
    "https://7d5bd3a5.fund-market-api.pages.dev/v1/indices",
    "https://sqppb.fund-market-api.pages.dev/v1/indices",
  ]) {
    const res = await handleRequest(new Request(host), { DIAGNOSTIC_TOKEN: "secret" }, null, { fetch: fetcher });
    assert.equal(res.status, 403, host);
    assert.equal((await res.json()).error, "host_not_allowed");
  }
});

test("the diagnostic token keeps pages.dev usable as a debug escape hatch", async () => {
  resetGatewayCache();
  const fetcher = async (url) =>
    url.includes("qt.gtimg.cn") ? textResponse(qqIndices()) : Promise.reject(new Error("backup must not run"));
  const res = await handleRequest(
    new Request("https://fund-market-api.pages.dev/v1/indices", { headers: { "x-diagnostic-token": "secret" } }),
    { DIAGNOSTIC_TOKEN: "secret" }, null, { fetch: fetcher },
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "primary");
});

test("the custom domain still works with no token at all", async () => {
  resetGatewayCache();
  const fetcher = async (url) =>
    url.includes("qt.gtimg.cn") ? textResponse(qqIndices()) : Promise.reject(new Error("backup must not run"));
  const res = await handleRequest(new Request("https://fund-api.bailuzun.com/v1/indices"), {}, null, { fetch: fetcher });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "primary");
});

// ---- D-001 行情数据 last-known-good 保护 ----
// 这组测试守的是"收盘后一次刷新把全天数据冲成空白"那起事故。改动网关时不要绕过它们。

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    kv: {
      get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
      put: async (key, value) => void store.set(key, value),
    },
    store,
  };
}

const CLOSED_ESTIMATE_FETCHER = async (url) => {
  if (url.includes("fundgz")) return textResponse("");
  if (url.includes("qt.gtimg.cn")) return textResponse(qqEstimates(CODES, { session: "closed" }));
  throw new Error(`unexpected ${url}`);
};

const ESTIMATE_URL = `https://fund-api.bailuzun.com/v1/funds/estimate?codes=${CODES.join(",")}`;

test("a good estimate group is persisted, then served as stale once upstreams stop supplying it", async () => {
  resetGatewayCache();
  resetLkgThrottle();
  const { kv } = memoryKv();
  const env = { MARKET_LKG: kv };

  const openFetcher = async (url) =>
    url.includes("fundgz")
      ? textResponse(`jsonpgz({"fundcode":"${new URL(url).pathname.match(/(\d{6})/)[1]}","name":"基金","gsz":"1.2345","gszzl":"0.45","gztime":"2026-07-20 14:55:00"});`)
      : Promise.reject(new Error("backup must not run"));
  const live = await (await handleRequest(new Request(ESTIMATE_URL), env, null, { fetch: openFetcher })).json();
  assert.equal(live.status, "primary");

  // 收盘：天天基金停供、腾讯把估算字段清零，整组取不到
  resetGatewayCache();
  const afterClose = await (await handleRequest(new Request(ESTIMATE_URL), env, null, { fetch: CLOSED_ESTIMATE_FETCHER })).json();

  assert.equal(afterClose.status, "stale");
  assert.equal(afterClose.ok, true, "陈旧数据仍是完整一组，前端要照常渲染");
  assert.equal(afterClose.servedFrom, "primary");
  assert.deepEqual(afterClose.data.map((item) => item.estimateNav), [1.2345, 1.2345]);
  assert.equal(afterClose.data[0].estimateAt, "2026-07-20 14:55:00", "陈旧数据必须保留原始时间戳，供前端如实显示");
});

test("without a stored good group the gateway still reports unavailable rather than inventing data", async () => {
  resetGatewayCache();
  resetLkgThrottle();
  const { kv } = memoryKv();
  const body = await (await handleRequest(new Request(ESTIMATE_URL), { MARKET_LKG: kv }, null, { fetch: CLOSED_ESTIMATE_FETCHER })).json();
  assert.equal(body.status, "unavailable");
  assert.equal(body.ok, false);
  assert.deepEqual(body.data, []);
});

test("a stored group past its shelf life is not served", async () => {
  resetGatewayCache();
  resetLkgThrottle();
  const stale = {
    savedAt: Date.now() - 96 * 3_600_000,
    payload: { ok: true, status: "primary", sourceLabel: "天天基金盘中估算", data: [{ code: CODES[0] }] },
  };
  const { kv } = memoryKv({ [`lkg:estimate:${CODES.join(",")}`]: JSON.stringify(stale) });
  const body = await (await handleRequest(new Request(ESTIMATE_URL), { MARKET_LKG: kv }, null, { fetch: CLOSED_ESTIMATE_FETCHER })).json();
  assert.equal(body.status, "unavailable");
});

test("the gateway behaves exactly as before when no KV namespace is bound", async () => {
  resetGatewayCache();
  resetLkgThrottle();
  const body = await (await handleRequest(new Request(ESTIMATE_URL), {}, null, { fetch: CLOSED_ESTIMATE_FETCHER })).json();
  assert.equal(body.status, "unavailable");
});

test("repeated successful refreshes do not burn a KV write each time", async () => {
  resetGatewayCache();
  resetLkgThrottle();
  const { kv, store } = memoryKv();
  let writes = 0;
  const counting = { ...kv, put: async (key, value) => { writes += 1; return kv.put(key, value); } };
  const fetcher = async (url) =>
    url.includes("fundgz")
      ? textResponse(`jsonpgz({"fundcode":"${new URL(url).pathname.match(/(\d{6})/)[1]}","name":"基金","gsz":"1.2345","gszzl":"0.45","gztime":"2026-07-20 14:55:00"});`)
      : Promise.reject(new Error("backup must not run"));

  for (let i = 0; i < 5; i += 1) {
    resetGatewayCache();
    await handleRequest(new Request(ESTIMATE_URL), { MARKET_LKG: counting }, null, { fetch: fetcher });
  }
  assert.equal(writes, 1, "节流窗口内只该落盘一次");
  assert.equal(store.size, 1);
});
