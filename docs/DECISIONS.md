# 决策日志（DECISIONS）

> **追加式，只增不改。** 新条目加在最前面。已有条目**永不删除、永不改写**——
> 决策被推翻时，写一条新的并在新条目里注明"取代 D-xxx"，同时把旧条目状态改为 `已被取代`（仅改这一行）。
>
> **什么时候必须写**：删除、替换、绕过任何既有机制之前。**先写这里，再动代码。**
>
> **为什么存在**：代码能表达"做了什么"，表达不了"为什么这么做、为什么当初否决了另一种做法"。
> 后者一旦只存在于某次对话里，对话过期就永久丢失，下一个人（或下一个 AI）会理直气壮地拆掉它。
> 本项目已经因此出过一次事故，见 D-001。

## 索引

| 编号 | 日期 | 决策 | 状态 |
| --- | --- | --- | --- |
| [D-014](#d-014) | 2026-07-20 | 估算数据持久化（localStorage + Gist 三层回退） | 生效中 |
| [D-013](#d-013) | 2026-07-20 | 数据源双模：`DATA_MODE` 切换网关 / 腾讯直连 | 生效中 |
| [D-012](#d-012) | 2026-07-20 | 盘后跳过估算请求，节省 4s+ 刷新等待 | 生效中（直连模式除外，见 D-014） |
| [D-011](#d-011) | 2026-07-20 | 网关 in-flight 请求去重 | 生效中 |
| [D-010](#d-010) | 2026-07-20 | "已更新"徽标与净值选取判据拆开 | 生效中 |
| [D-009](#d-009) | 2026-07-19 | 上游请求一律带缓存击穿参数 | 生效中 |
| [D-008](#d-008) | 2026-07-16 | 前端一律不直连第三方行情，全部收口到网关 | 已被取代（由 D-013） |
| [D-007](#d-007) | 2026-07-16 | 不再用 gitignore 藏"本地专属"文件 | 生效中 |
| [D-006](#d-006) | 2026-07-19 | 拆除 PE 双路验证层，保留 2.0 展示 | 生效中 |
| [D-005](#d-005) | 2026-06 | 配置同步用版本号"谁新谁赢 + 反向自愈" | 生效中 |
| [D-004](#d-004) | 早于 2026-06 | 增权预案 `totalFriction` 恒为 0 | 生效中 |
| [D-003](#d-003) | 早于 2026-06 | 增权份额除以兴全净值而非买入标的净值 | 生效中 |
| [D-002](#d-002) | 2026-07-16 | 网关"整组成败"，禁止主备混用 | 生效中（边界见 D-001） |
| [D-001](#d-001) | 2026-06-19 / 2026-07-20 | 行情数据 last-known-good 保护，落在网关侧 | 生效中 |

---

<a id="d-013"></a>
## D-013 · 数据源双模：`DATA_MODE` 切换网关 / 腾讯直连

**状态**：生效中
**日期**：2026-07-20
**取代**：[D-008](#d-008)（"前端一律不直连第三方行情"）—— 直连模式即前端直连腾讯，故 D-008 不再作为全局红线，降级为"网关模式下的约束"。

### 背景

原架构（D-008）前端只走 Cloudflare 网关 `API_BASE`，主备切换 + KV last-known-good 全在网关侧。
迁移后实测发现：**Cloudflare Worker 出站 IP 在境外，访问国内数据源天然慢 4–8 倍**
（东方官方 1.3s vs 直连 0.28s；腾讯行情 0.6s vs 直连 0.15s）。
而天天基金 `fundgz` 老接口已 301→404 死亡，东方 `FundMNFInfo` 前端直连被 `ErrCode:61136` 拦截，
**唯一还能前端直连的是腾讯 `qt.gtimg.cn`**（带 `Access-Control-Allow-Origin: *`，GBK 编码）。

用户怀念早期前端直抓的丝滑感，且明确"不强制主备"，故选定路线 A：前端直连腾讯。
同时为保留网关作为兜底，不删除 `workers/` 代码，而是用**一个开关**让两条链路并存。

### 决策

1. **`config.js` 加 `DATA_MODE` 常量**（`"gateway"` | `"direct"`），当前默认 `"gateway"`。
   改这一个常量 + 推一次即全站切换，不动任何业务代码。
2. **`DATA_MODE === "direct"` 时**：`js/data.js` 走 `_fetchTencentFunds` / `_fetchIndexGroupTencent`，
   浏览器直连 `TX_BASE`，字段产物与网关**逐字段对齐**，保证 `fetchSingleFund` / `setIndices` / `setQQIndex` 无感切换。
3. **`DATA_MODE === "gateway"` 时**：完全沿用既有网关路径，行为不变。
4. **`workers/` 网关代码原样保留**，不删。直连模式前端不请求它，仅作备选。

### 理由

- **为什么用运行时开关而非两条 Git 分支**：线上静态站只认一条分支，切分支要重新合并部署，
  且两套 `data.js` 长期并行必冲突。一个常量 + 一份代码同时装两套数据源，切换成本最低、回滚最稳。
- **为什么只用腾讯单源**：fundgz 已死、东方前端被 61136 拦，仅腾讯可直连。单源 = 无主备，
  用户已确认接受（直连模式无 last-known-good 兜底，断网即无数据；如需可后续加 localStorage 缓存）。
- **为什么字段要对齐网关**：渲染/计算层只认 `estimateNav/officialNav/f2/f3/...` 这套字段名，
  直连产物保持同构，下游零改动。

### 代价

- **代码量增加**：`js/data.js` 新增 TX 直连段（约 130 行），临时突破红线 #8"改后代码量不许增加"。
  该红线就本特性**临时放行**——双链路是用户明确要的功能，无法在不增代码的前提下实现。
- **直连模式无 LKG 兜底**：网关的 KV last-known-good 在直连模式失效；断网/腾讯故障 = 数据空白。
- **GBK 解码硬依赖**：必须用 `TextDecoder("gbk")`，浏览器原生支持；若某环境不支持该标签会乱码。
- **恒生指数字段差异**：`hkHSI` 布局比 A 股指数短（78 vs 88 字段），其 PE/市值/时间为 0/null，
  与网关同字段位置表现一致；显示与 PE 锚定（锚定沪深300）不受影响。

### 代码位置

- `js/config.js`：`DATA_MODE`、`TX_BASE`、`TX_INDEX_QQ`
- `js/data.js`：`_txNum` / `_txDate` / `_parseTxAssignments` / `_fetchTencentFunds` / `_parseTencentFunds` / `_fetchIndexGroupTencent`；
  `fetchOfficialData` / `fetchEstimates` / `_fetchIndexGroup` 三处按 `DATA_MODE` 分流
- `CLAUDE.md` 红线 #1 改为描述双模；`docs/02-系统架构.md` 2.4 节补双模说明

---

<a id="d-014"></a>
## D-014 · 估算数据持久化：localStorage + Gist 三层回退

**状态**：生效中
**日期**：2026-07-20
**关联**：[D-012](#d-012)（直连模式例外）、[D-013](#d-013)（直连数据源）

### 背景

直连模式（D-013）下，腾讯行情盘后估算字段返回 0 → `_parseTencentFunds` 的 `estimateNav > 0` 过滤
→ 估值列全部变成 `"--"`。D-012 为了网关性能加了盘后跳过估算的优化，但在直连模式不需要
（与官方链共享 in-flight 去重，无额外网络代价），反而造成了"收盘=空白"的体验问题。

更严重的是：即使当时显示了，换设备或清缓存后也全部丢失。in-memory 变量不能跨设备持久化。

### 决策

估算数据做三层回退持久化：

```
fresh（腾讯直连有数据 → 返回）
  ↓ 空
localStorage（本地缓存 → 返回，标记来源 "cached"）
  ↓ 空
Gist fm_est.json（跨设备兜底 → 返回 + 同步到 localStorage，标记来源 "gist"）
  ↓ 空
unavailable（真正没数据）
```

### 理由

- **localStorage**：即时、无网络、解决同设备刷新/关机后恢复。当日数据 TTL 18h。
- **Gist**：复用现有 Gist 同步基础设施（`_cloudReadFile`/`_cloudWriteFile`），新文件 `fm_est.json`。
  收盘后推送一次（fire-and-forget，每天一次），解决换设备首次打开的问题。
- **代理模式不影响**：`DATA_MODE="gateway"` 时 `needEstimate` 策略原样保留。

### 代价

- `js/data.js` 新增约 50 行（三个缓存函数 + Gist 推送）。
- 新增 `GIST_FILE_EST = "fm_est.json"` 到 `config.js`，一个 localStorage key `STORE_EST_CACHE`。
- `interact.js` 的 `needEstimate` 加了一条 DATA_MODE 分支判断。

### 代码位置

- `js/config.js`：`GIST_FILE_EST`、`STORE_EST_CACHE`
- `js/data.js`：`_lsSaveEstCache` / `_lsLoadEstCache`、`_maybePushEstToGist`、`cloudReadEst` / `cloudUpdateEst`；
  `fetchEstimates` 直连模式改为 async，内联三层回退
- `js/interact.js`：`needEstimate` 在 `DATA_MODE="direct"` 时为 `true`（始终调 `fetchEstimates` 走缓存）

---

<a id="d-001"></a>
## D-001 · 行情数据 last-known-good 保护，落在网关侧

**状态**：生效中
**日期**：2026-06-19 确立（前端版）→ 2026-07-20 被拆除（事故）→ 2026-07-20 重建于网关侧

### 背景（含事故经过）

2026-06-19 的 `9a41e0e`（298 行，横跨 data/store/ui）确立了一条原则：
**行情数据拿不到新的，就继续用上次的好数据，并明确标记为陈旧**。当时的实现是
`setIndicesUnavailable()` → 回退 localStorage 快照 → `mode:"stale"` → UI 上 `is-stale` 灰化。

这条原则**从未写进任何文档**，只活在指数那条代码路径里。

2026-07-20 做网关迁移（`b76b928`）时，AI 读到文档里 2.6 节"任一组请求失败即整组降级为不可用"
和"`unavailable` 时官方字段保持空值"，照着执行，于是：

- `data.js` 官方组失败时 `delete officialBatchCache[cacheKey]`——**主动删掉**上次的好数据。
  旧实现 `if (result) offCache[code] = ...` 是失败**不写**缓存，下次 TTL 内继续返回上次好数据。
- 失败波及范围从"每只独立"（`funds.map(fetchSingleFund)`）变成"一只解不出、全组归零"
  （网关 `records.every(Boolean) ? records : null`）。
- `setLastResults(res)` 整体覆盖，没有指数那样的 stale 回退。

**用户看到的现象**：收盘后天天基金/腾讯都停供盘中估算，整组 unavailable，
一次 60 秒刷新就把一整天的估算数据冲成 `--`。

### 决策

1. **行情数据禁止因单次失败清空。** 拿不到新数据 → 返回上次好数据 + 标记陈旧。这是硬红线。
2. **保护落在网关侧，不落在浏览器。** 网关持久化最后一份完整好数据（KV），
   失败时以 `status:"stale"` 返回。前端只负责把陈旧态显示出来。
3. 前端原有的指数 localStorage 快照保留，作为"网关整个够不着"时的第二道防线。

### 理由

- **为什么不能只在前端**：localStorage 是**单机**的。换一台电脑、或手机冷启动，
  晚上打开看板照样是空白——保护等于没有。网关侧存一份，所有设备一次受益。
- **为什么是 KV 而不是 `router.mjs` 里那个 `cache` Map**：那个 Map 活在 isolate 内存里，
  冷启动即丢，跨 colo 不共享，撑不住"晚上打开还能看到当天数据"。
- **为什么必须标记陈旧而不是静默沿用**：看板是盯盘工具，用户据此判断要不要下单。
  把昨天的数当今天的显示，比显示空白更危险。**陈旧可以接受，陈旧且不告知不行。**

### 代价 / 已知副作用

- KV 有写入配额，需对写入节流（不是每次成功都写）。
- 陈旧数据的"保质期"需要定上限，跨交易日的旧数据不应继续冒充。
- `status` 多出 `stale` 一态，网关契约、前端 `_fetchGroup`、测试、README 都要跟着改。

### 代码位置

- 网关：`workers/fund-market-api/src/router.mjs`、`src/lkg.mjs`
- 前端消费：`js/data.js` `_fetchGroup`；前端指数第二道防线：`js/store.js` `setIndicesUnavailable`
- 陈旧态呈现约定：`js/ui-pe.js` `is-stale` / `js/ui.js` `.stale`

### 教训（这条比决策本身更重要）

**原则只写在代码里，等于没写。** 更糟的是，文档里当时还留着一句看起来相反的话（2.6 的"保持空值"），
于是 AI 越是老实照文档执行，越是精准地把保护拆掉。
`docs/` 的归档与本日志机制就是为堵这个洞而建，见 `CLAUDE.md` 第三节。

---

<a id="d-002"></a>
## D-002 · 网关"整组成败"，禁止主备混用

**状态**：生效中（边界已由 D-001 收窄）
**日期**：2026-07-16

**决策**：一组请求要么整组来自主线路、要么整组来自备用线路，绝不逐只混用；凑不齐则该组不可用。

**理由**：主备两源的口径、时延、字段含义都不同。半组主源半组备源，用户看到的是一张
内部不自洽的表——两只基金的涨跌幅根本不可比。宁可整组不可用，也不给自相矛盾的数据。

**⚠️ 这条不等于"许可清空看板"。** "整组不可用"说的是**这一次请求的结果不可用**，
不是"把已有数据删掉"。不可用时应走 D-001 的陈旧回退。二者不冲突：
**D-002 管的是"不许混"，D-001 管的是"不许丢"。** 2026-07-20 的事故正是把前者误读成了后者的授权。

**代码位置**：`workers/fund-market-api/src/router.mjs` `selectGroup`

---

<a id="d-003"></a>
## D-003 · 增权份额除以兴全净值而非买入标的净值

**状态**：生效中

**决策**：`calcBuyPlanDraft` 里 `sharesA500C` / `sharesZZ500C` 除以兴全净值 `xqNav`，不是 `a500cNav`。

**理由**：业务关心的是"为各买入桶需要**卖出多少兴全份额**"，不是"买到手多少份额"。
用户的实际操作是先赎兴全、再申购，手里要的是赎回份额数。

**⚠️ 看起来像单位错误，是有意设计，勿"修正"。**

**代码位置**：`js/engine.js` `calcBuyPlanDraft`

---

<a id="d-004"></a>
## D-004 · 增权预案 `totalFriction` 恒为 0

**状态**：生效中

**决策**：增权路径的摩擦成本恒为 0，不参与计算。

**理由**：增权的卖出端是纯债（系数 0）、买入端是 C 类（系数 1），两端都零摩擦。
`SYS_CONFIG.FEE` 只对混合型（系数 `∉ {0,1}`）计提。

**⚠️ 看起来像忘了实现，是有意设计。**

**代码位置**：`js/engine.js` `calcBuyPlanDraft`

---

<a id="d-005"></a>
## D-005 · 配置同步用版本号"谁新谁赢 + 反向自愈"

**状态**：生效中
**日期**：2026-06

**决策**：低频配置（持仓/基金列表/降权预案/优先卖出）带版本号 `v`；
本地改动即自增，拉取时只采纳 `remoteV > localV`；若本地反而更新则延迟推回云端。
PE 定锚**不**版本化。

**理由**：配置录错或被旧端覆盖损失大，PE 丢了肉眼一秒能重录。
两类数据的更新频率与重要性不同，用一套机制会让高频的 PE 白白背上复杂度。
反向自愈是为了兜住"上次推送被系统杀掉"的情况，保证任何一次有效编辑都不会被回退。

**代价**：每个配置写入封装都必须自己调 `bumpConfigVer()`。
`saveSellPlan` 曾因"唯一调用点紧跟在 `saveHoldingsData` 之后"而漏掉，属随时会响的哑雷，2026-07-19 已补。

**代码位置**：`js/store.js` `bumpConfigVer` / `importSnapshot`；`js/interact.js` `syncCloud`

---

<a id="d-006"></a>
## D-006 · 拆除 PE 双路验证层，保留 2.0 展示

**状态**：生效中
**日期**：2026-07-19

**决策**：删除 16:00 快照、夜间与官方配对、`validation-log.json`、`RUN_ACTION=snapshot` 分支
及 Worker 的 `snapshot` 路由。**2.0 点位路保留在看板上。**

**理由**：验证层唯一目的是回答"1.0 和 2.0 哪个准"。15 个可比交易日（06-25～07-17）结论已足够确定：

| | 1.0 总市值路 | 2.0 点位路 |
| --- | --- | --- |
| 平均绝对误差 | 0.41pp | 1.31pp |
| 最大绝对误差 | 0.86pp | 3.69pp |
| 逐日更接近官方 | 14 / 15 | 1 / 15 |

保留 2.0 是因为成分调整日总市值会跳变，那种日子点位路反而是有效参照。

**代价**：Master-Scheduler 侧 16:00 那一跳需同步取消。若日后要重建验证，从 git 历史取回，
不要在引擎里留半套。

---

<a id="d-007"></a>
## D-007 · 不再用 gitignore 藏"本地专属"文件

**状态**：生效中
**日期**：2026-07-16

**决策**：`CLAUDE.md` 与 Worker 触发器源码移出 `.gitignore`，纳入公开仓库正式追踪。

**理由**：gitignore 的文件**永远不会被 clone/pull/checkout 带回来**，只活在某一台机器的磁盘上。
本仓库已实际发生过丢失：本地工作目录建于 2026-07-09 的一次 clone，晚于两文件被移出追踪的时间点，
clone 时它们已不在可追踪历史里，靠 `git log --all -- <path>` 找 Delete commit 的父提交手工找回。
反复"考古恢复"的代价大于公开这两份文件的代价。已核对二者均无明文密钥。

**推论**：以后任何"本地专属、不想公开"的文件，优先选"仓库外单独备份"，而不是单纯 gitignore。

---

<a id="d-008"></a>
## D-008 · 前端一律不直连第三方行情，全部收口到网关

**状态**：生效中
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

<a id="d-010"></a>
## D-010 · "已更新"徽标与净值选取判据拆开

**状态**：生效中
**日期**：2026-07-20

### 背景

`calcTodayProfit` 中 `isOfficialUpdated` 身兼两职：
1. 决定 nav/pct 取哪边（官方还是估算）
2. 驱动 `allUpdated` → 顶部"已更新"徽标

2026-07-20 晚间盘中估算整组不可用（`status: "unavailable"`），`estD` 为空，
`!estD` 短路使整条判据退化为 `!!f.offVal`——任何有官方净值的基金都被判为"已更新"，
与 `offD` 是不是今天完全脱钩。用户看到部分基金官方还是昨天的，徽标却亮着。

### 决策

**净值选取口径（`isOfficialUpdated`）保持不变**：`mktState === "WEEKEND" || "BEFORE_PRE" || !!(offVal && (!estD || offD >= estD))`。
三处（`getNavByCode`、`openHoldingDrawer` 的 profitMap、`calcTodayProfit` 的 nav/pct 选取）维持一致。

**新增"徽标口径"（`isFundUpdated`）**，仅用于驱动 `allUpdated`：
```javascript
const isOffToday = offD === todayStr;
const isEstToday = estD === todayStr;
const isFundUpdated = isOffToday || isEstToday;
```

**两者分工**：`isOfficialUpdated` 管数值（放宽 fallback，避免整只跳过导致今日涨跌归零）；
`isFundUpdated` 管状态（严格，必须有今天的数据才算"已更新"）。

### 理由

- **数值可以放宽、状态必须严格**：估算空时用昨天官方凑出 0 涨跌是可接受的 fallback；
  用昨天数据显示"已更新"会误导用户，比显示空白更危险。
- **估算整组不可用是常态（盘后）**，不能因此把"放宽的 fallback"误用到状态判定上。

### 代码位置

`js/engine.js` `calcTodayProfit`

### 教训

**判定状态徽标 vs. 判定数值选取，是两件不同的事。** 未来加任何带"状态标签"的 UI 元素，
先问自己："这条展示信息的前提判据，和数值选取的判据，是同一道题吗？"

---

<a id="d-011"></a>
## D-011 · 网关 in-flight 请求去重

**状态**：生效中
**日期**：2026-07-20

### 背景

`router.mjs` 的 `cache` Map 只缓存"已完成结果"，不缓存"进行中的 Promise"。
同一 cacheKey 在 TTL 窗口内并发到达时，所有请求都各自调起 `selectGroup` → 打上游，
直到第一个完成写回缓存。触发条件窄（TTL 8s~60s 窗口内并发重叠），但一旦触发就是
无意义的重复上游调用。

### 决策

加 `inflight` Map，存储进行中的 Promise。请求到达时：
1. 有 inflight → 搭车等同一个 Promise
2. 有已完成缓存 → 秒回
3. 都没有 → 发起一趟，写进 inflight，`finally` 中释放

**`force` 参数跳过去重**（诊断用）。

### 理由

- 对单机自用影响极小，但对 PWA 公用部署或爬虫误触有防护价值。
- 改动 <15 行，风险低。
- Cloudflare Pages Functions 是 per-isolate，跨 isolate 不共享 inflight，
  同 isolate 内的幂等已是当前能达到的最大保护。

### 代码位置

`workers/fund-market-api/src/router.mjs`

---

<a id="d-012"></a>
## D-012 · 盘后跳过估算请求，节省 4s+ 刷新等待

**状态**：生效中
**日期**：2026-07-20

### 背景

刷新时 `Promise.all([fetchOfficialData, fetchEstimates])` 串等两者。盘后（POST_MARKET）：
- 官方：1.3s 秒回（一次批量 API）
- 估算：4.3s 才回（`fundgz.1234567.com.cn` 对 CF Worker IP 限速 → 6 并发拖秒数 →
  超时回退备份 → 备份返回全 0 → 解析器拒掉 → `unavailable`）

盘后这 4 秒无商业意义——估算来源只在天盘中有波动，盘后必然 unavailable。

### 决策

在 `refreshData` 中加市场状态判断：只在 `PRE_MARKET / TRADING / MID_BREAK` 时段调 `fetchEstimates`，
其余用 `{ source: "unavailable", data: new Map() }` 秒回。

### 理由

- `POST_MARKET / BEFORE_PRE / WEEKEND` 时估算始终 unavailable，不值得调网关。
- 盘中刷新不受影响，继续走完整请求链路。
- 对 D-006（拆除 PE 双路验证）形成呼应：盘后数据稳定后，不需要再反复拉"不可能有的"盘中估算。

### 代码位置

`js/interact.js` `refreshData`

---

<a id="d-009"></a>
## D-009 · 上游请求一律带缓存击穿参数

**状态**：生效中
**日期**：2026-07-19

**决策**：`upstreams.mjs` 的 `fetchWithTimeout` 给每次上游请求 URL 追加时间戳参数，并传 `cf.cacheTtl:0`。

**理由**：`fundgz` 等上游前面挂着第三方 CDN，曾按出口 IP 把响应缓存住 **40+ 分钟**不更新，
导致看板显示长时间不变的陈旧估算。此举不影响 `router.mjs` 自己那层 15 秒节流缓存
（那层是上游限流器，不是缓存）。
