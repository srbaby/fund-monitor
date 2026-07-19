import assert from "node:assert/strict";
import test from "node:test";
import { parseEastmoneyIndices, parseFundGz, parseTencentEstimates } from "../src/parsers.mjs";
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
  const result = await handleRequest(new Request("https://api.example/v1/indices"), {}, null, { fetch: fetcher });
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
  const result = await handleRequest(new Request("https://api.example/v1/indices"), {}, null, { fetch: fetcher });
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
  const result = await handleRequest(new Request(`https://api.example/v1/funds/official?codes=${CODES.join(",")}`), {}, null, { fetch: fetcher });
  const body = await result.json();
  assert.equal(body.status, "backup");
  assert.deepEqual(body.data.map((item) => item.officialNav), [2.1, 2.2]);
});

test("forced diagnostics require the configured token", async () => {
  resetGatewayCache();
  const denied = await handleRequest(new Request("https://api.example/v1/indices?force=primary"), { DIAGNOSTIC_TOKEN: "secret" });
  assert.equal(denied.status, 403);
  const fetcher = async (url) => url.includes("qt.gtimg.cn") ? textResponse(qqIndices()) : Promise.reject(new Error("backup must not run"));
  const allowed = await handleRequest(new Request("https://api.example/v1/indices?force=primary", { headers: { "x-diagnostic-token": "secret" } }), { DIAGNOSTIC_TOKEN: "secret" }, null, { fetch: fetcher });
  assert.equal((await allowed.json()).status, "primary");
});
