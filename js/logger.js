// ============================================================
// logger.js - 临时云端日志模块
//
// 用途：记录所有本地写入和云端推送操作，供排查数据丢失问题。
//
// 接入方式：
//   1. index.html 在 config.js 之后、store.js 之前加载本文件
//   2. store.js 每个 save*/clear* 函数末尾调用 fmLog(fn, data)
//   3. interact.js doPush 里调用 fmLog("syncCloud_push", payload)
//   4. interact.js openCloudConfig 支持第三段 LogGistID
//
// 日志格式（fm_log.json 内容为数组，最多100条）：
//   { t: ISO时间戳, fn: 触发函数名, data: 写入内容快照 }
//
// 排查完成后的处理：
//   - 删除 logger.js 文件
//   - 删除 index.html 中本文件的 <script> 标签
//   - 删除 store.js 中所有 fmLog(...) 调用行
//   - 删除 interact.js 中 fmLog(...) 调用行
//   - interact.js openCloudConfig 格式说明和 saveLogGistId 调用可保留（无副作用）
//   - config.js STORE_LOG_GIST_ID 常量可保留（无副作用）
//
// 再次启用：重新加入 logger.js 并在各调用点加回 fmLog(...) 即可
// ============================================================

const STORE_LOG_GIST_ID = "fm_log_gist_id";

function loadLogGistId() {
  return localStorage.getItem(STORE_LOG_GIST_ID) || "";
}
function saveLogGistId(id) {
  if (id) localStorage.setItem(STORE_LOG_GIST_ID, id);
  else localStorage.removeItem(STORE_LOG_GIST_ID);
}

async function fmLog(fn, data) {
  const logId = loadLogGistId();
  const { token } = loadGistConfig();
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
    logs.push({ t: new Date().toISOString(), fn, data });
    if (logs.length > 100) logs.splice(0, logs.length - 100);
    await fetch(`https://api.github.com/gists/${logId}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: { "fm_log.json": { content: JSON.stringify(logs, null, 2) } },
      }),
    });
  } catch (e) {
    console.warn("[fmLog] 日志写入失败", e);
  }
}
