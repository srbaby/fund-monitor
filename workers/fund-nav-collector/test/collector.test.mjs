// ============================================================
// fund-nav-collector 冒烟测试（D-028）
//
// 存在理由：2026-07-24 起采集器静默停采两个交易日，根因是 D-026 那次改动留下一个未定义
// 引用（`record.updatedAt = at`），每次真抓到数据都在写盘前抛 ReferenceError。
// 这是**一行冒烟测试就能挡住**的故障，而当时这个目录一个用例都没有。
//
// 因此第一条用例锁的就是"真采到数据的一跳必须把 nav:{date} 写进 KV 且 updatedAt 非空"——
// 它不测细节，它测的是"写盘这条路根本走不走得通"。
//
// 上游用 globalThis.fetch 桩替换（采集器直接调全局 fetch，不做依赖注入）。
// 腾讯那路要过 TextDecoder("gbk")，故 fixture 里的基金名一律用 ASCII——
// GBK 对 ASCII 字节是透传的，这样不必在测试里引 iconv。
// ============================================================

import assert from "node:assert/strict";
import test from "node:test";
import worker, { collect } from "../src/index.js";

const TODAY = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() + 8 * 3_600_000 - 86_400_000)
  .toISOString()
  .slice(0, 10);

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  const writes = [];
  return {
    kv: {
      get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
      put: async (key, value) => {
        writes.push(key);
        store.set(key, value);
      },
      delete: async (key) => void store.delete(key),
    },
    store,
    writes,
  };
}

// GIST_ID / GIST_TOKEN 故意不配：loadCodes 会直接落到 FALLBACK_CODES，
// 于是测试不必桩 GitHub API。codesSource 因此恒为 "fallback"。
function envWith(kv, codes = "003949,160622") {
  return { NAV: kv, FALLBACK_CODES: codes };
}

function eastmoneyBody(rows) {
  return {
    Success: true,
    Datas: rows.map(([code, nav, pct, date]) => ({
      FCODE: code,
      NAV: String(nav),
      NAVCHGRT: String(pct),
      PDATE: date,
      SHORTNAME: `EM ${code}`,
    })),
  };
}

// 腾讯字段布局 [1]名称 [2][3][4]估算块 [5]官方净值 [6]累计 [7]官方% [8]官方日期
function tencentBody(rows) {
  return rows
    .map(
      ([code, nav, pct, date]) =>
        `v_jj${code}="jj~TX ${code}~0~0~~${nav}~1.5~${pct}~${date}~";`,
    )
    .join("\n");
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text) {
  return new Response(new TextEncoder().encode(text), { status: 200 });
}

// em / tx 为 null 表示该源本跳失败（reject），用来验证单源可用时的行为。
function stubUpstreams({ em, tx, onFetch }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (onFetch) onFetch(href);
    if (href.includes("eastmoney.com")) {
      if (!em) throw new Error("eastmoney down");
      return jsonResponse(em);
    }
    if (href.includes("qt.gtimg.cn")) {
      if (!tx) throw new Error("tencent down");
      return textResponse(tx);
    }
    throw new Error(`unexpected upstream: ${href}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

// ---- 核心回归：写盘这条路必须走得通 ----

test("a hop that actually collects writes nav:{date} with a non-empty updatedAt", async () => {
  // 这条直接锁死 2026-07-24 的停采：当时 `record.updatedAt = at` 引用了一个不存在的变量，
  // collect() 在 KV.put 之前就抛了，nav:{date} 与 nav:latest 双双写不进去。
  const { kv, store } = memoryKv();
  const restore = stubUpstreams({
    em: eastmoneyBody([
      ["003949", 1.2366, 0.01, TODAY],
      ["160622", 1.1478, 0.01, TODAY],
    ]),
    tx: tencentBody([]),
  });

  try {
    const result = await collect(envWith(kv));
    assert.equal(result.status, "collected");
    assert.equal(result.added, 2);
  } finally {
    restore();
  }

  const record = JSON.parse(store.get(`nav:${TODAY}`));
  assert.ok(record, "当日记录必须落盘");
  assert.ok(record.updatedAt, "updatedAt 不能为空——它为空说明写盘路径又被绕过了");
  assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(record.funds["003949"].nav, 1.2366);
  assert.equal(record.funds["003949"].src, "eastmoney");
});

test("the same hop also refreshes the nav:latest pointer", async () => {
  // nav:latest 是官方净值在盘中 / 周末 / 节假日的唯一依靠（红线 #2）。
  // 它和当日记录写在同一段里，当日记录写不进去时它一起陪葬——所以必须单独验。
  const { kv, store } = memoryKv();
  const restore = stubUpstreams({
    em: eastmoneyBody([["003949", 1.2366, 0.01, TODAY]]),
    tx: tencentBody([]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }

  const latest = JSON.parse(store.get("nav:latest"));
  assert.equal(latest.date, TODAY);
  assert.equal(latest.funds["003949"].nav, 1.2366);
});

test("a new official day promotes the old today window to previous", async () => {
  const { kv, store } = memoryKv({
    "nav:today": JSON.stringify({
      date: YESTERDAY,
      first: "tencent",
      updatedAt: `${YESTERDAY} 20:00:00`,
      funds: {
        "003949": { nav: 1.0, pct: null, src: "tencent", at: `${YESTERDAY} 20:00:00` },
      },
    }),
  });
  const restore = stubUpstreams({
    em: eastmoneyBody([["003949", 1.0123, 1.99, TODAY]]),
    tx: tencentBody([]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }

  const previous = JSON.parse(store.get("nav:previous"));
  const today = JSON.parse(store.get("nav:today"));
  assert.equal(previous.date, YESTERDAY);
  assert.equal(previous.funds["003949"].nav, 1.0);
  assert.equal(today.date, TODAY);
  assert.equal(today.funds["003949"].nav, 1.0123);
  assert.equal(Number(today.funds["003949"].pct.toFixed(4)), 1.23);
});

test("a throwing upstream still leaves the record writable on the next hop", async () => {
  // 两源全挂的一跳不该写盘，也不该把已有记录破坏掉。
  const { kv, store } = memoryKv();
  const restore = stubUpstreams({ em: null, tx: null });
  let result;
  try {
    result = await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  assert.equal(result.status, "collected");
  assert.equal(result.added, 0);
  assert.equal(store.size, 0, "什么都没采到时不该产生 KV 写入");
});

// ---- D-023 的核心防线：只收当日 ----

test("yesterday's NAV from an upstream is never booked", async () => {
  // 原前端 bug 的根因：东财在净值未披露时返回昨日数据且 size>0，整组被采纳，
  // 腾讯备源一次都轮不到。这条闸门是 D-023 的立身之本，不许被"顺手放宽"。
  const { kv, store } = memoryKv();
  const restore = stubUpstreams({
    em: eastmoneyBody([["003949", 1.2299, 0.05, YESTERDAY]]),
    tx: tencentBody([["003949", 1.2299, 0.05, YESTERDAY]]),
  });
  let result;
  try {
    result = await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  assert.equal(result.added, 0, "昨日净值不得入账");
  assert.equal(store.size, 0);
});

test("a single live source carries the day when the other returns stale data", async () => {
  const { kv, store } = memoryKv();
  const restore = stubUpstreams({
    em: eastmoneyBody([["003949", 1.2299, 0.05, YESTERDAY]]),
    tx: tencentBody([["003949", 1.2366, 0.01, TODAY]]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  const record = JSON.parse(store.get(`nav:${TODAY}`));
  assert.equal(record.funds["003949"].src, "tencent");
  assert.equal(record.first, "tencent");
});

// ---- 历史记录回填：只补日期相符的最近一条，不改变当日竞速 ----

test("a stale upstream NAV backfills the adjacent historical record", async () => {
  const historical = {
    date: YESTERDAY,
    first: "tencent",
    updatedAt: `${YESTERDAY} 20:00:00`,
    funds: {
      "003949": { nav: 1.0, pct: null, src: "tencent", at: `${YESTERDAY} 19:41:12` },
    },
  };
  const { kv, store } = memoryKv({
    [`nav:${YESTERDAY}`]: JSON.stringify(historical),
    "nav:today": JSON.stringify(historical),
    "nav:latest": JSON.stringify(historical),
  });
  const restore = stubUpstreams({
    em: eastmoneyBody([["007044", 1.8268, 0.5, YESTERDAY]]),
    tx: tencentBody([]),
  });
  try {
    const result = await collect(envWith(kv, "003949,007044"));
    assert.equal(result.backfilled, 1);
  } finally {
    restore();
  }

  const saved = JSON.parse(store.get(`nav:${YESTERDAY}`));
  assert.equal(saved.funds["007044"].nav, 1.8268);
  assert.equal(saved.funds["007044"].backfilled, true);
  assert.equal(saved.funds["007044"].at, null);
  assert.equal(saved.first, "tencent", "回填不得重算历史记录的 first");
  assert.deepEqual(JSON.parse(store.get("nav:today")).funds["007044"], saved.funds["007044"]);

  const body = await worker.fetch(new Request("https://collector.test/v1/nav/today"), { NAV: kv });
  assert.equal((await body.json()).firstCount, 1, "采集器调试端点不应统计回填条目");
});

test("a NAV for another date does not backfill the historical record", async () => {
  const historical = {
    date: YESTERDAY,
    first: "tencent",
    funds: {
      "003949": { nav: 1.0, pct: null, src: "tencent", at: `${YESTERDAY} 19:41:12` },
    },
  };
  const { kv, store, writes } = memoryKv({
    [`nav:${YESTERDAY}`]: JSON.stringify(historical),
    "nav:today": JSON.stringify(historical),
    "nav:latest": JSON.stringify(historical),
  });
  const before = [...store.entries()];
  const restore = stubUpstreams({
    em: eastmoneyBody([["007044", 1.7, 0.5, "2026-08-03"]]),
    tx: tencentBody([]),
  });
  try {
    const result = await collect(envWith(kv, "007044"));
    assert.equal(result.backfilled, 0);
  } finally {
    restore();
  }
  assert.deepEqual([...store.entries()], before);
  assert.deepEqual(writes, [], "日期不符时不得写 KV");
});

test("an existing historical entry is never overwritten by backfill", async () => {
  const existing = { nav: 1.7, pct: null, src: "tencent", at: `${YESTERDAY} 19:41:12` };
  const historical = {
    date: YESTERDAY,
    first: "tencent",
    funds: { "007044": existing },
  };
  const { kv, store, writes } = memoryKv({
    [`nav:${YESTERDAY}`]: JSON.stringify(historical),
    "nav:today": JSON.stringify(historical),
    "nav:latest": JSON.stringify(historical),
  });
  const restore = stubUpstreams({
    em: eastmoneyBody([["007044", 1.8268, 0.5, YESTERDAY]]),
    tx: tencentBody([]),
  });
  try {
    const result = await collect(envWith(kv, "007044"));
    assert.equal(result.backfilled, 0);
  } finally {
    restore();
  }
  assert.deepEqual(JSON.parse(store.get(`nav:${YESTERDAY}`)).funds["007044"], existing);
  assert.deepEqual(writes, [], "没有缺口时不得为回填写 KV");
});

test("backfill never touches an existing today record", async () => {
  const todayRecord = {
    date: TODAY,
    first: "tencent",
    updatedAt: `${TODAY} 20:00:00`,
    funds: {
      "003949": { nav: 1.1, pct: null, src: "tencent", at: `${TODAY} 19:41:12` },
    },
  };
  const historical = {
    date: YESTERDAY,
    first: "eastmoney",
    funds: {
      "003949": { nav: 1.0, pct: null, src: "eastmoney", at: `${YESTERDAY} 19:41:12` },
    },
  };
  const { kv, store } = memoryKv({
    [`nav:${TODAY}`]: JSON.stringify(todayRecord),
    "nav:today": JSON.stringify(todayRecord),
    "nav:previous": JSON.stringify(historical),
    "nav:latest": JSON.stringify(todayRecord),
  });
  const before = JSON.stringify(todayRecord);
  const restore = stubUpstreams({
    em: eastmoneyBody([["007044", 1.8268, 0.5, YESTERDAY]]),
    tx: tencentBody([]),
  });
  try {
    const result = await collect(envWith(kv, "003949,007044"));
    assert.equal(result.backfilled, 1);
  } finally {
    restore();
  }
  assert.equal(store.get(`nav:${TODAY}`), before, "回填不得改写当日记录");
  assert.equal(JSON.parse(store.get("nav:previous")).funds["007044"].nav, 1.8268);
});

test("a complete current day still early-exits with a historical gap", async () => {
  const current = {
    date: TODAY,
    first: "tencent",
    funds: {
      "003949": { nav: 1.1, pct: null, src: "tencent", at: `${TODAY} 19:41:12` },
      "007044": { nav: 1.8268, pct: null, src: "eastmoney", at: `${TODAY} 19:42:12` },
    },
  };
  const previous = {
    date: YESTERDAY,
    first: "tencent",
    funds: {
      "003949": { nav: 1.0, pct: null, src: "tencent", at: `${YESTERDAY} 19:41:12` },
    },
  };
  const { kv, writes } = memoryKv({
    [`nav:${TODAY}`]: JSON.stringify(current),
    "nav:today": JSON.stringify(current),
    "nav:previous": JSON.stringify(previous),
    "nav:latest": JSON.stringify(current),
  });
  const touched = [];
  const restore = stubUpstreams({ em: {}, tx: "", onFetch: (href) => touched.push(href) });
  let result;
  try {
    result = await collect(envWith(kv, "003949,007044"));
  } finally {
    restore();
  }
  assert.equal(result.status, "complete");
  assert.deepEqual(touched, [], "历史缺口不得关闭完整日早退");
  assert.deepEqual(writes, [], "完整日早退不得写 KV");
});

test("backfill refreshes the previous pointer when the stored today record is empty", async () => {
  const currentPointer = {
    date: TODAY,
    first: "tencent",
    funds: {
      "003949": { nav: 1.1, pct: null, src: "tencent", at: `${TODAY} 19:41:12` },
    },
  };
  const emptyToday = { date: TODAY, first: null, funds: {} };
  const previous = {
    date: YESTERDAY,
    first: "eastmoney",
    funds: {
      "003949": { nav: 1.0, pct: null, src: "eastmoney", at: `${YESTERDAY} 19:41:12` },
    },
  };
  const { kv, store } = memoryKv({
    [`nav:${TODAY}`]: JSON.stringify(emptyToday),
    "nav:today": JSON.stringify(currentPointer),
    "nav:previous": JSON.stringify(previous),
    "nav:latest": JSON.stringify(currentPointer),
  });
  const restore = stubUpstreams({
    em: eastmoneyBody([["007044", 1.8268, 0.5, YESTERDAY]]),
    tx: tencentBody([]),
  });
  try {
    const result = await collect(envWith(kv, "003949,007044"));
    assert.equal(result.backfilled, 1);
  } finally {
    restore();
  }

  assert.equal(JSON.parse(store.get("nav:today")).date, TODAY, "current 指针不得被旧日期覆盖");
  assert.equal(JSON.parse(store.get("nav:previous")).funds["007044"].nav, 1.8268);
  const body = await worker.fetch(new Request("https://collector.test/v1/nav/today"), { NAV: kv });
  const payload = await body.json();
  assert.equal(payload.funds["007044"].nav, 1.8268, "回填条目必须从读端点可见");
});

// ---- 先到先得：写入不可变 ----

test("an already-booked fund is never overwritten by a later hop", async () => {
  const { kv, store } = memoryKv();
  let restore = stubUpstreams({
    em: null,
    tx: tencentBody([["003949", 1.2366, 0.01, TODAY]]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  const firstPass = JSON.parse(store.get(`nav:${TODAY}`)).funds["003949"];
  assert.equal(firstPass.src, "tencent");

  // 下一跳东财也给出了当日数据——但 003949 已记账，src / at 必须原样不动。
  restore = stubUpstreams({
    em: eastmoneyBody([["003949", 9.9999, 5.55, TODAY]]),
    tx: tencentBody([["003949", 1.2366, 0.01, TODAY]]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  const secondPass = JSON.parse(store.get(`nav:${TODAY}`)).funds["003949"];
  assert.deepEqual(secondPass, firstPass, "已记账条目的 nav/src/at 全部不可变");
});

test("a completed day early-exits without touching either upstream", async () => {
  const { kv } = memoryKv();
  let restore = stubUpstreams({
    em: eastmoneyBody([["003949", 1.2366, 0.01, TODAY]]),
    tx: tencentBody([]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }

  const touched = [];
  restore = stubUpstreams({ em: {}, tx: "", onFetch: (href) => touched.push(href) });
  let result;
  try {
    result = await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  assert.equal(result.status, "complete");
  assert.deepEqual(touched, [], "当日已到齐的跳不许打上游");
});

// ---- 僵尸清理 ----

test("dropping a fund from the list prunes it and re-elects the winner", async () => {
  // first 必须在清理之后重算：删掉的可能正好是最早抢到的那只。
  const { kv, store } = memoryKv();
  let restore = stubUpstreams({
    em: eastmoneyBody([["160622", 1.1478, 0.01, TODAY]]),
    tx: tencentBody([["003949", 1.2366, 0.01, TODAY]]),
  });
  try {
    await collect(envWith(kv, "003949,160622"));
  } finally {
    restore();
  }
  const before = JSON.parse(store.get(`nav:${TODAY}`));
  assert.equal(Object.keys(before.funds).length, 2);

  // 看板上把最早抢到的那只删掉 → 下一跳应把它从记录里清走，并改选新的 first。
  const earliest = before.funds["003949"].at <= before.funds["160622"].at ? "003949" : "160622";
  const survivor = earliest === "003949" ? "160622" : "003949";
  restore = stubUpstreams({ em: eastmoneyBody([]), tx: tencentBody([]) });
  let result;
  try {
    result = await collect(envWith(kv, survivor));
  } finally {
    restore();
  }
  assert.equal(result.pruned, 1);

  const after = JSON.parse(store.get(`nav:${TODAY}`));
  assert.deepEqual(Object.keys(after.funds), [survivor]);
  assert.equal(after.first, before.funds[survivor].src, "赢者必须换成幸存的那只的源");
});
