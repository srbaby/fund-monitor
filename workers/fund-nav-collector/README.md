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

- 北京时间周一至周五 09:00–24:00，每分钟触发一次；Cloudflare Workers 的星期编号为 `1=周日`、`2=周一`，因此使用 `2-6` 表示周一至周五。
- 缺行的基金先补种：调东财历史净值接口取最近两个净值日，新基金加入后当跳即有数，不必等当晚披露。
- 东方财富与腾讯并行请求，逐只只接受 `officialAt/date` 等于北京当天的净值。
- 同一只基金当日两源都有效时，采用先完成的来源；一经写入不覆盖，`src`、`at`、`gotAt` 保持不变。
- 补种条目 `src` 为 `history`，对外时间戳挂在净值自己的日期上，不参与读端点的 `firstCount` 抢先统计。
- 补种只对缺行的基金各问一次，成功后打 `seeded` 标记；当前基金全部到齐后立即早退，不再请求上游。
- 节假日没有专用日历，Cron 会空跑；不得凭连续空结果擅自判定休市。
- `complete` 不落盘，每次按当前基金列表重算，保证当晚新增基金仍会继续采集。
- 基金删除后，旧记录在早退判断前清理，随后重新计算 `first`。

上游：

| 来源 | 接口 | 读取内容 |
|---|---|---|
| 东方财富 | `FundMNFInfo` | 批量官方单位净值、日期、名称 |
| 东方财富 | `FundMNHisNetList` | 单只最近两期净值，仅在补种缺行时调用 |
| 腾讯 | `qt.gtimg.cn/q=jj{code}` | `jj` 十字段结构的官方块 `[5]`、`[7]`、`[8]` |

腾讯 `[2]`–`[4]` 是已失效的历史盘中估值字段，本采集器永远不读取。两源自带涨跌幅精度
不同，KV 原样保留；对外百分比由相邻两次官方净值重新派生。

**看板长期显示「东财 N」是正常的，不是腾讯坏了。** 2026-08-05 用采集器同一套解析实测：
腾讯八只全部解析成功、净值与日期和东财完全一致，只是官方块更新得晚——2026-08-04 那晚
采集器从 19:00 一直问到 21:07 才由东财补齐最后一只，腾讯在这两个多小时里一次都没抢先。
所以腾讯是**慢**不是**空**，双源的价值在东财失效那天，不在平时均分。真正该查的是标签变了：
翻成「腾讯 N」说明主源出问题、备源顶上了；数字掉到基金总数以下说明有基金整晚没采到。

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
| `nav:funds` | **唯一数据源**：每只基金一个条目，条目内最多两行净值 |
| `codes` | 从 Gist 读取的基金代码缓存 |
| `nav:{date}` / `nav:today` / `nav:previous` / `nav:latest` | 旧模型遗留，采集器不再写；网关仅在 `nav:funds` 尚未写出时兜底读 |

```jsonc
funds["007044"] = {
  name: "博道沪深300增强A",
  seeded: true,              // 已向历史净值接口问过一次，别每跳重问
  rows: [                    // [最新净值日, 前一净值日]，最多两行
    { date: "2026-08-05", nav: 1.8556, pct: 1.58,
      src: "eastmoney",      // eastmoney / tencent = 实时抢到；history = 补种
      at: "2026-08-05 21:04:55",     // 日期部分恒等于 date，看板据它判净值日
      gotAt: "2026-08-05 21:04:55" } // 真实抓取时刻，只作诊断
  ]
}
```

**行的身份是净值日期（北京时间），不是抓取时刻。** 滚不滚动、算不算今天、收益拿谁当
基准，全部只看 `date`。补种回来的旧净值 `at` 必须挂在它自己的日期上——写成抓取当天，
看板会把昨日净值当成今天刚出的官方净值，当天收益直接算错。

写入规则：

- 日期更晚 → 前插并截到两行（`-2day` 出局，`-1day` 必然保留，它是收益基准）。
- 日期已存在 → 原样不动（先到先得，`nav/src/at/gotAt` 不可变）。
- 日期更早且第二行空缺 → 填第二行（补种走这条）。
- 基金从看板删除 → 整个条目删除，不留残留。
- 有新增、有补种、有改名或有清理才落盘；纯早退跳不写，省 KV 免费写配额。
- `updatedAt` 是整份数据最后写盘时间，与逐行 `gotAt` 语义不同，不可混用。
- Cron 的异步链必须保留错误日志；静默失败会让停采无法被发现。

补种：基金刚加进看板时一行都没有，而两个实时源只给“最新一期”，单靠它们要等当晚披露
才第一次有数。故对缺行的基金调东财 `FundMNHisNetList` 取最近两期；该接口不返回基金名，
名字另从批量接口顺一次，否则看板会显示成“基金 007044”。

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
crons = ["* 1-16 * * 2-6"]
```

Cloudflare Workers 的星期编号为 `1=周日`、`2=周一` 至 `6=周五`，因此 `2-6` 表示周一至周五。

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

当前测试共 15 项，覆盖真实写盘路径、早退、基金增删、双源抢先、新基金补种、两行滚动窗口和错误可见性。
改动 `collect()`、`nav:funds` 结构或端点口径后必须运行。
