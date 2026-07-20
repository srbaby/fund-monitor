// Last-known-good 持久层。存在理由见 docs/DECISIONS.md 的 D-001。
//
// 行情拿不到新数据时必须退回上次好数据，而不是把用户已看到的数据冲成空。
// 保护放在网关而不是浏览器 localStorage，是因为后者是单机的：换台电脑、
// 或手机冷启动，晚上打开看板照样空白，等于没保护。
//
// 未绑定 KV 时全部降级为 no-op，网关行为与加这层之前完全一致。

// KV 写配额有限，成功不必每次落盘。盘中 5 分钟一次，足以让收盘前最后一份
// 好数据进库——那份正是"晚上打开还能看到今天"所依赖的东西。
const WRITE_THROTTLE_MS = 5 * 60_000;

// 陈旧数据的保质期，留到 72 小时是为了跨过周末。
// 放心留这么久的前提是：数据自带 quoteAt，且以 status:"stale" 返回，前端会把
// 时间戳露出来。"旧"本身不危险，"旧且不告知"才危险。
const MAX_AGE_MS = 72 * 3_600_000;

// 跨 isolate 不共享，冷启动会多写一次；这只是为了砍掉绝大多数冗余写入，
// 不追求精确，故意不为它多花一次 KV 读。
const lastWriteAt = new Map();

function kvOf(env) {
  return env?.MARKET_LKG || null;
}

export async function readLastKnownGood(env, key, now = Date.now()) {
  const kv = kvOf(env);
  if (!kv) return null;
  try {
    const record = await kv.get(`lkg:${key}`, "json");
    if (!record?.savedAt || !record.payload) return null;
    return now - record.savedAt > MAX_AGE_MS ? null : record;
  } catch (error) {
    return null;
  }
}

export function saveLastKnownGood(env, context, key, payload, now = Date.now()) {
  const kv = kvOf(env);
  if (!kv || !payload?.ok) return;
  const previous = lastWriteAt.get(key);
  if (previous && now - previous < WRITE_THROTTLE_MS) return;
  lastWriteAt.set(key, now);
  // 落盘失败就把记账撤掉，否则这个 isolate 会在整个节流窗口里假装已经存过
  const write = kv
    .put(`lkg:${key}`, JSON.stringify({ savedAt: now, payload }))
    .catch(() => lastWriteAt.delete(key));
  if (context?.waitUntil) context.waitUntil(write);
}

// 陈旧回退保持 ok:true —— 数据本身是完整的一组，前端照常渲染，
// 只是必须据 status 把它标灰。servedFrom 留着，便于回答"这份旧数据当初来自哪条线路"。
export function stalePayload(record, now = Date.now()) {
  return {
    ...record.payload,
    status: "stale",
    sourceLabel: `陈旧 · ${record.payload.sourceLabel}`,
    servedFrom: record.payload.status,
    staleSince: record.savedAt,
    staleAgeMs: now - record.savedAt,
  };
}

export function resetLkgThrottle() {
  lastWriteAt.clear();
}
