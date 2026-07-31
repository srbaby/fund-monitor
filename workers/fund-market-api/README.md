# fund-market-api

Cloudflare Pages Functions 网关。它承担两件事：

1. 在前端选择 `DATA_MODE = "gateway"` 时提供盘中指数/ETF 行情；
2. 始终向前端提供官方净值 KV 的只读端点。

默认 `direct` 模式下，盘中行情由浏览器直连腾讯，本项目的 `/v1/indices` 不在主路径上；但
`/v1/nav/today` 无论哪种模式都在主路径上。完整数据流见
[系统架构](../../docs/02-系统架构.md)。

## 1. 接口

| 端点 | 当前用途 | 数据来源 | 完整性规则 |
|---|---|---|---|
| `GET /v1/indices` | `gateway` 模式盘中行情 | 腾讯主源；东方财富三镜像备源 | 主源整组完整，否则整组切备源；不拼接半组 |
| `GET /v1/nav/today` | 所有模式的官方净值窗口 | 只读 `NAV` KV，不请求外部上游 | 返回当前/前一官方净值日及逐只净值 |
| `GET /v1/funds/official?codes=...` | 兼容、诊断端点；前端不使用 | 东财批量主源；东财历史逐只备源 | 整组主备切换 |
| `GET /v1/funds/estimate` | 已移除 | 无 | 固定 `404 not_found`，不得恢复为业务依赖 |

`/v1/indices` 的主源覆盖 6 个可见核心指数和 4 个隐藏代理因子。备源必须保证 6 个核心指数
完整；隐藏因子缺失时，前端代理模型按 `fallbackLegs` 整套降级。具体代码和用途以
[`js/config.js`](../../js/config.js) 的 `INDICES`、`BENCHMARK_PROXY` 为准。

`/v1/indices` 和 `/v1/funds/official` 的 `status`：

| `status` | `ok` | 含义 |
|---|---:|---|
| `primary` / `backup` | `true` | 本次由完整主源/备源返回 |
| `stale` | `true` | 两路失败，返回 `MARKET_LKG` 的最近完整快照 |
| `unavailable` | `false` | 两路失败且没有可用快照 |

`stale` 会保留原始行情时间，并增加 `servedFrom`、`staleSince`、`staleAgeMs`。前端必须明确
标记陈旧，不能把旧值显示成实时行情。

## 2. 数据源边界

- 腾讯行情：`https://qt.gtimg.cn/q=...`，GBK 解码；提供指数、ETF、债券指数行情，
  沪深300还提供 PE 和总市值。
- 东方财富行情备源：`push2delay`、`push2his`、`push2` 三个镜像；只作为网关降级，
  不提供可用的沪深300 PE/总市值。
- 东方财富官方净值兼容端点：
  `FundMNFInfo` 批量主源、`FundMNHisNetList` 逐只备源。
- `NAV` KV：由 `fund-nav-collector` 写入，本项目只读。它是前端官方净值的正式来源。

基金盘中估算不是本项目输出的数据源。前端使用官方净值基准和行情因子，在本地按
`BENCHMARK_PROXY` 计算方向代理。

## 3. Pages 配置

| 配置 | 值 |
|---|---|
| 项目名 | `fund-market-api` |
| 生产分支 | `main` |
| Root directory | `workers/fund-market-api` |
| Framework preset | `None` |
| Build command | 留空 |
| Build output directory | `public` |
| 自定义域名 | `fund-api.bailuzun.com` |

绑定和密钥：

| 名称 | 类型 | 是否必需 | 用途 |
|---|---|---:|---|
| `MARKET_LKG` | KV | 建议 | 行情主备均失败时返回最近完整快照 |
| `NAV` | KV | 必需 | `/v1/nav/today` 官方净值读端点 |
| `DIAGNOSTIC_TOKEN` | Secret | 必需 | 非自定义域诊断及 `force=` 强制线路 |

`MARKET_LKG` 每个 key 最多 5 分钟写一次，记录 72 小时过期。缺失绑定不会阻断新鲜行情，
但会失去服务端 last-known-good 保护。

## 4. 访问控制

匿名 `/v1/*` 只允许主机 `fund-api.bailuzun.com`。`pages.dev`、预览域和其他 Host 默认返回
`403 host_not_allowed`。携带正确 `X-Diagnostic-Token` 时可用于故障诊断。

诊断参数 `force=primary|backup` 同样要求该请求头；普通用户不能指定上游线路。

允许的浏览器来源固定为 `https://fund.bailuzun.com`。`bailuzun.com` 的权威 DNS 不在
Cloudflare zone，不能依赖 zone 级 WAF 或限流，因此 Host 收口必须保留在函数中。

## 5. 缓存与超时

- 上游单次超时：5 秒。
- 内存成功 TTL：指数 8 秒，官方净值兼容端点 60 秒。
- 同一实例内有 in-flight 去重。
- `MARKET_LKG` 只在主备都失败后读取；新鲜成功路径不会从 KV 返回旧值。
- 指数最坏路径是腾讯 5 秒后，再串行尝试三个东财镜像，可能超过前端 12 秒预算。
  这是保留 `direct` 为默认盘中模式的原因之一。

## 6. 验证

```bash
node --test workers/fund-market-api/test/gateway.test.mjs
```

当前测试共 19 项，覆盖 Host/诊断权限、主备完整切换、LKG、官方净值窗口和已移除估值端点。

线上只读验收可手动运行 GitHub Actions 的 `Market API smoke`。它检查核心指数、隐藏因子
可用情况、官方净值 KV 形状及兼容端点，不再调用已移除的估值接口。
