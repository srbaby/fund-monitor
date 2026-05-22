// ============================================================
// logger.js - 云端日志模块
//
// 用途：记录所有本地写入和云端推送操作，供多端数据核查与问题排查。
//
// 配置：云同步格式 GistID,Token，日志写入主 Gist 的 fm_log.json 文件。
//   首次使用前须在主 Gist 手动添加 fm_log.json，初始内容为 []。
//
// 加载顺序：index.html 中 config.js 之后、store.js 之前。
//
// 当前接入点（8处）：
//   store.js
//     - saveFunds          基金列表变更（含拖拽排序）
//     - savePe             PE 定锚更新
//     - saveHoldingsData   持仓份额 / 权益 / 短名称保存
//     - saveSellPlan       降权预案保存
//     - savePrioritySell   设置优先卖出品种
//     - clearPrioritySell  清除优先卖出品种
//     - importSnapshot     云端拉取覆盖本地（记录 f/p/h/s/pr 完整字段）
//   interact.js
//     - syncCloud_push     云端推送完整 payload
//
// 日志格式（fm_log.json，最多200条滚动覆盖）：
//   { t: ISO时间戳, c: 客户端标识(ios/local/web), fn: 触发函数名, data: 写入内容快照 }
//
// 容量说明：
//   上限设为200条，基于实际使用观察（运行数天约产生70条）调整，
//   按日均20次操作估算可覆盖约10天，满足日常排查需求。
//   单条体积约 200–600 字节，200条约 40KB–120KB，体积轻量。
//   importSnapshot 含完整持仓 h 字段，单条体积偏大；
//   如体积成为问题，可将 importSnapshot 的 h 字段从日志中裁掉，
//   因持仓已由 saveHoldingsData 单独记录。
//
// 性能说明：
//   每次写日志 = 1次 GET + 1次 PATCH，单次约 1–4 秒，纯异步不阻塞 UI。
//   GitHub API rate limit：认证用户 5000次/小时，当前使用频率无压力。
//
// 停用方式：
//   - 删除 logger.js 文件及 index.html 中对应的 <script> 标签
//   - 删除 store.js 中所有 fmLog(...) 调用行
//   - 删除 interact.js 中 fmLog(...) 调用行
//
// 再次启用：重新加入 logger.js 并在各调用点加回 fmLog(...) 即可。
// ============================================================

function _getClient() {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return "ios";
  if (location.protocol === "file:") return "local";
  return "web";
}

async function fmLog(fn, data) {
  const { id: logId, token } = loadGistConfig();
  if (!logId || !token) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${logId}`, {
      headers: { Authorization: `token ${token}` },
    });
    const gist = await res.json();
    const existing = (() => {
      try {
        return JSON.parse(gist.files?.["fm_log.json"]?.content || "[]");
      } catch {
        return [];
      }
    })();
    const logs = Array.isArray(existing) ? existing : [];
    logs.push({ t: new Date().toISOString(), c: _getClient(), fn, data });
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    await fetch(`https://api.github.com/gists/${logId}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: {
          "fm_log.json": {
            content:
              "[\n" + logs.map((l) => JSON.stringify(l)).join(",\n") + "\n]",
          },
        },
      }),
    });
  } catch (e) {
    console.warn("[fmLog] 日志写入失败", e);
  }
}
