# fund-nav-collector

官方净值夜间采集器。决策与理由见 [`docs/DECISIONS.md` D-023](../../docs/DECISIONS.md#d-023)。

19:00–23:00 北京每分钟一跳，并行打东财与腾讯，逐只只收**当日**净值，**先到先得**记账
（谁先给的记谁 + 记下何时给的），写 KV。全部到齐即早退。

## 为什么需要它

两条**浏览器侧无解**的约束：

1. 东财 `FundMNFInfo` 前端直连被 `ErrCode:61136` 拦（需 APP 签名，仅服务端调得通。
   2026-07-21 实测复核：direct 模式下 6 只基金 `offSource` 全部落到 tencent）。
   所以浏览器里其实**只有腾讯一路**，没得"抢"。
2. 净值 19:00–23:00 陆续披露，而那个时段通常没人开着看板。轮询必须发生在一直醒着的地方。

## 读写分离——先理解这个，否则部署步骤看不懂

**本 Worker 只写 KV，不对外提供数据。前端读的是网关 `fund-api.bailuzun.com/v1/nav/today`。**

绕这一圈是被两头夹出来的：

| | 能 Cron 吗 | 有大陆可达的域名吗 |
| --- | --- | --- |
| `fund-market-api`（Pages Functions） | ❌ Pages 不支持 Cron Triggers | ✅ `fund-api.bailuzun.com` |
| `fund-nav-collector`（Worker） | ✅ | ❌ 见下 |

Worker 的 Custom Domain 与 Routes **都要求域名在 Cloudflare zone 里**，而 `bailuzun.com`
的权威 DNS 在腾讯 dnspod（`nslookup -type=NS bailuzun.com` → `*.dnspod.net`），不是 CF zone。
剩下的 `*.workers.dev` 在大陆常年不可达，前端读不到就等于白采。

于是：**Worker 写，网关读，同一个 KV 是唯一交接点**。网关那个端点只读 KV，
不触发它的任何上游主备逻辑（`router.mjs` 里 `/v1/nav/today` 在 endpoint 表之前就返回了）。

## 网页端部署（Cloudflare Dashboard，不需要装 wrangler）

> ⚠️ 走 Dashboard 部署时 **`wrangler.toml` 完全不生效**——它是给 CLI 用的，这里保留
> 只作配置留档。KV 绑定、环境变量、Cron 三样都必须在界面上再配一遍。

### 1. 建 KV namespace

左侧 **Storage & Databases → KV → Create a namespace**
名称填 `fund-nav`。（本步产生的 namespace 后面要绑给**两个**项目。）

### 2. 建 Worker 并贴代码

**Workers & Pages → Create → Workers**，名称 `fund-nav-collector`，先 Deploy 一个默认版本。

然后 **Edit code**（或 Quick edit）→ 编辑器里全选删除 → 把本目录 `src/index.js`
的**全部内容**粘进去 → **Deploy**。

### 3. 给 Worker 绑 KV

Worker → **Settings → Bindings → Add → KV namespace**

| 字段 | 值 |
| --- | --- |
| Variable name | `NAV` |
| KV namespace | `fund-nav` |

### 4. 给 Worker 配变量

Worker → **Settings → Variables and Secrets → Add**

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `FALLBACK_CODES` | Text | `003949,160622,110027,011554,007466,022435` |
| `ALLOW_ORIGIN` | Text | `https://fund.bailuzun.com` |
| `GIST_ID` | Secret | 与看板同一个 Gist 的 id |
| `GIST_TOKEN` | Secret | 该 Gist 的访问 token |
| `COLLECT_TOKEN` | Secret | 自己定一个长随机串，手动触发用 |

`GIST_ID` / `GIST_TOKEN` 用来读 `fm_config.json` 取当前基金列表——**配好之后你在看板增删
基金，采集器 5 分钟内自动跟随，不用回来改任何东西**。不配的话就一直用 `FALLBACK_CODES`。

### 5. 配 Cron

Worker → **Settings → Trigger Events → Add → Cron Trigger**，**只加一条**：

```
* 11-15 * * 1-5
```

UTC 时间 11:00–15:59 = 北京 **19:00–23:59**，交易日每分钟一跳。

一条覆盖整个发布窗口。当日净值到齐后每跳命中早退（约 1ms、不打上游、不写 KV），
所以「每分钟 × 5 小时」的实际成本远低于 300 跳。

⚠️ **代价**：采集只在晚间窗口发生。白天新增一只基金，要等当晚 19:00 才有它的净值，
在那之前它的持仓市值算不出来（前端显示 `--`）。这是 2026-07-21 用户裁决接受的取舍——
换来的是触发器配置只有一条、行为一眼看得完。

### 6. 给网关也绑同一个 KV

**Workers & Pages → fund-market-api → Settings → Bindings → Add → KV namespace**

| 字段 | 值 |
| --- | --- |
| Variable name | `NAV` |
| KV namespace | `fund-nav`（与第 1 步同一个） |

### 7. 部署网关新代码

`router.mjs` 里新增了 `/v1/nav/today` 路由。Pages 是 Git 集成的，**把本次改动 push 上去
会自动部署**；或在 **fund-market-api → Deployments → 最新一条 → Retry deployment**。

### 8. 验证

浏览器直接打开：

```
https://fund-api.bailuzun.com/v1/nav/today
```

预期（当晚采集开始前 `funds` 为空是正常的）：

```json
{"ok":true,"date":"2026-07-22","first":"tencent","firstCount":2,"count":6,"funds":{...}}
```

若返回 `{"ok":false,"error":"nav_kv_unbound"}` → 第 6 步的 KV 绑定没生效，或网关还没重新部署。

**部署新版后确认 `nav:latest` 已生成**（官方净值在盘中/周末全靠它）：

```
npx wrangler kv key list --binding NAV        # 应同时看到 nav:{今天} 和 nav:latest
```

当日已 complete 时，新版上线后的**下一跳会在早退分支自动补写 latest**，无需人工干预。
但触发器只在北京 19:00–23:59 跑，**在那个窗口之外部署就不会有下一跳**——
这时手动打一次 `/v1/collect` 立刻生成，别干等。

手动触发一次采集（不必等整分钟），在 Worker 的 workers.dev 地址上打：

```
https://fund-nav-collector.<你的账户子域>.workers.dev/v1/collect?token=<COLLECT_TOKEN>
```

> 这个地址你自己调试时用（挂代理即可），前端不依赖它。

当晚盯实时日志：Worker → **Logs → Begin log stream**。

## 端点

| 端点 | 部署在哪 | 说明 |
| --- | --- | --- |
| `GET /v1/nav/today` | **网关** | 前端读。返回 `first`（今晚最早抢到的源）、`firstCount`、`funds` |
| `GET /v1/collect?token=` | 本 Worker | 手动触发一跳，需 `COLLECT_TOKEN`，仅调试用 |

## 几个不要动错的地方

- **`complete` 绝不落盘**，每跳按当前基金列表现算。存了的话，用户 21:00 加一只基金时
  当晚已 `complete=true`，Worker 会一直早退，新基金永远抓不到。
- **`nav:latest` 是官方净值在盘中/周末/节假日的唯一依靠**。官方净值现在是全站唯一来源
  （D-023 G 节），而那些时段根本没有「今日记录」。读端点先 today 后 latest，
  两个端点（本 Worker 的调试端点与网关的正式端点）**必须逐字同口径**。
- **早退分支也要写 `nav:latest`**：当日 complete 后每跳都从早退直接 return，
  不在那里补写的话 latest 永远出不来，次日盘中官方净值整列空白。写前按 `date` 比对节流，
  每天最多一次——晚间每分钟一跳，无节流会烧掉 KV 免费写配额（1000/天）的四分之一。
- **`funds[code]` 一旦写入永不覆盖**，`src` 与 `at` 从此不可变——这是"先到先得"的全部实现。
- **只接受 `officialAt === 今日`**。前端原来那个 bug 的根因正是没判这条：东财在净值未披露时
  返回昨日数据且 `size > 0`，于是整组被采纳，腾讯备源一次都轮不到。
- **基金列表读 Gist `fm_config.json` 的 `f`**，跟随看板增删。读失败不清空已缓存列表——
  宁可用旧列表也不要因一次抖动漏采。
- **僵尸清理必须在早退判断之前**：基金从看板删除后，KV 当日记录里那条要一并删掉。
  放在早退之后的话，当日一旦 complete 就再没有跳会走到清理，僵尸能赖到记录过期（7 天）。
  不清的代价不只是数据脏——端点的 `count` / `firstCount` 会一直偏大，
  且 `first` 可能锚在一只已经删掉的基金上。
- **`first` 要在清理之后统一重算**：删掉的可能正好是最早抢到的那只，那时赢者必须换人。
  实测：种子 `first=tencent`（003949 于 19:41 最早），删掉 003949 后 `first` 正确变成 `eastmoney`。
- **落盘条件是「有新增或有清理」**（`dirty`）。纯早退跳两者皆无、不写盘，
  免得晚间 241 跳把 KV 免费写配额（1000/天）烧掉四分之一。但 `nav:latest` 例外——
  见上一条，早退跳也要走到那儿。
- **两源涨跌幅精度不同**（东财 2 位 / 腾讯 4 位），前端已在 `data.js` 的 `_pct2` 统一到 2 位，
  采集器这边**原样存**不做规整——KV 里留原始精度，将来换显示口径不必重采。
