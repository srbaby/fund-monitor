// ============================================================
// fund-nav-collector 冒烟测试
//
// 存在理由一：2026-07-24 起采集器静默停采两个交易日，根因是一个未定义引用，每次真抓到
// 数据都在写盘前抛错。这是**一行冒烟测试就能挡住**的故障，而当时这个目录一个用例都没有。
// 所以第一条用例锁的就是"真采到数据的一跳必须把 nav:funds 写进 KV 且 updatedAt 非空"——
// 它不测细节，它测的是"写盘这条路根本走不走得通"。
//
// 存在理由二：2026-08-05 晚间，一只当天新加的基金在官方净值刷新期间整只从看板上消失，
// 根因是旧模型把数据按日期存成整份记录，晚上一旦开始写今天那份，读取口径整体切换，
// 而新基金不在被切过去的那一份里。新模型改成「每只基金两行、行的身份是净值日期」，
// 下面 "a fund that has no NAV today is still served in full" 就是那次事故的回归线。
//
// 上游用 globalThis.fetch 桩替换（采集器直接调全局 fetch，不做依赖注入）。
// 腾讯那路要过 TextDecoder("gbk")，故 fixture 里的基金名一律用 ASCII——
// GBK 对 ASCII 字节是透传的，这样不必在测试里引 iconv。
// ============================================================

import assert from "node:assert/strict";
import test from "node:test";
import { buildNavPayload, collect, normalizeState } from "../src/index.js";

const DAY_MS = 86_400_000;
const bj = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3_600_000 - offsetDays * DAY_MS).toISOString().slice(0, 10);
const TODAY = bj(0);
const YESTERDAY = bj(1);
const TWO_DAYS_AGO = bj(2);

function memoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    kv: {
      get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
      put: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
    },
    store,
  };
}

// GIST_ID / GIST_TOKEN 故意不配：loadCodes 会直接落到 FALLBACK_CODES，
// 于是测试不必桩 GitHub API。codesSource 因此恒为 "fallback"。
function envWith(kv, codes = "003949,160622") {
  return { NAV: kv, FALLBACK_CODES: codes };
}

function navState(store) {
  return JSON.parse(store.get("nav:funds"));
}

// 直接铺一份已有状态，省掉"先跑一跳把数据攒出来"的前置
function seedState(funds) {
  return {
    "nav:funds": JSON.stringify({
      updatedAt: `${YESTERDAY} 20:00:00`,
      funds: Object.fromEntries(
        Object.entries(funds).map(([code, rows]) => [
          code,
          {
            name: `NAME ${code}`,
            seeded: true,
            rows: rows.map(([date, nav, pct, src]) => ({
              date,
              nav,
              pct: pct ?? null,
              src: src || "eastmoney",
              at: `${date} 19:30:00`,
              gotAt: `${date} 19:30:00`,
            })),
          },
        ]),
      ),
    }),
  };
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

// 东财历史净值接口：按单只给出最近若干期，补种走的就是它
function historyBody(rows) {
  return {
    Success: true,
    Datas: rows.map(([date, nav, pct]) => ({
      FSRQ: date,
      DWJZ: String(nav),
      JZZZL: String(pct),
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
// history 按基金代码给，缺的那只当作接口没数据。
function stubUpstreams({ em, tx, history = {}, onFetch }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (onFetch) onFetch(href);
    if (href.includes("FundMNHisNetList")) {
      const code = new URL(href).searchParams.get("FCODE");
      if (!history[code]) throw new Error(`no history fixture for ${code}`);
      return jsonResponse(historyBody(history[code]));
    }
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

test("a hop that actually collects writes nav:funds with a non-empty updatedAt", async () => {
  const { kv, store } = memoryKv(
    seedState({ "003949": [[YESTERDAY, 1.2, 0.01]], "160622": [[YESTERDAY, 1.1, 0.01]] }),
  );
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

  const state = navState(store);
  assert.ok(state.updatedAt, "updatedAt 不能为空——它为空说明写盘路径又被绕过了");
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(state.funds["003949"].rows[0].nav, 1.2366);
  assert.equal(state.funds["003949"].rows[0].src, "eastmoney");
});

// ---- 今晚那次事故的回归线 ----

test("a fund that has no NAV today is still served in full", async () => {
  // 2026-08-05 晚间：别的基金已经出了今天的净值，这一只还没出。旧模型下它整只从响应里消失，
  // 看板上估算和官方两栏一起变空。新模型下它必须照常带着自己的两行出现。
  const { kv, store } = memoryKv(
    seedState({
      "003949": [[YESTERDAY, 1.2375, 0.01], [TWO_DAYS_AGO, 1.2374, 0.01]],
      "007044": [[YESTERDAY, 1.8268, 1.91], [TWO_DAYS_AGO, 1.7925, -0.93]],
    }),
  );
  const restore = stubUpstreams({
    em: eastmoneyBody([["003949", 1.2376, 0.01, TODAY]]), // 007044 今天还没披露
    tx: tencentBody([]),
  });
  try {
    await collect(envWith(kv, "003949,007044"));
  } finally {
    restore();
  }

  const payload = buildNavPayload(normalizeState(navState(store)), TODAY);
  assert.equal(payload.date, TODAY);
  assert.equal(payload.count, 1, "只有 003949 是今天的");
  assert.ok(payload.funds["007044"], "还没出净值的基金不许从响应里消失");
  assert.equal(payload.funds["007044"].nav, 1.8268);
  assert.equal(payload.funds["007044"].previousNav, 1.7925);
  assert.equal(
    payload.funds["007044"].at.slice(0, 10),
    YESTERDAY,
    "它的时间戳日期必须仍是昨天——看板据此把它标成旧数据",
  );
  assert.equal(payload.funds["003949"].nav, 1.2376);
});

// ---- 新基金补种 ----

test("a brand-new fund is seeded with its last two NAV days on the very next hop", async () => {
  // 下午加进看板的基金在旧模型下要等当晚自己的净值披露才第一次有数，白天整只是空的。
  const { kv, store } = memoryKv();
  const restore = stubUpstreams({
    em: eastmoneyBody([]), // 白天两个实时源都还没有今日净值
    tx: tencentBody([]),
    history: { "007044": [[YESTERDAY, 1.8268, 1.91], [TWO_DAYS_AGO, 1.7925, -0.93]] },
  });
  let result;
  try {
    result = await collect(envWith(kv, "007044"));
  } finally {
    restore();
  }
  assert.equal(result.seeded, 1);

  const entry = navState(store).funds["007044"];
  assert.equal(entry.rows.length, 2);
  assert.equal(entry.rows[0].date, YESTERDAY);
  assert.equal(entry.rows[1].date, TWO_DAYS_AGO);
  // 补种行的对外时间戳必须挂在净值自己的日期上。写成抓取当天的话，看板会把补回来的
  // 昨日净值当成今天刚出的官方净值，今天的收益就会拿昨天的涨幅去算。
  assert.equal(entry.rows[0].at.slice(0, 10), YESTERDAY);
  assert.equal(entry.rows[0].gotAt.slice(0, 10), TODAY, "真实抓取时刻另外留痕");

  const payload = buildNavPayload(normalizeState(navState(store)), TODAY);
  assert.equal(payload.funds["007044"].nav, 1.8268);
  assert.equal(payload.funds["007044"].previousNav, 1.7925);
});

test("a seeded fund still gets its name, not just its numbers", async () => {
  // 历史净值接口只给净值不给名字。名字漏了的话，看板上会显示成「基金 007044」。
  const { kv, store } = memoryKv();
  const restore = stubUpstreams({
    em: eastmoneyBody([["007044", 1.8268, 1.91, YESTERDAY]]),
    tx: tencentBody([]),
    history: { "007044": [[YESTERDAY, 1.8268, 1.91], [TWO_DAYS_AGO, 1.7925, -0.93]] },
  });
  try {
    await collect(envWith(kv, "007044"));
  } finally {
    restore();
  }
  assert.equal(navState(store).funds["007044"].name, "EM 007044");
});

test("seeded rows never claim the first-to-book badge", async () => {
  // 补种行的 at 是净值日 00:00:00，若参与评选会永远"最早"，把「谁先抢到」变成谎话。
  const { kv, store } = memoryKv();
  const restore = stubUpstreams({
    em: eastmoneyBody([]),
    tx: tencentBody([["003949", 1.2366, 0.01, TODAY]]),
    history: { "003949": [[YESTERDAY, 1.2365, 0.01]], "007044": [[TODAY, 1.8556, 1.58]] },
  });
  try {
    await collect(envWith(kv, "003949,007044"));
  } finally {
    restore();
  }
  const payload = buildNavPayload(normalizeState(navState(store)), TODAY);
  assert.equal(payload.first, "tencent", "赢家只在实时源之间评选");
  assert.equal(payload.firstCount, 1, "补种的那只不算谁抢到的");
  assert.equal(payload.count, 2, "但它确实是今天的净值，仍要计入当日只数");
});

test("seeding is attempted once, not on every hop", async () => {
  const { kv } = memoryKv();
  let restore = stubUpstreams({
    em: eastmoneyBody([]),
    tx: tencentBody([]),
    history: { "007044": [[YESTERDAY, 1.8268, 1.91]] }, // 只给得出一期
  });
  try {
    await collect(envWith(kv, "007044"));
  } finally {
    restore();
  }

  const touched = [];
  restore = stubUpstreams({
    em: eastmoneyBody([]),
    tx: tencentBody([]),
    onFetch: (href) => touched.push(href),
  });
  try {
    await collect(envWith(kv, "007044"));
  } finally {
    restore();
  }
  assert.equal(
    touched.filter((href) => href.includes("FundMNHisNetList")).length,
    0,
    "问过一次就别每分钟再问一次",
  );
});

// ---- 只收当日 + 滚动 ----

test("yesterday's NAV from a live source is never booked as today", async () => {
  // 原前端 bug 的根因：东财在净值未披露时返回昨日数据且 size>0，整组被采纳，
  // 腾讯备源一次都轮不到。这道闸门不许被"顺手放宽"。
  const { kv, store } = memoryKv(seedState({ "003949": [[YESTERDAY, 1.2299, 0.05]] }));
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
  assert.equal(result.added, 0, "昨日净值不得当成新的一天入账");
  assert.equal(navState(store).funds["003949"].rows.length, 1);
});

test("a newer NAV day rolls the window and keeps exactly the previous day", async () => {
  // -2day 出局、-1day 必须留下：它是收益基准。
  const { kv, store } = memoryKv(
    seedState({ "003949": [[YESTERDAY, 1.2375, 0.01], [TWO_DAYS_AGO, 1.2374, 0.02]] }),
  );
  const restore = stubUpstreams({
    em: eastmoneyBody([["003949", 1.2376, 0.01, TODAY]]),
    tx: tencentBody([]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  const rows = navState(store).funds["003949"].rows;
  assert.deepEqual(rows.map((row) => row.date), [TODAY, YESTERDAY]);
  assert.equal(rows[0].nav, 1.2376);
  assert.equal(rows[1].nav, 1.2375);
});

test("a single live source carries the day when the other returns stale data", async () => {
  const { kv, store } = memoryKv(seedState({ "003949": [[YESTERDAY, 1.2299, 0.05]] }));
  const restore = stubUpstreams({
    em: eastmoneyBody([["003949", 1.2299, 0.05, YESTERDAY]]),
    tx: tencentBody([["003949", 1.2366, 0.01, TODAY]]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  const state = navState(store);
  assert.equal(state.funds["003949"].rows[0].src, "tencent");
  assert.equal(buildNavPayload(normalizeState(state), TODAY).first, "tencent");
});

test("an already-booked day is never overwritten by a later hop", async () => {
  const { kv, store } = memoryKv(seedState({ "003949": [[YESTERDAY, 1.2, 0.01]] }));
  let restore = stubUpstreams({
    em: null,
    tx: tencentBody([["003949", 1.2366, 0.01, TODAY]]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  const firstPass = navState(store).funds["003949"].rows[0];
  assert.equal(firstPass.src, "tencent");

  // 下一跳东财也给出了当日数据——但今天这行已记账，nav / src / at / gotAt 必须原样不动。
  restore = stubUpstreams({
    em: eastmoneyBody([["003949", 9.9999, 5.55, TODAY]]),
    tx: tencentBody([["003949", 1.2366, 0.01, TODAY]]),
  });
  try {
    await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  assert.deepEqual(navState(store).funds["003949"].rows[0], firstPass);
});

test("a completed day early-exits without touching any upstream", async () => {
  const { kv } = memoryKv(
    seedState({ "003949": [[TODAY, 1.2376, 0.01], [YESTERDAY, 1.2375, 0.01]] }),
  );
  const touched = [];
  const restore = stubUpstreams({ em: {}, tx: "", onFetch: (href) => touched.push(href) });
  let result;
  try {
    result = await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  assert.equal(result.status, "complete");
  assert.deepEqual(touched, [], "当日已到齐的跳不许打上游");
});

test("a throwing upstream leaves existing rows untouched and writes nothing", async () => {
  const { kv, store } = memoryKv(seedState({ "003949": [[YESTERDAY, 1.2375, 0.01]] }));
  const before = store.get("nav:funds");
  const restore = stubUpstreams({ em: null, tx: null, history: {} });
  let result;
  try {
    result = await collect(envWith(kv, "003949"));
  } finally {
    restore();
  }
  assert.equal(result.status, "collected");
  assert.equal(result.added, 0);
  assert.equal(store.get("nav:funds"), before, "什么都没采到时不该改动已有数据");
});

// ---- 僵尸清理 ----

test("dropping a fund from the list removes it whole and re-elects the winner", async () => {
  const { kv, store } = memoryKv(
    seedState({
      "003949": [[TODAY, 1.2376, 0.01], [YESTERDAY, 1.2375, 0.01]],
      "160622": [[TODAY, 1.1495, 0.11], [YESTERDAY, 1.1482, 0.07]],
    }),
  );
  // 最早抢到的那只被删掉 → 它整个条目消失，赢家改选幸存的那只
  const state = navState(store);
  state.funds["003949"].rows[0].gotAt = `${TODAY} 19:10:00`;
  state.funds["003949"].rows[0].src = "tencent";
  state.funds["160622"].rows[0].gotAt = `${TODAY} 20:26:55`;
  state.funds["160622"].rows[0].src = "eastmoney";
  store.set("nav:funds", JSON.stringify(state));

  const restore = stubUpstreams({ em: eastmoneyBody([]), tx: tencentBody([]) });
  let result;
  try {
    result = await collect(envWith(kv, "160622"));
  } finally {
    restore();
  }
  assert.equal(result.pruned, 1);

  const after = navState(store);
  assert.deepEqual(Object.keys(after.funds), ["160622"]);
  assert.equal(
    buildNavPayload(normalizeState(after), TODAY).first,
    "eastmoney",
    "赢家必须换成幸存的那只的源",
  );
});

// ---- 对外形状 ----

test("the payload derives each percentage from the fund's own two rows", async () => {
  const state = normalizeState({
    updatedAt: `${TODAY} 21:04:55`,
    funds: {
      "003949": {
        name: "XQ",
        rows: [
          { date: TODAY, nav: 1.0123, pct: 99, src: "eastmoney", at: `${TODAY} 20:00:00`, gotAt: `${TODAY} 20:00:00` },
          { date: YESTERDAY, nav: 1.0, pct: 0.5, src: "tencent", at: `${YESTERDAY} 20:00:00`, gotAt: `${YESTERDAY} 20:00:00` },
        ],
      },
    },
  });
  const payload = buildNavPayload(state, TODAY);
  assert.equal(Number(payload.funds["003949"].pct.toFixed(4)), 1.23, "涨跌幅由相邻两次净值派生");
  assert.equal(payload.funds["003949"].previousNav, 1.0);
  assert.equal(payload.funds["003949"].previousDate, YESTERDAY);
  assert.equal(payload.funds["003949"].previousPct, 0.5);
  assert.equal(payload.updatedAt, `${TODAY} 21:04:55`);
});

test("a corrupted entry is dropped instead of poisoning the payload", async () => {
  const state = normalizeState({
    funds: {
      "003949": { rows: [{ date: "not-a-date", nav: 1 }, { date: TODAY, nav: 0 }] },
      "160622": { rows: [{ date: TODAY, nav: 1.1495, src: "eastmoney", at: `${TODAY} 20:00:00` }] },
    },
  });
  const payload = buildNavPayload(state, TODAY);
  assert.deepEqual(Object.keys(payload.funds), ["160622"]);
});
