import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ console });
for (const file of ["js/config.js", "js/engine.js"]) {
  vm.runInContext(await readFile(resolve(ROOT, file), "utf8"), context, {
    filename: file,
  });
}

const { applyProxyEstimates, calcFundProfit, getBenchmarkProxyPct, BENCHMARK_PROXY } = vm.runInContext(
  "({ applyProxyEstimates, calcFundProfit, getBenchmarkProxyPct, BENCHMARK_PROXY })",
  context,
);

const MOVES = {
  "159352": 2.0,
  "000510": 1.1,
  "000013": 0.02,
  "000012": 0.05,
  "000832": 1.0,
  "000688": 3.0,
  "399006": 2.0,
  "000300": 1.0,
  "000905": 1.5,
  HSI: -0.5,
};

function indicesWithout(...codes) {
  const omitted = new Set(codes);
  return Object.fromEntries(
    Object.entries(MOVES)
      .filter(([code]) => !omitted.has(code))
      .map(([code, f3]) => [code, { f3 }]),
  );
}

const indices = indicesWithout();

test("all five main proxy models match the frozen sample", () => {
  const expected = {
    "022435": 1.9,
    "160622": 0.118,
    "110027": 0.712,
    "011554": 0.403,
    "003949": 0.02,
  };
  for (const [code, estPct] of Object.entries(expected)) {
    assert.ok(Math.abs(getBenchmarkProxyPct(code, 100, indices).estPct - estPct) < 1e-12, code);
  }
});

test("each missing main factor switches to its complete fallback model", () => {
  assert.ok(Math.abs(getBenchmarkProxyPct("022435", 100, indicesWithout("159352")).estPct - 1.045) < 1e-12);
  assert.ok(Math.abs(getBenchmarkProxyPct("160622", 100, indicesWithout("000013")).estPct - 0.145) < 1e-12);
  assert.ok(Math.abs(getBenchmarkProxyPct("110027", 100, indicesWithout("000013")).estPct - 0.48) < 1e-12);
  assert.ok(Math.abs(getBenchmarkProxyPct("011554", 100, indicesWithout("000013")).estPct - 0.415) < 1e-12);
  assert.equal(getBenchmarkProxyPct("003949", 100, indicesWithout("000013")), null);
});

test("a missing growth leg triggers the full 110027 fallback", () => {
  assert.equal(getBenchmarkProxyPct("110027", 100, indicesWithout("000688")).estPct, 0.48);
  assert.equal(getBenchmarkProxyPct("110027", 100, indicesWithout("399006")).estPct, 0.48);
});

test("unchanged funds retain their original proxy legs", () => {
  assert.deepEqual(BENCHMARK_PROXY["007044"], BENCHMARK_PROXY["007045"]);
  assert.equal(getBenchmarkProxyPct("007045", 100, indices).estPct, 1);
  assert.equal(getBenchmarkProxyPct("007044", 100, indices).estPct, 1);
  assert.equal(getBenchmarkProxyPct("007413", 100, indices).estPct, 1.5);
});

test("proxy value uses base NAV and the proxy percentage", () => {
  const result = getBenchmarkProxyPct("022435", 2.5, indices);
  assert.equal(result.estPct, 1.9);
  assert.equal(result.estVal, 2.5 * (1 + 1.9 / 100));
});

test("an official NAV arriving today remains the active profit value", () => {
  const results = applyProxyEstimates(
    [{
      code: "007045",
      error: false,
      offVal: "10.0000",
      offDate: "2026-07-31",
      previousNav: 9,
      previousDate: "2026-07-30",
      estVal: null,
      estPct: null,
      estTime: null,
      estSource: "unavailable",
    }],
    "2026-07-31",
    indices,
    "2026-07-31 10:00:00",
  );
  assert.equal(results[0].estSource, "proxy");
  assert.equal(results[0].estVal, "9.0900");
  const profit = calcFundProfit(results[0], 10, "TRADING", "2026-07-31");
  assert.equal(profit.isRealUpdate, true);
  assert.equal(profit.profit, 10);
});
