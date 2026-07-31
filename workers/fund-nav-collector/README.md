# fund-nav-collector

Cloudflare Cron Worker，负责在无人打开看板时持续采集官方净值，并写入 `NAV` KV。
前端不直连本 Worker，而是通过 `fund-api.bailuzun.com/v1/nav/today` 读取同一个 KV。

完整数据流和口径见 [系统架构](../../docs/02-系统架构.md)。

## 1. 为什么独立采集

- 官方净值通常在晚间陆续披露，不能依赖浏览器保持在线轮询。
- 东方财富 `FundMNFInfo` 浏览器直连受签名/访问条件限制，但服务端可调用。
- Pages Functions 有大陆可达的自定义域名但没有 Cron；本 Worker 有 Cron，但
  `workers.dev` 不作为前端依赖。因此采用“Worker 写 KV、Pages 网关读 KV”。

## 2. 采集规则

- 北京时间工作日 09:00–24:00，每分钟触发一次。
- 东方财富与腾讯并行请求，逐只只接受 `officialAt/date` 等于北京当天的净值。
- 同一只基金当日两源都有效时，采用先完成的来源；一经写入不覆盖，`src` 和 `at` 保持不变。
- 当前基金全部到齐后立即早退，不再请求上游。
- 节假日没有专用日历，Cron 会空跑；不得凭连续空结果擅自判定休市。
- `complete` 不落盘，每次按当前基金列表重算，保证当晚新增基金仍会继续采集。
- 基金删除后，旧记录在早退判断前清理，随后重新计算 `first`。

上游：

| 来源 | 接口 | 读取内容 |
|---|---|---|
| 东方财富 | `FundMNFInfo` | 批量官方单位净值、日期、名称 |
| 腾讯 | `qt.gtimg.cn/q=jj{code}` | `jj` 十字段结构的官方块 `[5]`、`[7]`、`[8]` |

腾讯 `[2]`–`[4]` 是已失效的历史盘中估值字段，本采集器永远不读取。两源自带涨跌幅精度
不同，KV 原样保留；对外百分比由相邻两次官方净值重新派生。

## 3. 基金列表

正常路径读取 Gist `fm_config.json` 的 `f` 字段，自动跟随看板增删基金：

1. 先用 `NAV/codes` 的 5 分钟缓存；
2. 缓存过期后读取 Gist；
3. Gist 临时失败时使用旧缓存，并标记 `stale-cache`；
4. 没有任何缓存时才使用 `wrangler.toml` 的 `FALLBACK_CODES`。

`codesSource` 和 `codesError` 会进入采集结果及日志，不能把 Gist 故障静默伪装成正常采集。

## 4. KV 契约

| Key | 含义 |
|---|---|
| `nav:{YYYY-MM-DD}` | 该北京日期采到的逐只官方净值，保留 7 天 |
| `nav:today` | 最新已公布净值日的完整记录，不等同于北京日历当天 |
| `nav:previous` | `nav:today` 之前的最近官方净值日 |
| `nav:latest` | 旧读端兼容指针；不作为收益基准 |
| `codes` | 从 Gist 读取的基金代码缓存 |

收益基准只认 `nav:today + nav:previous` 窗口。`nav:latest` 用于兼容和迁移，禁止用快照
百分比反推上一净值。

写入条件：

- 当日有新基金净值或清理了已删除基金时，写 `nav:{date}`。
- 有有效记录时维护 `nav:today`、`nav:previous` 和兼容指针 `nav:latest`。
- `updatedAt` 是整条记录最后写盘时间；逐只 `at` 是该基金实际抢到时间，两者不可混用。
- Cron 的异步链必须保留错误日志；静默失败会让停采无法被发现。

## 5. 部署配置

项目已使用 Wrangler CLI 部署，`wrangler.toml` 是明文变量、KV 和 Cron 的声明源：

```bash
cd workers/fund-nav-collector
npx wrangler deploy
```

绑定和变量：

| 名称 | 类型 | 用途 |
|---|---|---|
| `NAV` | KV | 写入官方净值；必须与 `fund-market-api` 绑定同一 namespace |
| `FALLBACK_CODES` | 明文变量 | Gist 和代码缓存都不可用时兜底 |
| `ALLOW_ORIGIN` | 明文变量 | 调试端点 CORS |
| `GIST_ID` | Secret | 配置 Gist ID |
| `GIST_TOKEN` | Secret | 读取私有 Gist |
| `COLLECT_TOKEN` | Secret | 手动触发采集 |

Secret 不写入仓库：

```bash
npx wrangler secret put GIST_ID
npx wrangler secret put GIST_TOKEN
npx wrangler secret put COLLECT_TOKEN
```

Cron 声明：

```toml
[triggers]
crons = ["* 1-16 * * 1-5"]
```

UTC 01:00–16:00 对应北京时间 09:00–24:00。

## 6. 调试端点

| 端点 | 部署位置 | 用途 |
|---|---|---|
| `GET /v1/nav/today` | 本 Worker | 调试 KV 窗口；正式前端不使用 |
| `GET /v1/collect?token=...` | 本 Worker | 清除代码缓存并立即采集一跳 |
| `GET /v1/nav/today` | `fund-market-api` | 正式前端读端点 |

手动采集会把错误直接放进响应体，便于检查 Gist 权限、基金列表来源和两路上游状态。

## 7. 验证

```bash
node --test workers/fund-nav-collector/test/collector.test.mjs
```

当前测试共 9 项，覆盖真实写盘路径、早退、基金增删、双源抢先、官方净值窗口和错误可见性。
改动 `collect()`、KV 指针或端点口径后必须运行。
