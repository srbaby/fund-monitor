// Cloudflare Worker：15:15 固化旁路快照 + 夜间自愈触发 PE 引擎。
//
// Cron（UTC）：
//   15 7  * * MON-FRI  → 北京15:15，固化收盘后旁路PE快照
//   30 12 * * MON-FRI  → 北京20:30，夜间首试
//   30 13 * * MON-FRI  → 北京21:30，夜间兜底
//   0 14  * * MON-FRI  → 北京22:00，哨兵检查并推送最终结果
//
// Worker 变量：
//   GH_REPO          srbaby/fund-monitor
//   GH_TOKEN         对仓库 Contents + Actions 有写权限
//   PE_GIST_ID       看板使用的 Gist ID
//   PE_GIST_TOKEN    可选；Gist 可直接读取时无需配置
//   BARK_KEY         可选；Bark 推送 key

const WORKFLOW = "pe-night-engine.yml";
const ENGINE_FILE = "fm_pe_engine.json";
const SNAPSHOT_PATH = "automation/pe-snapshot.json";
const PUBLIC_LOG_URL_PATH = "automation/validation-log.json";
const SNAPSHOT_CRON = "15 7 * * MON-FRI";
const SENTINEL_CRON = "0 14 * * MON-FRI";

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === SNAPSHOT_CRON) {
      ctx.waitUntil(captureSnapshot(env));
      return;
    }
    ctx.waitUntil(runNight(env, `cron:${event.cron}`, event.cron === SENTINEL_CRON));
  },

  // 浏览器手动入口：?key=GH_TOKEN第12-19位
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key || key !== env.GH_TOKEN.slice(11, 19)) {
      return new Response("forbidden", { status: 403 });
    }
    const action = url.searchParams.get("action");
    const result =
      action === "snapshot"
        ? await captureSnapshot(env)
        : await runNight(env, "manual", false);
    return new Response(result, { status: 200 });
  },
};

async function captureSnapshot(env) {
  const today = todayBJ();
  try {
    const existing = await readRepoJson(env, SNAPSHOT_PATH);
    if (existing?.json?.date === today && existing.json.status === "captured") {
      const msg = `15:15快照已存在：${today} ${existing.json.sampleAt}`;
      console.log(msg);
      return msg;
    }

    const [engine, quote] = await Promise.all([
      readEngineGist(env),
      fetchQQIndex(),
    ]);

    if (!engine?.peYest || !engine?.mcapYest || !Array.isArray(engine.peSorted)) {
      throw new Error("旁路夜锚不完整");
    }
    if (quote.date !== today) {
      const msg = `非交易日或腾讯行情日期未更新：quote=${quote.date} today=${today}`;
      console.log(msg);
      return msg;
    }

    const bypassPe = engine.peYest * (quote.mcap / engine.mcapYest);
    const count = upperBound(engine.peSorted, bypassPe);
    const bypassPct = (count / engine.peSorted.length) * 100;
    const capturedAt = nowBJ();
    const snapshot = {
      v: capturedAt,
      date: today,
      sampleAt: capturedAt.slice(11),
      quoteAt: quote.time,
      anchorDate: engine.date,
      mcap: round(quote.mcap, 2),
      bypassPe: round(bypassPe, 4),
      bypassPct: round(bypassPct, 2),
      status: "captured",
    };

    await writeRepoJson(
      env,
      SNAPSHOT_PATH,
      snapshot,
      existing?.sha,
      `engine: 15:15旁路快照 ${today}`
    );
    const msg =
      `✓ 15:15旁路快照 ${today} ${snapshot.sampleAt}：` +
      `PE ${snapshot.bypassPe.toFixed(4)}，百分位 ${snapshot.bypassPct.toFixed(2)}%`;
    console.log(msg);
    return msg;
  } catch (error) {
    const msg = `15:15旁路快照失败：${error.message}`;
    console.log(msg);
    await barkPush(env, "🔴 15:15旁路快照失败", msg, true);
    return msg;
  }
}

async function runNight(env, source, isSentinel) {
  const today = todayBJ();
  let publicLog = null;
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/${env.GH_REPO}/main/${PUBLIC_LOG_URL_PATH}?nc=${Date.now()}`,
      {
        headers: { "User-Agent": "cf-worker-pe-trigger" },
        cf: { cacheTtl: 0 },
      }
    );
    if (response.ok) publicLog = await response.json();
  } catch (_) {}

  if (publicLog?.date === today) {
    if (isSentinel) await pushValidationResult(env, publicLog);
    const msg = `[${source}] 当晚验证日志已写（date=${today}），跳过`;
    console.log(msg);
    return msg;
  }

  if (isSentinel) {
    await barkPush(
      env,
      "🔴 PE夜间官方值未写",
      `22:00核查：公开日志日期=${publicLog?.date ?? "读取失败"}，已最后补触发一次`,
      true
    );
  }

  const response = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(env),
      body: JSON.stringify({
        ref: "main",
        inputs: { slot: isSentinel || source === "manual" ? "late" : "early" },
      }),
    }
  );
  const ok = response.status === 204;
  const detail = ok ? "OK" : `FAIL: ${await response.text()}`;
  const msg = `[${source}] validation日期=${publicLog?.date ?? "读取失败"}，dispatch ${response.status} ${detail}`;
  console.log(msg);

  if (!ok) {
    await barkPush(
      env,
      "🔴 PE引擎触发失败",
      `${source} dispatch返回${response.status}，需人工处理`,
      true
    );
  }
  return msg;
}

async function pushValidationResult(env, publicLog) {
  const last = publicLog?.log?.length
    ? publicLog.log[publicLog.log.length - 1]
    : null;
  if (!last || last.date !== publicLog.date) {
    await barkPush(env, "🔴 旁路验证记录缺失", `date=${publicLog.date}，log无当日记录`, true);
    return;
  }
  if (last.status !== "complete") {
    await barkPush(
      env,
      "🔴 15:15旁路快照缺失",
      `${last.date} 晚间官方 ${formatPct(last.officialPct)}，但没有可配对的15:15快照`,
      true
    );
    return;
  }
  await barkPush(
    env,
    "🟢 旁路验证完成",
    `${last.date}｜15:15旁路 ${formatPct(last.bypassPct)}｜晚间官方 ${formatPct(last.officialPct)}｜偏差 ${formatDiff(last.diffPp)}`,
    false
  );
}

async function readEngineGist(env) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cf-worker-pe-trigger",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.PE_GIST_TOKEN) headers.Authorization = `Bearer ${env.PE_GIST_TOKEN}`;
  const response = await fetch(
    `https://api.github.com/gists/${env.PE_GIST_ID}?nc=${Date.now()}`,
    { headers }
  );
  if (!response.ok) throw new Error(`读取Gist失败：${response.status}`);
  const gist = await response.json();
  const content = gist?.files?.[ENGINE_FILE]?.content;
  if (!content) throw new Error(`Gist缺少${ENGINE_FILE}`);
  return JSON.parse(content);
}

async function fetchQQIndex() {
  const response = await fetch(
    `https://qt.gtimg.cn/q=sh000300&r=${Date.now()}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://gu.qq.com/",
      },
      cf: { cacheTtl: 0 },
    }
  );
  if (!response.ok) throw new Error(`腾讯行情请求失败：${response.status}`);
  const text = await response.text();
  const fields = text.split("~");
  const mcap = Number(fields[45]);
  const stamp = fields[30] || "";
  if (!(mcap > 0) || !/^\d{14}$/.test(stamp)) {
    throw new Error("腾讯行情字段无效");
  }
  return {
    mcap,
    date: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`,
    time: `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`,
  };
}

async function readRepoJson(env, path) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/contents/${path}?ref=main&nc=${Date.now()}`,
    { headers: githubHeaders(env) }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`读取${path}失败：${response.status}`);
  const file = await response.json();
  return { sha: file.sha, json: JSON.parse(decodeBase64Utf8(file.content)) };
}

async function writeRepoJson(env, path, value, sha, message) {
  const body = {
    message,
    content: encodeBase64Utf8(JSON.stringify(value, null, 2) + "\n"),
    branch: "main",
  };
  if (sha) body.sha = sha;
  const response = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: githubHeaders(env),
      body: JSON.stringify(body),
    }
  );
  if (!response.ok) {
    throw new Error(`写入${path}失败：${response.status} ${await response.text()}`);
  }
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "cf-worker-pe-trigger",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function upperBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function todayBJ() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function nowBJ() {
  return new Date(Date.now() + 8 * 3600 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(base64) {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function formatPct(value) {
  return value == null ? "缺失" : `${Number(value).toFixed(2)}%`;
}

function formatDiff(value) {
  if (value == null) return "缺失";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}pp`;
}

async function barkPush(env, title, body, urgent) {
  if (!env.BARK_KEY) {
    console.log(`BARK_KEY未配置：${title}｜${body}`);
    return;
  }
  const params = urgent ? "level=timeSensitive&sound=alarm" : "level=active";
  const icon = "https://cdn.jsdelivr.net/gh/srbaby/fund-monitor@main/favicon.png";
  try {
    const response = await fetch(
      `https://api.day.app/${env.BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${params}&group=PE引擎&badge=1&icon=${encodeURIComponent(icon)}`
    );
    console.log(`Bark推送 -> ${response.status}`);
  } catch (error) {
    console.log(`Bark推送异常：${error.message}`);
  }
}
