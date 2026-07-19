# Jany 基金看板 · 项目规范

> **唯一开发决策来源。** 收到任何需求：先读本文档 → 读相关源文件 → 再动手。不符合本规范的写法直接打回。
>
> 本文档面向 AI 协作者。结构分四篇，递进阅读：
> **第一篇 业务意图**（看板为什么存在、每个功能为什么这么设计）→ **第二篇 系统架构**（怎么搭的）→ **第三篇 实现约束**（碰代码必须遵守）→ **第四篇 开发纪律**（改这套代码的规矩）。
>
> 第一篇所涉的投资方法论要点，已在本文档内自包含记录，无需外部方法论文档即可理解看板。方法论更新时，由用户提供新方法论文件、据此回头修订第一篇。

---

# 第一篇 · 业务意图

> 本篇回答「看板为什么存在、每个功能为什么这么设计」。所有计算、信号、字段的存在都服务于一个目的：**让一套以估值为锚的机械配置纪律，在盘中可被肉眼观察、被准点提醒、被精确算量**。读懂本篇，才能判断某段代码是不是「有意设计」。

## 1.1 看板的核心价值

**一句话**：一个盯盘观察 + 信号提醒 + 操作量计算的辅助决策工具。它不替用户决策，也不下单——它把抽象的估值纪律，变成盘中看得见、催得动、算得准的三件事。

```
观察：实时把市场估值（PE 百分位）摆在眼前，并标出「现在偏离目标多远、朝哪个方向」
提醒：只在估值跨过纪律阈值时给出增权/降权信号，其余时间明确告诉用户「无需动作」
算量：一旦该动，直接倒推出「卖哪只、买哪只、各多少份、磨损多少」的可执行数字
```

**为什么是这三件事**：用户的投资纪律是「以 PE 估值机械触发、不预测、不主观择时」。这条纪律的最大敌人不是看不懂市场，而是 ①盘中算不清此刻该不该动、②情绪驱动的无信号操作、③真要动时算份额容易出错。看板就是为消解这三个痛点而生——**它的价值不在「执行」，而在把纪律的判断与算量从大脑搬到屏幕上，让用户只需照着结果手动下单。**

**因此看板刻意不做的事（边界，勿擅自补成「功能缺失」）**

- **不执行、不连券商**：执行始终是人工动作。看板越界自动下单，就违背了「机械出信号、人工担责执行」的设计。
- **不替用户决策**：看板只摆事实、给信号、算份额；要不要动、动多少最终由人确认。这是「纪律 > 聪明」在产品形态上的落地。
- **不管 QDII / 全球配置**：那是与 A 股估值引擎完全解耦的另一套体系，掺进来只会污染 PE 信号的纯粹性。
- **不做枷锁层日常调度**：枷锁层是长期持有的「装死」底仓，本就不该被日常 PE 波动驱动；看板只在用户显式标记或填权重时才把某只纳入降权计算。
- **不判定 T+7 成熟份额、不实现黑天鹅静默/破窗等执行细则**：这些属于人在交易端的临场判断，看板只提供算量依据，不代行判断。

## 1.2 看板凭什么观察：实时 PE 锚定

**要解决的现实矛盾**：纪律要求「用今日真实 PE 决定动作」，但官方 PE 当晚才发布，而基金交易 14:50 就截止——盘中根本拿不到权威 PE。

**看板的解法**：把「夜间定锚」与「盘中插值」接力。

- **夜间定锚（用户录入）**：收盘后用权威 PE 反推出次日的几个关键**指数点位**——*收盘点位*（对应昨日收盘 PE）、*增权点位*（PE 跌到买入线时沪深300 的点位）、*降权点位*（PE 涨到卖出线时的点位）。这几个数由外部脚本算好、用户录入看板。
- **盘中插值（看板计算）**：看板拿沪深300 的**实时点位**，在「增权点位—收盘点位—降权点位」之间做分段线性插值，反推出**实时 PE**。这就是 `getCurrentPE`。

**为什么这样设计**：用户无法盘中拿到官方 PE，但能拿到实时指数点位。只要夜里把「点位 ↔ PE」的对应锚死，盘中就能用点位反推 PE。**这正是看板作为「�yan盘工具」的立身之本——没有它，纪律在盘中无法落地。**

**目标 PE / 实时 PE / 跨档线 三个概念**（后文反复用到）：

- **实时 PE**：上面插值出来的当下估值，是一切信号的输入。
- **目标总权益**：实时 PE 经 12 档映射得到的「此刻应持有多少权益仓位」（见 1.3）。
- **跨档线（触发线）**：当前档位上下边界各外扩一个缓冲带后的两条 PE 线（见 1.4）；实时 PE 越过它才算「真跨档」、才给信号。

## 1.3 看板凭什么算目标：12 档 S 曲线

**功能定位**：这张表是「实时 PE → 目标总权益」的唯一换算依据。看板每次刷新都用它把当下估值翻译成「现在该持有百分之多少的权益」，再与实际持仓比对得出偏离。**没有这张表，看板就无法回答「现在偏离目标多远」——观察功能就空了。**

| 市场 PE 档位 | 目标总权益 | 该档看板给用户的潜台词           |
| ------------ | ---------- | -------------------------------- |
| > 80%        | 20.0%      | 极度泡沫，锁死底仓               |
| 75–80%       | 22.5%      | 泡沫期，极缓收割                 |
| 70–75%       | 25.0%      | 退潮，平稳撤军                   |
| 65–70%       | 27.5%      | 高位警戒，回流资金（当前基线档） |
| 60–65%       | 32.5%      | 偏高，开始抽水                   |
| 55–60%       | 42.5%      | 收割带，下手要狠                 |
| 50–55%       | 50.0%      | 重心区，套利最大化               |
| 45–50%       | 57.5%      | 收割带，吸廉价筹码               |
| 40–45%       | 62.5%      | 深水区，可上弹性品种             |
| 35–40%       | 70.0%      | 逼近极限，活塞水位预警           |
| 30–35%       | 75.0%      | 危机区，强换进攻                 |
| < 30%        | 80.0%      | 深渊，满仓博反转                 |

**曲线形状本身就是设计意图**，看板的行为因此天然疏密不同，这点要让 AI 理解：

- **头部钝化（PE>70 步长极小）**：高位时相邻档目标权益只差 2.5%，意味着看板在高位给出的减仓量很小——刻意防止把最后的底仓和利润卖飞。
- **腰部暴力（PE 45–60 步长最大）**：估值合理偏低时相邻档目标差 7.5%–10%，看板给出的操作量最大——这是收益的主来源，看板在此最「活跃」。
- **尾部钝化（PE<35 步长收缩）**：极低位时再次收窄，看板给出的加仓量受控——防止在真正的大底前过早打光弹药。

> 此表即 `config.js` 的 `PE_EQUITY_TABLE`。它是投资方法论的产物，**改动须由用户基于方法论决定，AI 不在看板侧擅自改数**。

## 1.4 看板凭什么提醒：缓冲带与跨档触发

**要解决的问题**：若 PE 一碰档位边界就提醒，估值在边界反复横跳时看板会狂发信号、诱发来回操作——这恰是用户要避免的「交易摩擦吞噬收益」。

**看板的解法——缓冲带 ±1.75%**（`SYS_CONFIG.BUFFER_ZONE`）：在当前档位的上下边界各外扩 1.75%，形成两条**跨档线**。实时 PE 只有真正越过跨档线，看板才判定「跨档」并给信号：

- 实时 PE > 本档上边界 + 1.75% → 降权信号（估值偏高，该减仓）
- 实时 PE < 本档下边界 − 1.75% → 增权信号（估值偏低，该加仓）
- 跨档后按新档边界重算缓冲带

**这个缓冲带承载三层提醒纪律**，是看板「只在该动时才催」的关键：

- **防边界震荡**：估值在档位边界附近抖动时不触发，避免来回操作。
- **防接飞刀**：暴跌一次跨 2 档，也只触发 1 次增权信号——强制分批，不让用户一路买到底。
- **防追涨**：暴涨一次跨 2 档，也只触发 1 次降权信号——保住底仓，不追着卖。

**装死 vs 触发**：看板对外只有两种态度——未跨线就明确显示「对齐、无需动作」（对应用户纪律里的「装死」），跨线才高亮信号。**让用户绝大多数时间看到「不用动」,正是看板在帮用户对抗手痒。**

## 1.5 看板凭什么算量：权益填补倒推法

**目标**：信号出现后，看板要回答「具体卖哪只、买哪只、各多少份」。它用一个会计恒等式倒推：

```
[ 枷锁层权益贡献 ] + [ 可调度层补充 ] = [ 当前 PE 目标总权益 ]
```

- **枷锁层 = 固定底色**（鹏华丰利 / 易方达回报 / 海富通混合 / 博道300增强C 等，≈75% 基线）：长期持有不动，贡献一块相对稳定的权益。看板把它当常量，**不主动调度**——因为它的价值在长期 Alpha，频繁动它就是摩擦。每只对总权益的贡献 = 实际占比 × 其「档位」(权益敞口系数)。
- **可调度层 = 零摩擦活塞**（A500C / 中证500C / 兴全中长债，统一 C 类、T+7 零摩擦）：承担**全部** PE 跨档的权益调节。看板的增降权算量只在这一层动手。

**为什么分两层**：把「该动的」和「不该动的」在数据结构上分开，看板才能既算准总权益、又只对零摩擦的活塞层下手——这是「操作策略 > 选品 Alpha」「低摩擦优先」在产品里的体现。

## 1.6 看板凭什么给份额：资金调度规则

信号方向定了，看板按固定优先级把「权益缺口」翻译成具体份额：

**增权（缺口 Gap = 目标权益 − 当前权益，需把资金转成权益）**

1. **资金来源固定为卖出兴全中长债**（`CODE_XQ`）——它是零摩擦的资金活塞，专门干这个。
2. **优先买 A500C**（`CODE_A500`），但单品占总资产不超过 `LIMIT_A500C`（20%）——主力 Beta 工具，但要防单品集中。
3. **溢出买中证500C**：缺口超出 A500C 上限的部分，转投持仓中名称含「中证500」的品种（`isZZ500Product` 动态按名称识别，不硬编码代码，便于换券）——它是极端低估时的弹性武器。

**降权（需把权益转回资金）按三层优先级减仓**

1. **中证500 品种**（按名称自动识别，最高优先）——先撤弹性最大的。
2. **用户手动标记的优先卖出品种**——把临场判断权交给用户。
3. **其余按用户填的权重比例减仓**——兜底分摊。

**摩擦模型**：`SYS_CONFIG.FEE`（0.5%）只对混合型品种（权益系数 `∉ {0,1}`）计提；纯债（系数 0）与纯股 C 类（系数 1）零摩擦。**看板据此在降权预案里如实显示「交易磨损」，让用户看见每次操作的代价**——这是用产品手段强化「摩擦敏感」纪律。

**调仓用哪一档的目标**：看板算调仓量时，用的是**跨档后**的目标档而非当前档——增权看下一档、降权看上一档、纯展示资产权益时看当前档（见 `getDynamicTarget`）。因为信号一旦触发，意图就是迁移到新档位，算量自然该对齐新目标。

## 1.7 看板的整体数据流（把上面串起来）

```
用户夜间录入：收盘PE / 收盘点位 / 增权点位 / 降权点位 / 档位区间
        │
        ▼
盘中沪深300 实时点位 ──┐
                       ├─→ 实时 PE（getCurrentPE 分段插值，1.2）
夜间定锚参数 ──────────┘
        │
        ▼
实时 PE ──→ 12 档 S 曲线 ──→ 目标总权益（1.3）
        │
        ├─→ 当前持仓权益（calcCurrentEquity）→ 偏离方向/幅度 → 染色 + 跨档判定（1.4）
        │
        ├─→ 增权预研（calcBuyPlanDraft）：卖兴全 → 买 A500C/中证500C 各多少份（1.5/1.6）
        │
        └─→ 降权预案（calcSellExecutionDraft）：三层优先级下各品种卖出份额 + 磨损（1.6）
        │
        ▼
用户照份额，自行手动下单
```

## 1.8 多端同步：为什么要版本号

**使用场景决定设计**：用户在 PC / iOS 多端看盘，iOS 常被系统杀后台、多为冷启动。两类数据的更新频率与重要性不同，故分开处理：

- **PE 定锚（每日高频）**：每晚单端录一次，即时推送，他端打开就拉。无需版本号——丢了肉眼一秒能重录。
- **配置（持仓/基金列表/降权预案/优先卖出，周级以下低频）**：一旦录错或被旧端覆盖，损失大。故带**版本号**，遵循「**谁新谁赢 + 反向自愈**」：本地改动即自增版本；拉取时只采纳比本地新的云端版本；若本地反而更新（上次推送丢了），下次拉取自动把本地推回云端。

**业务含义**：用户任何一次有效编辑最终都不会被旧数据覆盖回退；且用户清空日志文件不影响同步（版本号写在配置自身，不依赖日志）。技术实现见 2.5。

---

# 第二篇 · 系统架构

## 2.1 项目结构与加载顺序

纯原生前端，零构建，零框架，唯一外部库：CDN 的 `Sortable.js`。**文件上限 10 个，不可突破。**

```
fund-monitor/
├── index.html
├── favicon.png
├── css/style.css
└── js/
    ├── config.js      # 第1层：静态配置（常量 + 纯工具函数）
    ├── store.js       # 第2层：全局状态、localStorage、Observer 广播
    ├── data.js        # 第3层：网络请求与数据标准化
    ├── engine.js      # 第4层：纯函数计算引擎（依赖注入）
    ├── ui.js          # 第5层：DOM 渲染、格式化、抽屉 HTML 工厂
    ├── interact.js    # 第6层：用户事件调度器
    ├── main.js        # 第7层：启动、定时器、订阅绑定（始终只有十几行）
    └── logger.js      # 诊断层：破例文件，见 3.7
```

> **结构备注**：以上为 GitHub 仓库的真实结构（`css/` `js/` 嵌套）。Claude 项目知识库受限只能平铺存放副本，那只是托管形式，不代表真实目录——勿据平铺副本「修正」本结构。

加载顺序：`config → logger → store → data → engine → ui → interact → main`

> **`js/` 十文件上限不含 `automation/`**：`automation/` 是独立的 Python + GitHub Actions 夜间验证层，与前端看板运行时完全解耦，不占十文件配额、不参与上述加载顺序。详见 2.7。

## 2.2 分层与职责边界

全局作用域共享。**依赖单向向下，下层绝对不能调用上层。** `data` 与 `engine` 平级，互不依赖。

```
config → store → data ─┐
                        ├→ ui → interact → main
              engine ──┘
```

| 层              | 核心职责                                                     | 绝对禁止                                                 |
| --------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| **config.js**   | 业务常量、无副作用纯工具函数（`isZZ500Product`）             | 副作用函数、业务数字散落到其他文件                       |
| **store.js**    | 内存变量、localStorage 读写、Observer 广播、快照导入、配置版本号 | DOM 操作、网络请求、业务计算                             |
| **data.js**     | 网关请求、TTL 缓存、`fetchSingleFund`、`getNavByCode`、云端读写 | DOM 操作、业务计算、localStorage 读写、直连任何第三方行情域名 |
| **engine.js**   | 纯函数：市场状态、PE 插值、权益计算、增降权推演、今日盈亏。**依赖全部参数传入** | DOM、localStorage、调用 store/data 函数                  |
| **ui.js**       | DOM 读写、格式化、`UI_update*` 订阅响应、`UI_render*` HTML 工厂（只返回字符串） | 业务计算、localStorage 读写                              |
| **interact.js** | 响应用户事件，协调 store/engine/ui，显式调用 `syncCloud`     | 核心数学公式（委托 engine）、直接操作 localStorage       |
| **main.js**     | 初始化、定时器、Observer 订阅绑定                            | HTML 拼接、业务逻辑、直接 DOM 操作（事件绑定除外）       |

**config.js 纯工具函数**：函数体内只做字符串/数值运算，不读写外部状态。当前收录 `isZZ500Product(name)`。engine 调用它不违反依赖注入。

## 2.3 Observer 数据驱动

写入 store → store 广播 → 订阅者自动响应。**调用方不需要、也不应该手动调渲染函数。**

| 频道           | 触发时机                            | UI 响应                  |
| -------------- | ----------------------------------- | ------------------------ |
| `FUNDS`        | 净值刷新、列表增删                  | `UI_updateFunds()`       |
| `INDICES`      | 指数行情刷新（10 秒）               | `UI_updateIndices()`     |
| `LOCAL_CONFIG` | PE 定锚、持仓/降权预案/优先卖出变更 | `UI_updateLocalConfig()` |

- **云推送不挂广播**：`syncCloud` 由 interact 在配置变更时显式调用。`FUNDS` 同时被每分钟净值刷新触发，挂订阅会产生无意义 API 调用。正确调用点：`addFund`、`delFund`、`saveHoldings`、`confirmPe`，各自显式调用 `syncCloud("push_pe_now" / "push_config")`。
- **配置版本号不广播**：`bumpConfigVer()` 仅写 localStorage 作同步判据，不渲染、不挂频道。

## 2.4 运行时数据流

**主刷新（60 秒）**

```
main setInterval → refreshData()
    → fetchIndices()              // 网关 /v1/indices → 广播 INDICES + setQQIndex
    → fetchOfficialData()         // 网关 /v1/funds/official，整组
    → fetchEstimates()            // 网关 /v1/funds/estimate，整组
    → fetchSingleFund() × N       // 纯合并，无网络请求
    → setLastResults()            // → 广播 FUNDS → UI_updateFunds()
    → Sortable 销毁重建
```

**指数实时（10 秒）**

```
main setInterval → fetchIndices() → setIndices() → 广播 INDICES → renderIndices() + updatePeBar()
```

**本地配置变更**

```
confirmPe() → savePe() → 广播 LOCAL_CONFIG → syncCloud("push_pe_now")

saveHoldings() / addFund() / delFund() / 拖拽排序 / 标记优先卖出
    → saveHoldingsData() / saveFunds() / savePrioritySell() / clearPrioritySell()
        → 内置 bumpConfigVer() 同步自增配置版本并落地
        → 广播 LOCAL_CONFIG / FUNDS
    → syncCloud("push_config")    // payload 带当前版本号 v
```

**持仓抽屉（不触发广播）**

```
openHoldingDrawer()
    → 读 store → engine.calc*()
    → UI_renderHoldingDrawerBody() → 写入抽屉 DOM
    → liveUpdateHoldingPlan()
        → calcCurrentEquity / calcBuyPlanDraft / calcSellExecutionDraft
        → UI_buildHoldingPlanHtml() → 写入 #holdingPlanArea
```

增权预研与降权预案集成在 `#holdingPlanArea`，**没有独立预案抽屉**。

## 2.5 云同步与配置版本机制

**三个云端文件**

```
fm_pe.json     ← p 字段，PE 定锚（高频；无版本号，内容比对）
fm_config.json ← v / f / h / s / pr（低频；v 为版本时间戳，置 JSON 首位）
fm_log.json    ← 操作日志（用户可随意清空，不影响同步）
```

**拉取流程**

```
syncCloud("pull")
    → cloudFetchPe() + cloudFetchConfig()        // 两文件并行
    → 两文件均拉取失败 → return false             // 唯一的「真失败」
    → importPeSnapshot()                          // PE 内容比对，相同跳过
    → importSnapshot()                            // config 版本比对：remoteV > localV 才采纳
    → 本地 v 仍比云端新 → setTimeout 反向 push_config 自愈
    → refreshData()                               // 拉取成功即刷新（无论有无变更）
    → return true
```

**配置版本 `v`**：本地时间字符串 `YYYY-MM-DD HH:mm:ss`，置于 JSON 首位（可肉眼读最后修改时间），按字典序即时间序。

- **自增**：配置内容变更（`saveFunds` / `saveHoldingsData` / `savePrioritySell` / `clearPrioritySell`）时，store 封装函数内置 `bumpConfigVer()` **同步**落地——不放在防抖推送里，确保推送被杀也不丢版本。
- **采纳**：`importSnapshot` 仅在 `remoteV > localV` 时采纳云端并把本地 v 抬到 remoteV，否则跳过。**幂等由此保证**，同一份配置不重复导入。
- **反向自愈**：拉取后若本地 v 仍更新，延迟触发 `push_config` 推回云端，他端下次打开即收敛，永不回退。
- **PE 不版本化**：每日单端录入、即时推送、`importPeSnapshot` 读 localStorage 本就幂等，无需版本化。

**pull 返回值语义**：表示「拉取是否成功」，非「内容是否变更」。仅两文件都取不到才 `false`；取到任一即刷新并 `true`（即使无变更）。`manualPull`/`openCloudConfig` 据此判定成败提示，`main.js` 据此决定是否本地补刷。

## 2.6 engine 依赖注入

所有 engine 函数为纯函数，外部依赖全部参数传入。`SYS_CONFIG`、`PE_EQUITY_TABLE`、`isZZ500Product` 等 config 常量/纯工具函数因无副作用可直接使用。

engine 内计算出的中间变量若不出现在 return、也不用于后续计算，**必须删除，不允许死变量**。

## 2.7 夜间 PE 数据引擎（automation/，独立于前端看板）

**定位：旁路锚的数据源，不是看板 PE 定锚。** 它写的是 `fm_pe_engine.json`，与 2.5 节 `fm_pe.json`
（你每晚手录的定锚）是**完全不同的 Gist 文件**，AI 不要混为一谈。

```
automation/pe_nightly.py（GitHub Actions 跑，非本地）
    └─ 夜间：抓乐咕沪深300滚动PE
        → 写 Gist fm_pe_engine.json（js/interact.js 的 pullPeEngine() 拉取，30分钟节流、失败静默）
```

**前端只消费 5 个字段**：`date` / `peYest` / `priceYest` / `mcapYest` / `peSorted`。
`mcapYest` 是 1.0 总市值路的锚，`priceYest` 是 2.0 点位路的锚，`peSorted` 供百分位二分查找。
payload 里的 `pctYest`/`peQQYest`/`priceQQYest`/`n` 前端不读，是抓取副产品，留着便于肉眼看 Gist。

- **触发方式**：`.github/workflows/pe-night-engine.yml` 不用 cron，由外部 Cloudflare Worker
  （Master-Scheduler）通过 `repository_dispatch`（`night`/`sentinel` 两种 type）唤醒；
  `night`→`RUN_SLOT=early`（乐咕没更新则温和退出等下一槽），`sentinel`→`late`（仍没有则报错）。
  `workflow_dispatch` 仅作手动/手机兜底入口。本工作流**只写 Gist、不回提交仓库文件**（`contents: read`）。
- **`automation/cf_worker_pe_trigger.js`**：Worker 侧触发器。密钥全走 `env.*` 绑定，代码不含明文（沿革见 4.5）。

### 双路验证层已拆除（2026-07-19）

原有 16:00 快照 + 夜间与官方配对 + `validation-log.json` 的整套比对，其唯一目的是回答「1.0 和 2.0 哪个准」。
15 个可比对交易日（06-25 ～ 07-17）的结论已经足够确定：

| | 1.0 总市值路 | 2.0 点位路 |
| --- | --- | --- |
| 平均绝对误差 | 0.41pp | 1.31pp |
| 最大绝对误差 | 0.86pp | 3.69pp |
| 误差 >1pp 天数 | 0 / 15 | 6 / 15 |
| 逐日更接近官方 | 14 / 15 | 1 / 15 |

故 `pe-snapshot.json`、`validation-log.json`、`RUN_ACTION=snapshot` 分支、Worker 的 `snapshot` 路由
一并删除，Master-Scheduler 侧 16:00 那一跳应同步取消。**2.0 保留在看板上**：成分调整日总市值会跳变，
那种日子点位路反而是有效参照。若日后要重建验证，从 git 历史取回即可，不要在引擎里留半套。

---

# 第三篇 · 实现约束

## 3.1 localStorage 封装

interact 层和 ui 层**禁止直接调用 `localStorage`**，所有读写通过 store 封装。

| 数据类型  | 读                                                           | 写                   | 清                    |
| --------- | ------------------------------------------------------------ | -------------------- | --------------------- |
| 基金列表  | `loadFunds()`                                                | `saveFunds()`        | —                     |
| PE 定锚   | `loadPe()`                                                   | `savePe()`           | —                     |
| 持仓数据  | `loadHoldings()` / `loadHoldingsEquity()` / `loadShortNames()` | `saveHoldingsData()` | —                     |
| 降权预案  | `loadSellPlan()`                                             | `saveSellPlan()`     | —                     |
| 优先卖出  | `loadPrioritySell()`                                         | `savePrioritySell()` | `clearPrioritySell()` |
| 配置版本  | `loadConfigVer()`                                            | `bumpConfigVer()`    | —                     |
| Gist 配置 | `loadGistConfig()`                                           | `saveGistConfig()`   | `clearGistConfig()`   |

**授权例外**

- `syncCloud` push 路径直接读 `localStorage.getItem(STORE_HOLDINGS)` 跳过缓存，保证推送实时性。
- `importSnapshot` 内部直接写 `f/h/s/pr` 与配置版本号（不经 `saveSellPlan` 等封装，避免重复 `fmLog`），最后统一广播 `FUNDS` + `LOCAL_CONFIG`，避免双重渲染。

## 3.2 资金规则 → 代码映射

业务规则（1.5–1.6）落到 engine 的对应关系，改动须对照业务验证：

- **增权 `calcBuyPlanDraft`**：`buyAmt` = 缺口现金；`allocA500C = min(buyAmt, a500cRoom)`，`a500cRoom` 受 `LIMIT_A500C` 约束；`allocZZ500C` = 溢出，按 `isZZ500Product` 找承接品种。
  - ⚠️ `sharesA500C`/`sharesZZ500C` **除以兴全净值 `xqNav`**，因为业务关注的是「为各买入桶需**卖出的兴全份额**」，不是买入标的份额——**有意设计，勿改成除以 a500cNav**。
  - ⚠️ `totalFriction: 0` **有意设计**：增权标的为纯债（卖出端）和 C 类（买入端），均零摩擦，用户自行掌握。
- **降权 `calcSellExecutionDraft`**：三层优先级——中证500（`isZZ500Product`）→ `priorityCode`（用户标记）→ 其余按 `ratios` 比例。仅 `equity>0` 的品种参与。
- **档位目标 `getDynamicTarget(mode, bucketStr)`**：`buy` 取下一档、`sell` 取上一档、`neutral` 取本档。**边界兜底**：最低档增权或最高档降权时返回本档 target，业务合理，不是 bug。
- **实时 PE `getCurrentPE`**：用 `priceBuy / priceAnchor / priceSell` 分段线性插值（buyPct = lo − BUFFER_ZONE，sellPct = hi + BUFFER_ZONE）。点位超出范围时**线性外推**，不在 buyPct/sellPct 处硬截——PE bar 标记可越过跨档线继续移动。无实时点位时回落到收盘 `peYest`。
- **方向异常 `isEquityWrongDir`**：高估区（PE ≥ `PE_HIGH_THRESHOLD`）权益偏低超 `EQUITY_DEV_LIMIT`，或低估区权益偏高超阈值。

**业务数字一律在 config.js**：费率 `FEE`、缓冲带 `BUFFER_ZONE`、阈值 `PE_HIGH_THRESHOLD`/`EQUITY_DEV_LIMIT`、代码 `CODE_XQ`/`CODE_A500`/`IDX_PE`、上限 `LIMIT_A500C`、时点 `T_*`/`T_OFF_UPDATE`、默认档位 `DEFAULT_BUCKET`、12 档表 `PE_EQUITY_TABLE`。新增业务数字不得散落他处。

## 3.3 engine 净值/档位取值规则

**净值选取 `getNavByCode`**：`offD >= estD` 用官方净值（offVal），否则用估算（estVal）。`getNavByCode`、`calcTodayProfit`、`openHoldingDrawer` 的 profitMap 三处保持同一规则，不允许差异（有意三处一致，非冗余）。所有品种（含纯债）均有盘中估算数据。

**官方净值 TTL（`fetchOfficialData`）**：官方数据按基金列表整体缓存；19:30（`SYS_CONFIG.T_OFF_UPDATE`）前 1 小时 / 后 5 分钟 / 已是当日数据或周末 12 小时。避免按基金分别缓存造成主源与备用源混用。

**市场数据网关（2026-07-19 二阶段）**：浏览器只请求 `API_BASE`（`https://fund-api.bailuzun.com`）下的三个端点，
不再直连东方财富、天天基金、腾讯任何域名，JSONP 机制已整体删除。三条链的主备选择、整组完整性校验、GBK 解码
全部在 Cloudflare Pages Functions 内完成（`workers/fund-market-api/`，详见 `MARKET_DATA_GATEWAY_PLAN.md`）。

- 前端只消费网关返回的 `status`（`primary`/`backup`/`unavailable`），**不自行判定主备**。
- 任一组请求失败或 `ok:false`，整组降级为不可用，**禁止把半组数据交给渲染层**。
- **主线路不出声**：页面寸土寸金，主线路是常态，不占任何版面。只有降级到 `backup` 才提示，且各自就近显示，
  不新增行、不新增区块：指数走 `idx-bar` 既有的 `data-status` 窄行（9px）显示「备用行情」；基金估算与官方净值
  在卡片内各挂两个小字（`srcTag()` → `.src-tag`）；PE 在 2.0 百分位数字**正下方**挂同样两个小字。
- **备用指数源仍要写 `setQQIndex`**：备用只是缺总市值，点位是有的。2.0（点位路）照常可算，1.0 由
  `getEnginePE1` 自己的 `mcap>0` 判据回落昨收——不要在 data 层用 `mcap>0` 一刀切掉两路。
- **2.0 的显示不挂 `isDynamic`**（那取自 1.0）：走备用时 1.0 失效、主数字冻回昨收，此刻点位路的 2.0
  是仅存的实时估计，正该露出来。
- **指数组主线路是腾讯，不是东方财富**：PE bar 锚定 `getEnginePE1`（1.0 总市值路），其唯一输入是沪深300
  实时总市值，而东方财富可达镜像 `push2delay` 只给点位（`f115=f116=0`）。网关据此要求主线路必须带
  HS300 的 `pe`/`marketCap`，缺失即整组切备用。UI 显示 ⚠ 备用线路时，即代表 PE bar 已退化为昨收锚定。
- `baseNav`/`baseDate`（昨日已确认净值）随估算组返回，供 `calcTodayProfit` 用；缺失时回落到按涨跌幅反推。

官方组三态（`offSource`，一次刷新内只许其一，禁止逐只混用）：

- `primary`：网关取 `FundMNFInfo`，UI 标记“主线路 · 天天基金移动批量”。
- `backup`：网关取 `FundMNHisNetList`，UI 标记“⚠ 备用线路 · 天天基金历史净值”。
- `unavailable`：官方两级接口均失败；官方字段保持空值，禁止用盘中估算或腾讯快照冒充官方数据。

## 3.4 染色体系

| 变量       | 唯一语义                       |
| ---------- | ------------------------------ |
| `--buy`    | 增权方向                       |
| `--sell`   | 降权方向、优先卖出标记         |
| `--up`     | 行情上涨                       |
| `--dn`     | 行情下跌、完成/已更新状态      |
| `--warn`   | 方向异常（`wrongDir` 为 true） |
| `--t1`     | 已对齐（偏离 < 1%）的权益值    |
| `--t2`     | 偏离 < 1% 的偏差数字、辅助信息 |
| `--t3`     | 无数据、占位文字               |
| `--accent` | 持仓总额、主操作按钮           |

**权益/偏离值染色**（优先级从高到低）：

| 状态     | 条件             | 权益色   | 偏离色   |
| -------- | ---------------- | -------- | -------- |
| 无数据   | `eqData == null` | `--t3`   | —        |
| 方向异常 | `wrongDir`       | `--warn` | `--warn` |
| 已对齐   | `\|diff\| < 1%`  | `--t1`   | `--t2`   |
| 偏高降权 | `diff >= 1%`     | `--sell` | `--sell` |
| 偏低增权 | `diff <= -1%`    | `--buy`  | `--buy`  |

## 3.5 样式约定

- **字体**：数字加 `class="num"`（`--f-num`），中文用 `--f-zh`，禁止遗漏。
- **颜色**：全部用 CSS 变量，禁止硬编码 hex/rgb/具名色。唯一例外：遮罩层 `rgba(0,0,0,0.6)`。
- **字重**：只用 400 / 500 / 600，禁止 700。
- **动态 `<input>`**：必须声明字体、背景、边框、文字颜色（不继承父级）。
- **网格边框**：容器 `gap:1px` + 边框底色，单元格设卡片底色，天然细线；禁止 `:nth-child` + `border` 覆写。
- **抽屉 Tab**：`tabStyle` 用 `var(--bg3)`；增权 Tab 用 `var(--buy-bg)`、降权用 `var(--sell-bg)`；卡片体统一 `var(--bg3)`，方向感由数字颜色和边框传达。
- **护眼模式**：低饱和度护眼调色盘，`<meta name="darkreader-lock" />` 防外部劫持；除 `--up/--dn` 外禁止高亮纯白。

## 3.6 ui.js 关键约定

- **DOM 缓存**：高频静态节点通过 `_getEl(id)`，禁止在渲染循环内直接 `getElementById`。
- **`_peDOMReady` flag**：控制 `_peDOM` 一次性初始化，禁止用 `!_peDOM.display` 判断（display 为 null 时误判）。
- **`UI_render*` 工厂**：只返回 HTML 字符串，DOM 写入由 interact 负责。
- **`UI_buildSummaryHtml` 签名**：`(currentPE, eqData, currentEqVal, eqCol, targetNeutralNum, inDrawer=false)`，`inDrawer=true` 自动输出抽屉样式。
- **`UI_buildHoldingPlanHtml` 的 `eqData`**：由 `liveUpdateHoldingPlan` 计算后传入，ui 层禁止自行调 `calcCurrentEquity`。
- **`renderTodayProfit` 签名**：`(results, holdings, activeProds, mktState, todayStr)`，`holdings` 和 `activeProds` 由调用方传入。

## 3.7 日志诊断系统（logger.js）

破例的第 10 个文件，长期保留。记录本地写入与云端推送（时间戳、客户端标识、函数名、数据快照），写入主 Gist 的 `fm_log.json`，最多 200 条滚动覆盖（约 10 天）。未配置 Gist 时静默跳过。

**配置**：与主 Gist 共用 `GistID,Token`，首次使用前须在主 Gist 手动添加 `fm_log.json`，初始内容 `[]`。

**接入点（10 处）**：store.js 的 `saveFunds`、`savePe`、`saveHoldingsData`、`saveSellPlan`、`savePrioritySell`、`clearPrioritySell`、`importSnapshot`（记录 `v/f/h/s/pr`）、`importPeSnapshot`；interact.js 的 `syncCloud_push_pe`、`syncCloud_push_config`（含版本号 `v`）。

**已知限制**：`fmLog` 为非原子的「GET 整份 → push → PATCH 整份」，同瞬两个 `fmLog` 会竞争同一文件、后者覆盖前者。配置版本机制落地后 import 已幂等、并发写日志极少，实务无影响；若需绝对可靠可改串行队列，非必需。

**停用**：删除 `logger.js`、删除 `index.html` 中的 script 标签、删除 store.js 与 interact.js 中所有 `fmLog(...)` 调用行。

---

# 第四篇 · 开发纪律

## 4.1 审查方法论（三步验证）

发现疑似问题前必须完成：

1. **业务验证**：对照第一篇，确认是否符合业务预期（结构看似异常的代码可能是有意设计，如 `totalFriction:0`、`xqNav` 口径）。
2. **数据验证**：基于真实数据特征，不允许用假设场景推断问题。
3. **影响范围验证**：区分「逻辑看起来不一致」和「结果确实有误」。

**给出缺陷结论前必须能回答：在什么场景下，用户会看到什么错误结果。** 答不出不算确认的缺陷。

## 4.2 改动原则

- **读再动**：先读懂现有代码，不靠猜测。
- **改原处，不包裹**：找到根源直接改，不在外部套新函数绕开原代码。
- **改后变少不变多**：重复逻辑合并删除，不再调用的函数/变量直接删除，中间变量只在复用 2 次以上时引入，注释只留「为什么」。
- **功能边界**：审查只发现问题，不擅自补功能。「引擎已算好但 UI 未展示」→ 记为功能缺失等决策，不自行补上。
- **结构性改动先问**：改目录结构、文件清单、跨层方案、删除疑似有用的函数等，必须先与用户确认，不靠副本推断。
- **输出格式**：改代码前精确说明每处改动（文件、函数、行号、旧→新片段）；说明后只输出改动函数的完整代码；多函数逐个说明、逐个输出；**默认不输出整个文件**，除非用户明确要求。

## 4.3 纪律清单

1. **改一层只动一个文件**：穿透两层须先说明原因并获确认（如版本机制横跨 config 常量 + store 写入 + interact 调度，须整体说明）。
2. **参数只在 config.js**：业务数字不散落他处。
3. **funds 改动必须持久化**：改后立即 `saveFunds()`。
4. **配置版本自增**：配置内容（f/h/s/pr）写入一律经 store 封装（已内置 `bumpConfigVer()`）；新增任何配置写入路径必须同样触发版本自增，否则破坏多端收敛。
5. **持仓跟随看板**：`saveHoldings` 从当前看板产品重建 shares/equity/shortNames/plan，移出看板的产品旧条目一并丢弃，不保留看板外历史持仓。
6. **极端值防御**：持仓为零、PE 未定锚等异常输入返回 `null` 或 `{ error: true }`，不允许 `NaN`/`undefined` 流入渲染层。
7. **Sortable 生命周期**：`refreshData()` 后先 `destroy()` 旧实例再重建。
8. **优先卖出持久化**：`openHoldingDrawer` 打开前必须 `setPrioritySellCode(loadPrioritySell())` 同步。
9. **weight 存储类型**：写入 `saveSellPlan` 前必须 `parseFloat()`，禁止字符串存入。

## 4.4 提交检查清单

**审查**

- [ ] 缺陷结论前已完成业务、数据、影响范围三步验证
- [ ] 未擅自补充用户未要求的功能；结构性改动已先确认

**架构**

- [ ] 改动前已用文字说明文件、函数、行号、旧→新代码
- [ ] 只输出改动函数，未抛整文件（除非被要求）
- [ ] 改的是根源，未在外部包裹补丁
- [ ] 改后代码量未增加，无死变量、无僵尸函数
- [ ] 新增函数在正确层级，无跨层调用
- [ ] 数据变更通过 store 广播驱动，未手动调渲染
- [ ] engine 外部依赖通过参数传入（config 常量和纯工具函数除外）
- [ ] 业务参数在 config.js，无硬编码
- [ ] 极端输入有防御处理
- [ ] `funds` 修改后有 `saveFunds()`；interact 层未直接操作 localStorage
- [ ] `syncCloud` 在配置变更的 interact 函数中显式调用，未挂广播订阅；PE 用 `push_pe_now`，持仓/列表用 `push_config`
- [ ] weight 以 `parseFloat()` 数字存入 sell plan
- [ ] 配置内容变更经 store 封装写入（已内置 `bumpConfigVer()`），未绕开封装直写
- [ ] `importSnapshot` 用版本号判据（`remoteV > localV` 才采纳），未退回内容比对
- [ ] `syncCloud("pull")` 返回值表示拉取成败，非内容是否变更
- [ ] 持仓保存跟随看板，移出看板的产品在 h 中一并清除

**样式**

- [ ] 动态拼接数字元素有 `class="num"`
- [ ] 颜色通过 CSS 变量，无裸色值
- [ ] 字重只用 400 / 500 / 600
- [ ] 动态 `<input>` 有完整字体和颜色声明
- [ ] 权益染色遵循 3.4，`--up/--dn` 不用于权益方向
- [ ] 抽屉卡片体背景用 `var(--bg3)`，不用高饱和方向色

## 4.5 CLAUDE.md / cf_worker_pe_trigger.js 追踪状态沿革（gitignore 踩坑记录，勿重蹈）

**历史状态（2026-06-19 ～ 2026-07-16）**：`CLAUDE.md` 与 `automation/cf_worker_pe_trigger.js` 曾被 `.gitignore` 显式排除（"Local project guidance and deployment snapshots"），理由是本仓库公开部署（GitHub Pages + CNAME），当时判断这两份文件不适合公开。

**踩过的坑（务必记住这个机制，即便这两个文件现状已变）**：gitignore 的文件**永远不会被 `git clone` / `git pull` / `git checkout` 带回来**——它们只活在具体某台机器的磁盘上。任何一次全新 `clone`（换机器、换工作目录、环境重置）都会让 gitignore 的文件"凭空消失"，这不是 git 故障，是设计的必然结果。**本仓库已实际发生过**：本地工作目录建于 2026-07-09 的一次 clone，晚于两文件 2026-06-19 被移出追踪 + 07-08 被写入 `.gitignore` 的时间点，clone 时它们已不在可追踪历史里，故从未落地，靠 `git log --all -- <path>` 找到 `Delete` commit 的父提交内容手工找回。

**现状（2026-07-16 起）**：用户评估后认为反复"考古恢复"的代价大于公开这两份文件的代价，**已将两者移出 `.gitignore`、纳入公开仓库正式追踪**。`cf_worker_pe_trigger.js` 已确认代码本身不含明文密钥（`CRON_TOKEN`/`GH_TOKEN`/`GH_REPO` 均走 `env.*` 绑定），公开无泄密风险；`CLAUDE.md` 也已核对无实际 token/密钥值。**以后新增任何"本地专属、不想公开"的文件，先想清楚上面这条 gitignore+clone 的坑，优先选择"仓库外单独备份"而不是单纯 gitignore，否则迟早重演这次的丢失。**

---

# 附录 · 看板未实现项（方法论中存在，待后续业务决策）

以下属方法论范围、当前看板未实现或未显式约束，记录备查，**不擅自补**：

- **中证500C 的 PE<45% 激活门槛**：当前增权溢出逻辑只在 A500C 触顶后承接，未显式校验 PE<45%。
- **T+7 FIFO 成熟份额判定**：看板出目标份额，FIFO 由人工执行，引擎不跟踪份额年龄。
- **枷锁层「不参与日常调节」的硬约束**：降权第三层按比例减仓时，是否触及枷锁层取决于用户填的权重，引擎未硬性排除枷锁层品种。
- **破窗 SOP（PE<35）资金来源顺序、黑天鹅静默法则**：属人工执行纪律，未入看板。
- **夜间定锚漂移修正系数**：由外部脚本 `hs300_daily.py` 维护并体现在录入的指数点位中，看板不自行修正。
