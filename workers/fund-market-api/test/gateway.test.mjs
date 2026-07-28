import assert from "node:assert/strict";
import test from "node:test";
import { parseEastmoneyIndices } from "../src/parsers.mjs";
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

test("the removed estimate endpoint stays unavailable", async () => {
  const res = await handleRequest(
    new Request(`https://fund-api.bailuzun.com/v1/funds/estimate?codes=${CODES.join(",")}`),
    {},
    null,
    { fetch: async () => { throw new Error("upstream must not run"); } },
  );
  assert.equal(res.status, 404);
});

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

// ---- D-023 官方净值采集器的读端点 ----
// 数据由 workers/fund-nav-collector 写入 NAV，网关只读出。这里验三件事：
// 没绑 KV 要明说、赢者按 src 计数、以及**不许触发任何上游**（它读 KV，不是数据源）。

const NAV_URL = "https://fund-api.bailuzun.com/v1/nav/today";
const NAV_TODAY = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

function navKv(record) {
  const { kv } = memoryKv({ [`nav:${NAV_TODAY}`]: JSON.stringify(record) });
  return kv;
}

test("nav endpoint says so plainly when the KV namespace is not bound", async () => {
  const res = await handleRequest(new Request(NAV_URL), {}, null, {
    fetch: async () => { throw new Error("upstream must not run"); },
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "nav_kv_unbound");
});

test("nav endpoint counts only the winner's claims", async () => {
  const kv = navKv({
    date: NAV_TODAY,
    first: "tencent",
    updatedAt: `${NAV_TODAY} 20:05:03`,
    funds: {
      "003949": { nav: 1.2362, pct: 0.01, src: "tencent", at: `${NAV_TODAY} 19:41:12` },
      "160622": { nav: 1.1472, pct: 0.12, src: "tencent", at: `${NAV_TODAY} 19:52:30` },
      "110027": { nav: 2.3278, pct: 1.7, src: "eastmoney", at: `${NAV_TODAY} 20:03:55` },
    },
  });
  const body = await (await handleRequest(new Request(NAV_URL), { NAV: kv }, null, {
    fetch: async () => { throw new Error("upstream must not run"); },
  })).json();
  assert.equal(body.ok, true);
  assert.equal(body.first, "tencent");
  assert.equal(body.firstCount, 2, "腾讯抢到 2 只，标签应显示「腾讯 2」");
  assert.equal(body.count, 3);
});

test("nav endpoint returns an empty day rather than inventing a winner", async () => {
  const { kv } = memoryKv();
  const body = await (await handleRequest(new Request(NAV_URL), { NAV: kv }, null, {
    fetch: async () => { throw new Error("upstream must not run"); },
  })).json();
  assert.equal(body.ok, true);
  assert.equal(body.first, null);
  assert.equal(body.firstCount, 0);
  assert.deepEqual(body.funds, {});
});

test("nav endpoint stays behind the custom-domain guard like every other route", async () => {
  const res = await handleRequest(
    new Request("https://fund-market-api.pages.dev/v1/nav/today"),
    { NAV: navKv({ date: NAV_TODAY, first: "tencent", funds: {} }) },
    null,
    { fetch: async () => { throw new Error("upstream must not run"); } },
  );
  assert.equal(res.status, 403);
});

test("nav endpoint falls back to the latest record when today has none", async () => {
  // 盘中 / 周末 / 节假日没有「今日记录」。官方净值是全站唯一来源，
  // 若这里不回退，那些时段官方净值整列变空、持仓市值直接算不出（红线 #2）。
  const { kv } = memoryKv({
    "nav:latest": JSON.stringify({
      date: "2026-07-20",
      first: "tencent",
      funds: { "003949": { nav: 1.2362, pct: 0.01, src: "tencent", at: "2026-07-20 19:41:12" } },
    }),
  });
  const body = await (await handleRequest(new Request(NAV_URL), { NAV: kv }, null, {
    fetch: async () => { throw new Error("upstream must not run"); },
  })).json();
  assert.equal(body.count, 1, "应回退到 nav:latest");
  assert.equal(body.date, "2026-07-20", "date 必须是记录自带日期，不是请求当天——前端据它判新旧");
  assert.equal(body.first, "tencent");
});

test("today's record wins for funds it actually has, latest only fills the gaps", async () => {
  // 110027 今天真采到了；003949 今天没披露（两源都没给当日值），但 latest 里有它上次的好值。
  // 红线 #2：单只当天没数据不该整只消失，应该用 latest 兜底补上、标为旧数据由前端按 at 判断。
  // first/firstCount 只认今天真采到的，不能被兜底的旧值稀释——003949 不该算进「谁抢到」。
  const { kv } = memoryKv({
    [`nav:${NAV_TODAY}`]: JSON.stringify({
      date: NAV_TODAY,
      first: "eastmoney",
      funds: { "110027": { nav: 2.3278, pct: 1.7, src: "eastmoney", at: `${NAV_TODAY} 20:03:55` } },
    }),
    "nav:latest": JSON.stringify({
      date: "2026-07-20",
      first: "tencent",
      funds: { "003949": { nav: 1.2362, pct: 0.01, src: "tencent", at: "2026-07-20 19:41:12" } },
    }),
  });
  const body = await (await handleRequest(new Request(NAV_URL), { NAV: kv }, null, {
    fetch: async () => { throw new Error("upstream must not run"); },
  })).json();
  assert.equal(body.date, NAV_TODAY);
  assert.equal(body.first, "eastmoney");
  assert.equal(body.firstCount, 1, "补的旧值不算今晚抢到的");
  assert.deepEqual(new Set(Object.keys(body.funds)), new Set(["110027", "003949"]));
  assert.deepEqual(body.funds["110027"], {
    nav: 2.3278,
    pct: null,
    src: "eastmoney",
    at: `${NAV_TODAY} 20:03:55`,
    previousNav: null,
    previousDate: null,
    previousPct: null,
  });
  assert.deepEqual(body.funds["003949"], {
    nav: 1.2362,
    pct: 0.01,
    src: "tencent",
    at: "2026-07-20 19:41:12",
    previousNav: null,
    previousDate: null,
    previousPct: null,
  });
});

test("latest never overwrites a fund today's record already booked", async () => {
  // 补洞逻辑必须严格只填「今天完全没有」的代码，不能因为 latest 里也有同一只就覆盖今天的新值。
  const { kv } = memoryKv({
    [`nav:${NAV_TODAY}`]: JSON.stringify({
      date: NAV_TODAY,
      first: "eastmoney",
      funds: { "003949": { nav: 1.2369, pct: 0.01, src: "eastmoney", at: `${NAV_TODAY} 20:13:32` } },
    }),
    "nav:latest": JSON.stringify({
      date: "2026-07-20",
      first: "tencent",
      funds: { "003949": { nav: 1.2362, pct: 0.01, src: "tencent", at: "2026-07-20 19:41:12" } },
    }),
  });
  const body = await (await handleRequest(new Request(NAV_URL), { NAV: kv }, null, {
    fetch: async () => { throw new Error("upstream must not run"); },
  })).json();
  assert.deepEqual(Object.keys(body.funds), ["003949"]);
  assert.equal(body.funds["003949"].nav, 1.2369, "今天真采到的值不能被 latest 覆盖");
});

test("nav endpoint derives each fund percentage from its own previous NAV", async () => {
  const { kv } = memoryKv({
    [`nav:${NAV_TODAY}`]: JSON.stringify({
      date: NAV_TODAY,
      first: "eastmoney",
      funds: {
        "003949": { nav: 1.0123, pct: 99, src: "eastmoney", at: `${NAV_TODAY} 20:00:00` },
        "110027": { nav: 2.2, pct: 99, src: "eastmoney", at: `${NAV_TODAY} 20:01:00` },
      },
    }),
    "nav:previous": JSON.stringify({
      date: "2026-07-20",
      first: "tencent",
      funds: {
        "003949": { nav: 1.0, pct: null, src: "tencent", at: "2026-07-20 20:00:00" },
        "110027": { nav: 2.0, pct: null, src: "tencent", at: "2026-07-20 20:00:00" },
      },
    }),
  });
  const body = await (await handleRequest(new Request(NAV_URL), { NAV: kv }, null, {
    fetch: async () => { throw new Error("upstream must not run"); },
  })).json();
  assert.equal(body.funds["003949"].previousNav, 1.0);
  assert.equal(Number(body.funds["003949"].pct.toFixed(4)), 1.23);
  assert.equal(body.funds["110027"].previousNav, 2.0);
  assert.equal(Number(body.funds["110027"].pct.toFixed(4)), 10);
});
