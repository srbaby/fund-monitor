// Cloudflare Worker：自愈式触发 fund-monitor 的 PE夜间数据引擎（pe-night-engine.yml）
// v2：新增 22:00 哨兵槽 + Bark 死信告警（哨兵每晚必推绿/红灯，其余槽异常时才推）
//
// 槽位设计（哨兵设在 22:00，留 2 小时人工应急窗口至 24:00 跨午夜红线）：
//   20:30 首试   → 锚未写则 dispatch（静默）
//   21:30 兜底   → 同上（20:30 成功则自动跳过，静默）
//   22:00 哨兵   → 每晚必推送，绿灯/红灯一眼定：
//                  🟢 锚已写 → 报 date + 最新errPp（KPI直达手机）
//                  🔴 锚未写 → 告警 + 最后补触发一次
//                  任何槽 dispatch 失败（非204）也会立即推送🔴
//
// 需要配置（Worker → 设置 → 变量和机密）：
//   GH_REPO  (文本)   srbaby/fund-monitor
//   GH_TOKEN (机密)   fine-grained PAT（Actions 读写）
//   BARK_KEY (机密)   Bark App 的推送 key（不配则告警静默降级为仅日志）
//
// Cron（UTC，三条）⚠️ CF cron 星期字段 1=周日，务必用英文缩写：
//   30 12 * * MON-FRI   → 北京 20:30 首试
//   30 13 * * MON-FRI   → 北京 21:30 兜底
//   0 14 * * MON-FRI    → 北京 22:00 哨兵（告警槽）

const WORKFLOW = "pe-night-engine.yml";
const SENTINEL_CRON = "0 14 * * MON-FRI"; // 哨兵槽标识，须与上面第三条完全一致

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, `cron:${event.cron}`, event.cron === SENTINEL_CRON));
  },

  // 浏览器手动入口：?key=GH_TOKEN第12-19位（github_pat_ 之后的8位）
  async fetch(request, env) {
    const key = new URL(request.url).searchParams.get("key");
    if (!key || key !== env.GH_TOKEN.slice(11, 19)) {
      return new Response("forbidden", { status: 403 });
    }
    return new Response(await run(env, "manual", false), { status: 200 });
  },
};

async function run(env, source, isSentinel) {
  const todayBJ = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  // 1) 查验证日志（带随机参数防CDN陈旧缓存）
  let logDate = null;
  let logJson = null;
  try {
    const r = await fetch(
      `https://raw.githubusercontent.com/${env.GH_REPO}/main/automation/validation-log.json?nocache=${Date.now()}`,
      { headers: { "User-Agent": "cf-worker-pe-trigger" }, cf: { cacheTtl: 0 } }
    );
    if (r.ok) {
      logJson = await r.json();
      logDate = logJson.date;
    }
  } catch (e) { /* 读不到不阻塞，照常触发 */ }

  if (logDate === todayBJ) {
    // 哨兵槽：绿灯推送（每晚必报，附最新errPp）
    if (isSentinel) {
      const last = logJson?.log?.length ? logJson.log[logJson.log.length - 1] : null;
      const errInfo = last?.errPp !== undefined ? `最新errPp=${last.errPp}pp` : "log尚无errPp记录";
      await barkPush(env, "🟢 PE夜锚正常", `date=${logDate}，写于${logJson?.v ?? "?"}。${errInfo}`, false);
    }
    const msg = `[${source}] 当晚锚已写（date=${logDate}），跳过`;
    console.log(msg);
    return msg;
  }

  // 2) 哨兵槽走到这里 = 前两槽都没成 → 红灯告警（同时仍补触发）
  if (isSentinel) {
    await barkPush(
      env,
      "🔴 PE夜锚未写",
      `22:00核查：log日期=${logDate ?? "读取失败"}，已最后补触发一次。请24:00前点核对链接确认（应急窗口2小时）`,
      true
    );
  }

  // 3) 触发工作流
  const r = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "cf-worker-pe-trigger",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // 槽位身份传给 pe_nightly.py：early=乐咕未更新时温和退出等下一槽；late=明确报错
      body: JSON.stringify({ ref: "main", inputs: { slot: isSentinel || source === "manual" ? "late" : "early" } }),
    }
  );

  const ok = r.status === 204;
  const msg = `[${source}] log日期=${logDate ?? "读取失败"} ≠ ${todayBJ}，dispatch -> ${r.status}${
    ok ? " OK" : " FAIL: " + (await r.text())
  }`;
  console.log(msg);

  // 4) dispatch 本身失败 → 任何槽都推送（说明触发链路坏了，自愈已不可能）
  if (!ok) {
    await barkPush(env, "🔴 PE引擎触发失败", `${source} dispatch返回${r.status}，需人工处理（点核对链接或GitHub手动Run）`, true);
  }

  return msg;
}

// Bark 推送（iOS）。BARK_KEY 未配置时静默跳过。
// urgent=true：时效性通知+响铃（红灯）；false：普通通知（绿灯）
// badge=1 给主屏幕App图标加红点（固定值，看完手动清，不是真未读计数）；
// icon 仅影响Bark App内历史列表的图标（系统通知横幅图标是iOS限制，第三方App改不了）。
async function barkPush(env, title, body, urgent) {
  if (!env.BARK_KEY) {
    console.log("BARK_KEY未配置，告警仅记日志：" + title);
    return;
  }
  const params = urgent ? "level=timeSensitive&sound=alarm" : "level=active";
  const icon = "https://cdn.jsdelivr.net/gh/srbaby/fund-monitor@main/favicon.png";
  try {
    const r = await fetch(
      `https://api.day.app/${env.BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${params}&group=PE引擎&badge=1&icon=${encodeURIComponent(icon)}`
    );
    console.log(`bark推送 -> ${r.status}`);
  } catch (e) {
    console.log("bark推送异常: " + e.message);
  }
}
