// Cloudflare Worker: pe-night-trigger (幂等下沉 Python 版)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const action = url.searchParams.get("action");

    // 1. 安全校验暗号
    if (!token || token !== env.CRON_TOKEN) {
      return new Response("Forbidden: Invalid or Missing Token", {
        status: 403,
      });
    }

    // 2. 获取当前的北京时间日期 (格式: YYYY-MM-DD)
    const bjTime = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
    const today = bjTime.toISOString().split("T")[0];
    const timeStr = bjTime.toTimeString().split(" ")[0];

    // 3. 核心业务路由控制
    // snapshot（16:00 旁路快照）随双路验证层于 2026-07-19 一并拆除，
    // Master-Scheduler 侧的 16:00 那一跳应同步取消。
    if (action === "night" || action === "sentinel") {
      // =========================================================
      // 【20:30 / 21:30 / 22:00 任务】无需去重，每次都直接穿透触发
      // =========================================================
      const ghRes = await triggerGitHubDispatch(env, action, {
        date: today,
        triggeredAt: timeStr,
      });

      if (ghRes.success) {
        return new Response(
          `[Success] [pe-${action}] 成功唤醒 GitHub Actions -> 204 OK`,
          { status: 200 },
        );
      } else {
        return new Response(`[Fail] 唤醒 GitHub 失败: ${ghRes.text}`, {
          status: ghRes.status,
        });
      }
    } else {
      return new Response("Invalid Action", { status: 400 });
    }
  },
};

// 封装标准的 GitHub Repository Dispatch 触发器
async function triggerGitHubDispatch(env, actionType, payload) {
  const githubUrl = `https://api.github.com/repos/${env.GH_REPO}/dispatches`;

  try {
    const response = await fetch(githubUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Cloudflare-Worker-KV-Deduplicator",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // 对应你 GitHub Actions YAML 工作流中 repository_dispatch 的 types 监听
        event_type: actionType,
        client_payload: payload,
      }),
    });

    if (response.status === 204) {
      return { success: true, status: 204, text: "OK" };
    } else {
      const errText = await response.text();
      return { success: false, status: response.status, text: errText };
    }
  } catch (e) {
    return { success: false, status: 500, text: `网络异常: ${e.message}` };
  }
}

