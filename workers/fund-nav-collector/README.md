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

Worker → **Settings → Trigger Events → Add → Cron Trigger**，加**两条**：

```
* 11-14 * * 1-5
0 15 * * 1-5
```

UTC 时间。合起来 = 北京 19:00–23:00，周一至周五，每分钟一跳。

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
- **`funds[code]` 一旦写入永不覆盖**，`src` 与 `at` 从此不可变——这是"先到先得"的全部实现。
- **只接受 `officialAt === 今日`**。前端原来那个 bug 的根因正是没判这条：东财在净值未披露时
  返回昨日数据且 `size > 0`，于是整组被采纳，腾讯备源一次都轮不到。
- **基金列表读 Gist `fm_config.json` 的 `f`**，跟随看板增删。读失败不清空已缓存列表——
  宁可用旧列表也不要因一次抖动漏采。
- **两源涨跌幅精度不同**（东财 2 位 / 腾讯 4 位），前端已在 `data.js` 的 `_pct2` 统一到 2 位，
  采集器这边**原样存**不做规整——KV 里留原始精度，将来换显示口径不必重采。
