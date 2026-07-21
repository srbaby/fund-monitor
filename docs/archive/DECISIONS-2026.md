# 决策日志归档 · 2026

> 本文件是 `docs/DECISIONS.md` 的**考古层**，存放状态为 `已被取代 / 已失效` 的条目。
> 迁移不是删除（CLAUDE.md §3.1）：原索引表保留该行并指向这里，正文完好无损。
> 日常阅读不必看这里，只在追查"当年为什么那样做"时回溯。

---

<a id="d-008"></a>
## D-008 · 前端一律不直连第三方行情，全部收口到网关

**状态**：已被取代（由 [D-013](../DECISIONS.md#d-013)）
**日期**：2026-07-16

**决策**：浏览器只请求 `API_BASE` 下三个端点，JSONP 机制整体删除。
主备选择、整组校验、GBK 解码全在 Cloudflare Pages Functions 内完成。

**理由**：JSONP 无法处理错误、无法设超时语义、无法做主备决策；
第三方域名可用性不可控，且把主备逻辑摊在前端会让 `js/` 十文件上限雪上加霜。

**附带约束**：`bailuzun.com` 权威 DNS 在腾讯、不是 Cloudflare zone，拿不到 WAF/速率限制，
因此 `/v1/*` 只在 `fund-api.bailuzun.com` 匿名应答，`*.pages.dev` 与预览域名一律 403
（带 `X-Diagnostic-Token` 除外，留一条证书/DNS 故障时的调试退路）。

**代码位置**：`workers/fund-market-api/src/router.mjs` `hostAllowed`

---

