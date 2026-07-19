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

test("indices discard an incomplete primary group and use the complete Tencent group", async () => {
  resetGatewayCache();
  const fetcher = async (url) => {
    if (url.includes("eastmoney.com/api/qt/ulist")) return jsonResponse(eastmoneyIndices(true));
    if (url.includes("qt.gtimg.cn")) {
      const text = ["sh000300", "sh000510", "sh000905", "sh000832", "sh000012", "hkHSI"].map((code, index) => {
        const fields = Array(46).fill(""); fields[1] = `指数${code}`; fields[3] = String(1000 + index); fields[30] = "20260719103000"; fields[32] = "0.5"; return `v_${code}="${fields.join("~")}";`;
      }).join("\n");
      return textResponse(text);
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await handleRequest(new Request("https://api.example/v1/indices"), {}, null, { fetch: fetcher });
  const body = await result.json();
  assert.equal(body.status, "backup");
  assert.equal(body.source, "tencent");
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
  const fetcher = async (url) => url.includes("eastmoney.com/api/qt/ulist") ? jsonResponse(eastmoneyIndices()) : Promise.reject(new Error("backup must not run"));
  const allowed = await handleRequest(new Request("https://api.example/v1/indices?force=primary", { headers: { "x-diagnostic-token": "secret" } }), { DIAGNOSTIC_TOKEN: "secret" }, null, { fetch: fetcher });
  assert.equal((await allowed.json()).status, "primary");
});
