# Jany 基金看板 · 项目规范

> 唯一开发决策来源。收到需求：先读本文档 → 读相关源文件 → 动手。不符合本规范直接打回。

---

## 一、项目结构

纯原生前端，零构建，零框架，唯一外部库：CDN 的 `Sortable.js`。**文件上限10个，不可突破。**

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
    └── logger.js      # 诊断层：破例文件，见第十三节
```

加载顺序：`config → logger → store → data → engine → ui → interact → main`

---

## 二、分层架构

全局作用域共享。**依赖单向向下，下层绝对不能调用上层。** `data` 与 `engine` 平级，互不依赖。

```
config → store → data ─┐
                        ├→ ui → interact → main
              engine ──┘
```

| 层              | 核心职责                                                     | 绝对禁止                                                 |
| --------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| **config.js**   | 业务常量、无副作用纯工具函数（`isZZ500Product`）             | 副作用函数、业务数字散落到其他文件                       |
| **store.js**    | 内存变量、localStorage 读写、Observer 广播、快照导入导出     | DOM 操作、网络请求、业务计算                             |
| **data.js**     | JSONP 请求、TTL 缓存、`fetchSingleFund`、`getNavByCode`、云端读写 | DOM 操作（`<script>` 除外）、业务计算、localStorage 读写 |
| **engine.js**   | 纯函数：市场状态、PE 插值、权益计算、增降权推演、今日盈亏。**所有依赖通过参数传入** | DOM、localStorage、调用 store/data 函数                  |
| **ui.js**       | DOM 读写、格式化、`UI_update*` 订阅响应、`UI_render*` HTML 工厂（只返回字符串） | 业务计算、localStorage 读写                              |
| **interact.js** | 响应用户事件，协调 store/engine/ui，显式调用 `syncCloud`     | 核心数学公式（委托 engine）、直接操作 localStorage       |
| **main.js**     | 初始化、定时器、Observer 订阅绑定                            | HTML 拼接、业务逻辑、直接 DOM 操作（事件绑定除外）       |

**config.js 纯工具函数**：函数体内只做字符串/数值运算，不读写外部状态。当前收录：`isZZ500Product(name)`。engine 调用它不违反依赖注入规则。

---

## 三、Observer 数据驱动架构

写入 store → store 广播 → 订阅者自动响应。**调用方不需要、也不应该手动调用渲染函数。**

| 频道           | 触发时机                            | UI 响应                  |
| -------------- | ----------------------------------- | ------------------------ |
| `FUNDS`        | 净值刷新、列表增删                  | `UI_updateFunds()`       |
| `INDICES`      | 指数行情刷新（10秒）                | `UI_updateIndices()`     |
| `LOCAL_CONFIG` | PE 定锚、持仓/降权预案/优先卖出变更 | `UI_updateLocalConfig()` |

**云推送不挂广播**：`syncCloud("push")` 由 interact 层在配置变更时显式调用。`FUNDS` 同时被净值刷新触发，挂订阅会每分钟产生无意义 API 调用。正确调用点：`addFund`、`delFund`、`saveHoldings`、`confirmPe`。`LOCAL_CONFIG` 订阅仅由配置变更触发，可保留 `syncCloud("push")`。

---

## 四、核心数据流

**主刷新（60秒）**

```
main setInterval → refreshData()
    → fetchIndices()              // → 广播 INDICES
    → fetchSingleFund() × N       // Promise.all 并发
    → setLastResults()            // → 广播 FUNDS → UI_updateFunds()
    → Sortable 销毁重建
```

**指数实时（10秒）**

```
main setInterval → fetchIndices() → setIndices() → 广播 INDICES
    → renderIndices() + updatePeBar()
```

**本地配置变更**

```
confirmPe() / saveHoldings() / toggleHoldingPriority()
    → savePe() / saveHoldingsData() / savePrioritySell()
        → 广播 LOCAL_CONFIG → UI_updateLocalConfig()
    → interact 显式调用 syncCloud("push" / "push_now")
```

**持仓抽屉（不触发广播）**

```
openHoldingDrawer()
    → 读 store → engine.calc*()
    → UI_renderHoldingDrawerBody() → 写入抽屉 DOM
    → liveUpdateHoldingPlan()
        → calcCurrentEquity() / calcBuyPlanDraft() / calcSellExecutionDraft()
        → UI_buildHoldingPlanHtml() → 写入 #holdingPlanArea
```

增权预研和降权预案集成在 `#holdingPlanArea`，**没有独立预案抽屉**。

---

## 五、engine.js 依赖注入

所有函数为纯函数，外部依赖通过参数传入。`SYS_CONFIG`、`PE_EQUITY_TABLE`、`isZZ500Product` 等 config 常量/纯工具函数因无副作用，engine 可直接使用。

engine 函数内计算出的中间变量若不出现在 return 中、也不用于后续计算，必须删除。**不允许死变量存在。**

---

## 六、资金规则（v7.6 方法论）

- **增权资金来源**：固定卖出兴全中长债（`CODE_XQ`）
- **增权分配**：优先买入 A500C（`CODE_A500`），单品上限 `LIMIT_A500C`；超出额度买入持仓中名称含「中证500」的品种（`isZZ500Product` 动态识别，不硬编码代码）
- **降权优先级**（三层）：
  1. 名称含「中证500」的品种（自动识别，最高优先）
  2. 用户手动标记的优先卖出品种
  3. 其余品种按权重比例减仓
- **摩擦费率**：`SYS_CONFIG.FEE`，仅适用于混合型（`equity !== 0 && equity !== 1`）。纯债（equity=0）和纯股C类（equity=1）无摩擦，**`calcBuyPlanDraft` 中 `totalFriction: 0` 是有意设计，不是缺陷**——用户自行掌握这两类产品的摩擦。

**档位目标规则**：调仓用触发后的目标档位，非当前中性档。

- 增权触发：`getDynamicTarget("buy", bucketStr)`（下一档）
- 降权触发：`getDynamicTarget("sell", bucketStr)`（上一档）
- 资产权益汇总：`getDynamicTarget("neutral", bucketStr)`（当前中性档）

**档位边界兜底**：最低档增权或最高档降权时返回本档 target，业务合理兜底，不是 bug。

**净值选取（`getNavByCode`）**：`offD >= estD` 时用官方净值（offVal），否则用估算（estVal）。`getNavByCode`、`calcTodayProfit`、`openHoldingDrawer` profitMap 三处保持同一规则，不允许出现差异。所有品种（含纯债）均有盘中估算数据。

---

## 七、localStorage 封装规则

interact 层和 ui 层**禁止直接调用 `localStorage`**，所有读写通过 store 封装函数。

| 数据类型    | 读                                                           | 写                   | 清                    |
| ----------- | ------------------------------------------------------------ | -------------------- | --------------------- |
| 基金列表    | `loadFunds()`                                                | `saveFunds()`        | —                     |
| PE 定锚     | `loadPe()`                                                   | `savePe()`           | —                     |
| 持仓数据    | `loadHoldings()` / `loadHoldingsEquity()` / `loadShortNames()` | `saveHoldingsData()` | —                     |
| 降权预案    | `loadSellPlan()`                                             | `saveSellPlan()`     | —                     |
| 优先卖出    | `loadPrioritySell()`                                         | `savePrioritySell()` | `clearPrioritySell()` |
| Gist 配置   | `loadGistConfig()`                                           | `saveGistConfig()`   | `clearGistConfig()`   |
| Log Gist ID | `loadLogGistId()`                                            | `saveLogGistId()`    | —                     |

**授权例外**：

- `interact.js` 的 `saveHoldings` 可直接调用 `_loadRaw()` 一次性读全量持仓数据
- `syncCloud` push 路径直接读 `localStorage.getItem(STORE_HOLDINGS)` 跳过缓存，保证推送实时性
- `importSnapshot` 内部直接写 localStorage 跳过各封装函数的广播，最后统一广播一次 FUNDS + LOCAL_CONFIG，避免双重渲染

---

## 八、染色体系

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

**`isEquityWrongDir`**：高估区（PE ≥ `PE_HIGH_THRESHOLD`）权益偏低超 `EQUITY_DEV_LIMIT`，或低估区权益偏高超阈值，触发异常。

---

## 九、样式约定

- **字体**：数字加 `class="num"`（已全局定义 `--f-num`），中文用 `--f-zh`，禁止遗漏
- **颜色**：全部用 CSS 变量，禁止硬编码 hex/rgb/具名色。唯一例外：遮罩层 `rgba(0,0,0,0.6)`
- **字重**：只用 400 / 500 / 600，禁止 700
- **动态 `<input>`**：必须声明字体、背景、边框、文字颜色（不继承父级）
- **网格边框**：容器设 `gap:1px` + 边框底色，单元格设卡片底色，天然形成细线；禁止用 `:nth-child` 配合 `border` 覆写
- **抽屉 Tab**：`tabStyle` 用 `var(--bg3)` 底色；增权 Tab 用 `var(--buy-bg)`，降权用 `var(--sell-bg)`；卡片体背景统一 `var(--bg3)`，方向感由数字颜色和边框传达
- **护眼模式**：低饱和度护眼调色盘，`<meta name="darkreader-lock" />` 防外部劫持；除 `--up/--dn` 外禁止高亮纯白

---

## 十、ui.js 关键约定

- **DOM 缓存**：高频静态节点通过 `_getEl(id)` 获取，禁止在渲染循环内直接 `getElementById`
- **`_peDOMReady` flag**：控制 `_peDOM` 一次性初始化，禁止用 `!_peDOM.display` 判断（display 为 null 时误判）
- **`UI_render*` 工厂**：只返回 HTML 字符串，DOM 写入由 `interact.js` 负责
- **`UI_buildSummaryHtml` 签名**：`(currentPE, eqData, currentEqVal, eqCol, targetNeutralNum, inDrawer=false)`，`inDrawer=true` 自动输出抽屉样式
- **`UI_buildHoldingPlanHtml` 的 `eqData`**：由 `liveUpdateHoldingPlan` 计算后传入，ui 层禁止自行调用 `calcCurrentEquity`
- **`renderTodayProfit` 签名**：`(results, holdings, activeProds, mktState, todayStr)`，`holdings` 和 `activeProds` 由调用方传入

---

## 十一、开发铁律

**A. 审查方法论**：发现疑似问题前必须完成三步验证：

1. **业务验证**：对照第六节，确认是否符合业务预期（结构看似异常的代码可能是有意设计）
2. **数据验证**：基于真实数据特征，不允许用假设场景推断问题
3. **影响范围验证**：确认运行结果是否真正偏差，区分「逻辑看起来不一致」和「结果确实有误」

**给出缺陷结论前，必须能回答：在什么场景下，用户会看到什么错误结果。** 无法回答不算确认的缺陷。

**B. 功能边界**：审查只发现问题，不擅自补充功能。发现「引擎已算好但 UI 未展示」→ 记录为功能缺失等待决策，不自行补上。

**C. 输出格式**：改代码前必须精确说明每处改动（文件、函数、行号、旧→新代码片段）。说明后只输出改动函数的完整代码。多函数逐个说明、逐个输出。**默认不输出整个文件**，除非用户明确要求。

**D. 改原处，不包裹**：找到根源直接改，不在外部套新函数绕开原有代码。

**E. 改后变少不变多**：重复逻辑合并删除，不再调用的函数变量直接删除，中间变量只在复用 2 次以上时引入，注释只留「为什么」。

**F. 其他纪律**：

1. 读再动：先读懂代码，不靠猜测
2. 改一层只动一个文件：穿透两层须先说明原因并获用户确认
3. 参数只在 config.js：业务数字不散落其他文件
4. funds 改动必须持久化：改后立即 `saveFunds()`
5. 极端值防御：持仓为零、PE 未定锚等异常输入返回 `null` 或 `{ error: true }`，不允许 `NaN`/`undefined` 流入渲染层
6. Sortable 生命周期：`refreshData()` 后先 `destroy()` 旧实例再重建
7. 优先卖出持久化：`openHoldingDrawer` 打开前必须 `setPrioritySellCode(loadPrioritySell())` 同步
8. weight 存储类型：写入 `saveSellPlan` 前必须 `parseFloat()`，禁止字符串存入

---

## 十二、补充说明

- `todayDateStr()` 在 store.js，供所有层调用
- `_loadRaw()` 是 store.js 内部函数，`interact.js` 的 `saveHoldings` 可直接调用以一次性读取持仓全量数据
- `STORE_SELL_PLAN` 由 `saveHoldings` 和 `liveUpdateHoldingPlan` 共同维护，与持仓份额同生命周期
- `handleHoldingAction` 管理配置区展开/收起及按钮状态，`saveHoldings` 只负责数据持久化，不操作 DOM
- `fetchOff` 官方净值 TTL：19:30 前 1 小时 / 19:30 后 5 分钟 / 已是当日数据或周末 12 小时。**有意设计，不是缺陷**

---

## 十三、提交检查清单

**审查**

- [ ] 缺陷结论前已完成业务、数据、影响范围三步验证
- [ ] 未擅自补充用户未要求的功能

**架构**

- [ ] 改动前已用文字说明文件、函数、行号、旧→新代码
- [ ] 只输出改动函数，未抛出整个文件（除非被要求）
- [ ] 改的是根源，未在外部包裹补丁
- [ ] 改后代码量未增加，无死变量、无僵尸函数
- [ ] 新增函数在正确层级，无跨层调用
- [ ] 数据变更通过 store 广播驱动，未手动调渲染
- [ ] engine 外部依赖通过参数传入（config 常量和纯工具函数除外）
- [ ] 业务参数在 config.js，无硬编码
- [ ] 极端输入有防御处理
- [ ] `funds` 修改后有 `saveFunds()` 调用
- [ ] interact 层未直接操作 localStorage
- [ ] `syncCloud("push")` 在配置变更的 interact 函数中显式调用，未挂在 FUNDS 广播订阅
- [ ] weight 值以 `parseFloat()` 数字存入 sell plan

**样式**

- [ ] 动态拼接数字元素有 `class="num"`
- [ ] 颜色通过 CSS 变量，无裸色值
- [ ] 字重只用 400 / 500 / 600
- [ ] 动态 `<input>` 有完整字体和颜色声明
- [ ] 权益染色遵循第八节，`--up/--dn` 不用于权益方向
- [ ] 抽屉卡片体背景用 `var(--bg3)`，不用高饱和方向色

---

## 十四、日志诊断系统（logger.js）

破例的第10个文件，长期保留。记录本地写入和云端推送操作（函数名、时间戳、数据快照），写入独立 Log Gist（`fm_log.json`），最多200条滚动覆盖（基于实际使用数据调整，200条约覆盖10天）。未配置 LogGistID 时静默跳过。

**配置**：云同步格式 `GistID,Token,LogGistID`，Log Gist 初始内容 `[]`，与主 Gist 共用 Token。

**接入点**：store.js 的 `saveFunds`、`savePe`、`saveHoldingsData`、`saveSellPlan`、`savePrioritySell`、`clearPrioritySell`、`importSnapshot`；interact.js 的 `syncCloud doPush`。

**停用**：删除 `logger.js`、删除 `index.html` 中的 script 标签、删除 store.js 和 interact.js 中所有 `fmLog(...)` 调用行。

**`STORE_LOG_GIST_ID`、`loadLogGistId`、`saveLogGistId` 均定义在 `logger.js` 内，不迁入其他文件。**
