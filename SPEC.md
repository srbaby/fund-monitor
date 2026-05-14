# Jany 基金看板 · 项目规范

> 本文档是项目唯一的开发决策来源。**收到任何需求，先通读本文档，再读相关源文件，最后动手。** 不符合本规范的写法直接打回。

---

## 一、项目定位

纯原生前端，零构建工具，零框架依赖，唯一外部库：CDN 加载的 `Sortable.js`（拖拽排序）。

个人量化配置执行终端：实时推算 PE 百分位 → 对照权益映射表 → 触发信号 → 精确输出操作份额。不连接券商，只输出数字，人工执行。

**文件上限：9个，不可突破。** 禁止为任何新功能新建文件。

```
fund-monitor/
├── index.html
├── favicon.png
├── css/
│   └── style.css
└── js/
    ├── config.js      # 第1层：静态配置（常量 + 纯工具函数）
    ├── store.js       # 第2层：全局状态、存储、Observer 广播
    ├── data.js        # 第3层：网络请求与数据标准化
    ├── engine.js      # 第4层：纯函数计算引擎（依赖注入）
    ├── ui.js          # 第5层：DOM 渲染、格式化、抽屉 HTML 工厂
    ├── interact.js    # 第6层：用户事件调度器
    └── main.js        # 第7层：启动、定时器、订阅绑定（始终只有十几行）
```

脚本加载顺序固定：`config → store → data → engine → ui → interact → main`

---

## 二、分层架构

七个 JS 文件共享同一个全局作用域（`window`）。**依赖方向单向向下，下层绝对不能调用上层函数。**

```
config → store → data ─┐
                        ├→ ui → interact → main
              engine ──┘
```

`data` 与 `engine` 平级，互不依赖。

### 各层职责边界

| 层 | 核心职责 | 绝对禁止 |
|---|---|---|
| **config.js** | 所有业务常量（费率、阈值、代码、时间点、名称表、映射表）、无副作用纯工具函数（如 `isZZ500Product`） | 有副作用的函数、条件判断、业务数字散落到其他文件 |
| **store.js** | 全局内存变量、localStorage 读写、Observer 广播（`observeState` / `dispatchUpdate`）、快照导入导出、公共工具函数 | DOM 操作、网络请求、业务推演计算 |
| **data.js** | JSONP 请求、TTL 缓存、数据标准化（`fetchSingleFund`）、净值取用（`getNavByCode`）、云端读写。拿到数据后写入 store，由 store 触发广播 | DOM 操作（动态创建 `<script>` 除外）、业务计算、localStorage 读写 |
| **engine.js** | 纯函数计算：市场状态、分段线性 PE 插值、权益计算、增降权推演、今日盈亏。**所有依赖通过参数传入（依赖注入），不主动读取任何全局状态** | DOM 操作、localStorage 读写、调用 store/data 层函数 |
| **ui.js** | DOM 读写、格式化工具函数、订阅响应函数（`UI_update*`）、抽屉 HTML 工厂（`UI_render*` 只返回字符串，不直接操作 DOM） | 业务推演计算、localStorage 读写 |
| **interact.js** | 响应用户事件，协调 store/engine/ui 完成操作，管理抽屉打开/关闭，显式调用 `syncCloud` | 核心数学公式（委托 engine）、直接操作 localStorage（通过 store 函数） |
| **main.js** | 系统初始化、定时器、将 Observer 订阅与 UI 响应函数绑定。**始终只有十几行** | HTML 拼接、业务逻辑、直接 DOM 操作（事件绑定除外） |

### config.js 的纯工具函数

config.js 允许声明**无副作用、无外部依赖**的纯工具函数，供所有层调用。判断标准：函数体内只做字符串/数值运算，不读写任何外部状态。

当前收录：`isZZ500Product(name)` — 判断名称是否含「中证500」。

此类函数**不属于** store 层，迁入 config 是正确的归宿，engine 调用它不违反依赖注入规则。

---

## 三、Observer 数据驱动架构

store 扮演「广播电台」角色。数据更新时，调用方只需把数据写入 store，store 自动通知所有订阅者，UI 自动重绘。**调用方不需要、也不应该手动调用任何渲染函数。**

```
数据变化 → store.dispatchUpdate(topic)
                    ↓
        main.js 中绑定的订阅者自动响应
                    ↓
             UI_update*(...)
```

### 三个广播频道

| 频道 | 触发时机 | 对应 UI 响应函数 |
|---|---|---|
| `FUNDS` | 基金净值刷新、基金列表增删 | `UI_updateFunds()` — 重绘卡片、表格、今日盈亏、PE 栏 |
| `INDICES` | 指数行情刷新（10秒轮询） | `UI_updateIndices()` — 更新指数行情、PE 追踪点 |
| `LOCAL_CONFIG` | PE 定锚修改、持仓/降权预案/优先卖出保存 | `UI_updateLocalConfig()` — 更新 PE 栏、今日盈亏 |

```javascript
// ✅ 正确：写入 store，广播自动驱动 UI
setLastResults(results);

// ❌ 错误：写完 store 还手动调渲染，导致双重渲染
setLastResults(results);
renderAll(results);
```

### 云推送不属于广播订阅

`syncCloud("push")` 必须在**配置真正变更**时由 interact 层显式调用，不得挂在广播订阅里。原因：`FUNDS` 频道同时被净值刷新（每60秒）和列表增删触发，挂在订阅里会导致每分钟产生一次无意义的 GitHub API 调用。

正确的 push 调用点：`addFund`、`delFund`、`saveHoldings`、`confirmPe`。`LOCAL_CONFIG` 订阅因仅由配置变更触发，可保留 `syncCloud("push")`。

---

## 四、核心数据流

### 主刷新流（60秒轮询）

```
main setInterval → interact.refreshData()
    → data.fetchIndices()           // setIndices() → 广播 INDICES
    → data.fetchSingleFund() × N   // Promise.all 并发
    → store.setLastResults()        // 广播 FUNDS → UI_updateFunds()
    → Sortable 实例销毁重建
```

### 指数实时流（10秒轮询）

```
main setInterval → data.fetchIndices()
    → store.setIndices()            // 广播 INDICES → UI_updateIndices()
        → ui.renderIndices()
        → ui.updatePeBar()          // 分段线性插值实时推算 PE
```

### 本地配置变更流

```
interact.confirmPe() / saveHoldings() / toggleHoldingPriority()
    → store.savePe() / saveHoldingsData() / savePrioritySell()
        // 广播 LOCAL_CONFIG → UI_updateLocalConfig()
    → interact 显式调用 syncCloud("push" / "push_now")
```

### 持仓抽屉流（不触发广播）

```
interact.openHoldingDrawer()
    → 读取 store → engine.calc*()（依赖注入）
    → ui.UI_renderHoldingDrawerBody() 返回 HTML 字符串 → 写入抽屉 DOM
    → interact.liveUpdateHoldingPlan()
        → engine.calcCurrentEquity() / calcBuyPlanDraft() / calcSellExecutionDraft()
        → ui.UI_buildHoldingPlanHtml(activeProds, currentPE, targetEqNeutral, eqData, buyDraft, sellDraft)
        → 写入 #holdingPlanArea DOM → 打开抽屉
```

增权预研和降权预案均集成在持仓抽屉内的 `#holdingPlanArea` 容器中，随持仓数据实时更新，**没有独立的预案抽屉**。

---

## 五、engine.js 依赖注入规则

engine.js 所有函数必须是纯函数，所有外部依赖通过参数传入，不能自己读全局变量。config.js 的常量（`SYS_CONFIG`、`PE_EQUITY_TABLE` 等）和纯工具函数（`isZZ500Product`）因在全局作用域且无副作用，engine 可直接使用，不违反依赖注入。

```javascript
// ✅ 正确：外部净值函数通过参数传入
calcBuyPlanDraft(holdings, activeProducts, getNavByCode, targetEq)

// ❌ 错误：engine 内部自己调 data/store 的函数
function calcBuyPlanDraft(holdings) {
  const nav = getNavByCode(code);   // 违反依赖注入
  const pe = loadPe();              // 违反依赖注入
}
```

### engine 函数的死变量禁令

engine 函数内计算出的中间变量若不出现在 return 中、也不用于后续计算，必须删除。不允许「备用」性质的死变量存在。

---

## 六、资金规则（v7.6 方法论）

- **增权资金来源**：固定卖出兴全中长债（`CODE_XQ`）
- **增权分配**：优先买入 A500C（`CODE_A500`），单品上限 `LIMIT_A500C`；A500C 无额度时，买入当前持仓中名称含「中证500」的品种（动态识别，不硬编码代码）
- **降权优先级**（三层）：
  1. 名称含「中证500」的持仓品种（`isZZ500Product` 自动识别，最高优先，无需用户手动设置）
  2. 用户在抽屉手动标记的优先卖出品种
  3. 其余品种按用户配置的权重比例减仓
- **摩擦费率**：`SYS_CONFIG.FEE`，仅适用于混合型产品（`equity !== 0 && equity !== 1`）；纯债（equity=0）和纯股C类（equity=1）无交易费，不计入摩擦

### 中证500角色识别

中证500品种不硬编码基金代码，通过 `config.js` 的 `isZZ500Product(name)` 函数识别：**基金名称包含「中证500」即承担增权溢出和降权最高优先角色**。用户实际持有哪个中证500基金，在看板正常录入持仓即可，无需额外配置。

所有业务数字在 `config.js` 的 `SYS_CONFIG` 中定义。

### 档位目标计算规则

调仓时使用触发后的目标档位，而非当前中性档位：

- **增权触发**：目标 = `getDynamicTarget("buy", bucketStr)`（下一档，权益更高）
- **降权触发**：目标 = `getDynamicTarget("sell", bucketStr)`（上一档，权益更低）
- **资产权益汇总**：显示当前中性档目标 = `getDynamicTarget("neutral", bucketStr)`

### 档位边界兜底

`getDynamicTarget` 在最低档触发增权时（已是最高权益），返回本档 target；在最高档触发降权时（已是最低权益），返回本档 target。这是业务上的合理兜底，不是 bug。

### 净值选取规则（getNavByCode）

所有持仓品种（含纯债）均有盘中估算数据。净值选取逻辑：

- 官方净值（offVal）有效条件：offDate 不早于 estTime 日期（`offD >= estD`），或无估算时直接使用
- 否则使用盘中估算净值（estVal）

此规则与 `calcTodayProfit` 的净值判断逻辑保持一致，不允许两处出现差异。

---

## 七、store 层的 localStorage 封装规则

interact 层和 ui 层**禁止直接调用 `localStorage`**，所有 localStorage 操作必须通过 store 层的封装函数进行。

store 层须为每一类持久化数据提供完整的读/写/清三个接口。当前封装：

| 数据类型 | 读 | 写 | 清 |
|---|---|---|---|
| 基金列表 | `loadFunds()` | `saveFunds()` | — |
| PE 定锚 | `loadPe()` | `savePe()` | — |
| 持仓数据 | `loadHoldings()` / `loadHoldingsEquity()` / `loadShortNames()` | `saveHoldingsData()` | — |
| 降权预案 | `loadSellPlan()` | `saveSellPlan()` | — |
| 优先卖出 | `loadPrioritySell()` | `savePrioritySell()` | `clearPrioritySell()` |
| Gist 配置 | `loadGistConfig()` | `saveGistConfig()` | `clearGistConfig()` |

`isCloudConfigured()` 通过复用 `loadGistConfig()` 实现，不重复读 localStorage。

**授权例外**：`interact.js` 的 `saveHoldings` 可直接调用 `_loadRaw()` 一次性读取持仓全量数据，避免三次独立 load 调用。`syncCloud` push 路径直接读 `localStorage.getItem(STORE_HOLDINGS)` 跳过缓存，是有意为之（保证推送数据的实时性），不属于越层。

---

## 八、染色体系

所有权益相关的颜色必须遵循以下语义，**禁止混用**。

### CSS 变量语义

| 变量 | 颜色 | 唯一语义 |
|---|---|---|
| `--buy` | 蓝 | 增权方向（需要或正在买入） |
| `--sell` | 橙 | 降权方向（需要或正在卖出）、优先卖出标记 |
| `--up` | 红 | 行情上涨 |
| `--dn` | 绿 | 行情下跌、完成/已更新状态 |
| `--warn` | 浅红 | 方向异常警告（`wrongDir` 为 true） |
| `--t1` | 主文字 | 已对齐（偏离 < 1%）的权益值 |
| `--t2` | 次文字 | 偏离 < 1% 的偏差数字、辅助信息 |
| `--t3` | 弱文字 | 无数据、占位文字 |
| `--accent` | 主蓝 | 持仓总额、主操作按钮 |

### 当前权益染色规则

| 状态 | 条件 | 颜色 |
|---|---|---|
| 无数据 | `eqData == null` | `--t3` |
| 方向异常 | `isEquityWrongDir()` 为 true | `--warn` |
| 已对齐 | `\|diff\| < 1%` 且无异常 | `--t1` |
| 偏高需降权 | `diff >= 1%` | `--sell` |
| 偏低需增权 | `diff <= -1%` | `--buy` |

### 偏离值染色规则

| 状态 | 条件 | 颜色 |
|---|---|---|
| 无需操作 | `\|diff\| < 1%` 且无异常 | `--t2`（灰，静默） |
| 需降权 | `diff >= 1%` | `--sell` |
| 需增权 | `diff <= -1%` | `--buy` |
| 方向异常 | `wrongDir` | `--warn` |

### `isEquityWrongDir` 触发条件

高估区（PE ≥ `PE_HIGH_THRESHOLD`=65）但权益反而偏**低**超过 `EQUITY_DEV_LIMIT`，或低估区但权益反而偏**高**超过阈值，触发异常警告。

```javascript
// 高估区权益偏低 → 异常（应降没降）
peVal >= PE_HIGH_THRESHOLD && diff < -EQUITY_DEV_LIMIT
// 低估区权益偏高 → 异常（应增没增）
peVal < PE_HIGH_THRESHOLD  && diff > EQUITY_DEV_LIMIT
```

---

## 九、样式约定

样式完整定义在 `style.css` 中。以下是动态拼接 HTML 时的强制禁止清单。

**字体**：`--f-num`（AlibabaSans）用于所有数字，`--f-zh` 用于所有中文。JS 动态拼接 HTML 时 CSS 继承不可靠，每个数字元素必须内联声明或加 `class="num"`，不得遗漏。`.num { font-family: var(--f-num) }` 已在 style.css 全局定义，加 class 即可，无需重复 inline style。

**颜色**：所有颜色必须用 CSS 变量，JS 中动态颜色也必须赋值为变量字符串，禁止硬编码色值（含 hex、rgb、具名颜色）。唯一例外：遮罩层 `rgba(0,0,0,0.6)`。

**字重**：CSS 变量体系只使用 `400`、`500`、`600` 三档，禁止出现 `700` 或其他字重。

**抽屉卡片 Tab 标签**：统一使用 `tabStyle` 变量（`var(--bg3)` 底色），增权预研和降权预案 Tab 分别使用 `var(--buy-bg)` / `var(--sell-bg)` 底色 + 对应方向文字色，卡片体背景统一为 `var(--bg3)`，方向感通过数字颜色和边框传达，不通过背景高饱和色传达。

**动态 `<input>`**：不继承父级样式，必须同时声明字体、背景、边框、文字颜色，参照 `style.css` 中已有的 `input` 样式复用。

**网格边框体系**：对于多列网格（如顶部指数栏），禁止使用复杂的 `:nth-child` 配合 `border` 覆写来抹除边缘。统一使用 CSS Grid 的底色透出方案：容器设置 `gap: 1px` 和边框底色，内部单元格设置卡片底色，天然形成 1px 细线。

**护眼深色模式与防劫持**：本项目主背景与文字系统采用低饱和度的护眼调色盘（极深灰底色 + 灰白防眩光文字）。针对市场涨跌（`--up` / `--dn`），特例采用高纯度红绿色。HTML 头部已加入 `<meta name="darkreader-lock" />` 免疫外部样式劫持。除涨跌色外，其他界面元素禁止使用高亮刺眼的纯白。

---

## 十、ui.js 关键约定

- **DOM 缓存**：`_getEl(id)` 是全局 DOM 节点缓存工具，高频访问的静态节点（`todayProfit`、`todayProfitPc`、`cardHeaderBar`、`pcProfitArea`、`miniRefBtnPc` 等）必须通过它获取，禁止在渲染循环内直接调用 `getElementById`。
- **`_peDOMReady` flag**：控制 `_peDOM` 对象的一次性初始化，禁止用 `!_peDOM.display` 判断（display 为 null 时会误判）。
- **`UI_buildSummaryHtml` 签名**：`(currentPE, eqData, currentEqVal, eqCol, targetNeutralNum, inDrawer=false)`。`inDrawer=true` 时输出带圆角差异的抽屉内嵌样式，无需调用方做字符串 `.replace()`。
- **`UI_render*` 工厂函数**：只返回 HTML 字符串，不直接操作 DOM；DOM 写入由调用方（`interact.js`）负责。
- **`UI_buildHoldingPlanHtml` 的 `eqData`**：必须由 `interact.js` 的 `liveUpdateHoldingPlan` 计算后传入，ui 层禁止自行调用 `calcCurrentEquity`。
- **`renderTodayProfit` 签名**：`(results, holdings, activeProds, mktState, todayStr)`。`holdings` 和 `activeProds` 由调用方（`UI_updateFunds` / `UI_updateLocalConfig`）从 store 读取后传入，ui 层不直接调用 `loadHoldings()` 或 `getActiveProducts()`。

---

## 十一、开发铁律

### A. 审查方法论

**发现疑似问题前，必须完成以下三步验证，缺一不可：**

1. **业务验证**：对照第六节业务规则，确认「这个结果是否符合业务预期」。结构看似异常的代码（如恒为某值、循环看似无效），可能是业务设计如此。
2. **数据验证**：确认真实数据特征后再下结论。不允许基于假设的数据场景推断问题（例：「纯债无盘中估算」是错误假设，实际均有估算）。
3. **影响范围验证**：确认问题在实际运行中是否真正产生偏差，区分「逻辑看起来不一致」和「运行结果确实有误」。

**给出缺陷结论前，必须能回答：在什么具体场景下，用户会看到什么错误结果。** 无法回答则不算确认的缺陷。

### B. 功能边界

**审查只发现问题，不擅自补充功能。**

如果发现「引擎已算好但 UI 未展示」，结论是「记录为功能缺失，等待用户决策」，不是「我来补上」。未经用户确认的功能改动一律打回。

### C. 输出格式要求

**修改代码前，必须先精确说明每一处改动：**

```
修改文件：interact.js
修改函数：openPlanDrawer
第 3 行：将 `window._prioritySellCode` 替换为 `getPrioritySellCode()`
第 5 行：将 `window._prioritySellCode = loadPrioritySell()` 替换为 `setPrioritySellCode(loadPrioritySell())`
```

要求：
- **必须写出旧代码片段和新代码片段**，不允许只写「替换为 store 的函数」这类模糊描述
- **必须标明行号**（相对于函数内部的行，或文件绝对行号均可）
- 说明完毕后，只输出该函数的**完整代码**，从 `function` 到最后一个 `}`，不允许截断或省略
- 多个函数有改动时，逐个说明、逐个输出完整函数，不合并成一整块
- **默认只输出改动的函数，不输出整个文件**，只有用户明确说「输出完整文件」才输出整个文件

### D. 修改方式：改原处，不包裹

改代码必须找到问题根源直接修改，不允许在外部包裹新逻辑绕开原有代码。

```javascript
// ❌ 错误：费率算错了，在外面套一个新函数来修正
function calcBuyFixed(holdings) {
  const r = calcBuyPlanDraft(holdings, ...);
  r.buyAmt = r.buyAmt / (1 + SYS_CONFIG.FEE);
  return r;
}

// ✅ 正确：直接进 engine.js 的 calcBuyPlanDraft，找到 buyAmt 的计算行，改那一行
// 改前：const buyAmt = totalVal * (targetEq - currentEq) / 100;
// 改后：const buyAmt = totalVal * (targetEq - currentEq) / 100 / (1 + SYS_CONFIG.FEE);
```

### E. 代码优化：改后变少，不变多

每次修改后代码量应减少或持平。

- 发现重复逻辑 → 合并删除，不是再加新函数
- 不再调用的函数、变量 → 直接删除
- 中间变量只在复用 2 次以上时才引入
- 注释只留「为什么」，不留修复历史、版本标注

### F. 其他纪律

1. **读再动**：先读懂现有代码，不靠猜测改代码
2. **改一层只动一个文件**：穿透两层以上必须先说明原因，用户确认后再动手
3. **参数只在 config.js**：业务数字不允许散落在其他文件
4. **funds 改动必须持久化**：修改 `funds` 后立即调用 `saveFunds()`
5. **极端值防御**：引擎函数在持仓为零、PE 未定锚、超量分配等异常输入时返回 `null` 或 `{ error: true }`，不允许 `NaN` / `undefined` 流入渲染层
6. **Sortable 生命周期**：每次 `refreshData()` 后先 `destroy()` 旧实例再重建
7. **优先卖出持久化**：`_prioritySellCode` 是纯内存变量，`openHoldingDrawer` 必须在打开前调用 `setPrioritySellCode(loadPrioritySell())` 从 localStorage 同步，防止刷新后丢失
8. **weight 存储类型**：降权权重写入 `saveSellPlan` 前必须 `parseFloat()`，禁止以字符串存入（字符串参与 `reduce` 加法会变字符串拼接）

---

## 十二、补充说明

- `todayDateStr()` 声明在 `store.js`，供所有层调用（纯工具函数，无副作用）
- `_loadRaw()` 是 store.js 内部函数，interact.js 的 `saveHoldings` 可直接调用以一次性读取 holdings 全量数据，避免三次独立 load 调用
- `STORE_SELL_PLAN`（降权权重预案）由 `saveHoldings` 和 `liveUpdateHoldingPlan` 共同维护，保存在 localStorage，与持仓份额同生命周期
- 沪深300实时价格通过 `getIndices()["000300"]?.f2` 获取，禁止直接读 `window._rt_csi300_price`
- `handleHoldingAction` 统一管理配置区展开/收起及按钮状态，`saveHoldings` 只负责数据持久化，不操作 DOM
- `fetchOff` 官方净值 TTL：19:30 前 1 小时（等待当日净值大批发布），19:30 后 5 分钟（及时抓取），已是当日数据或周末时 12 小时。**此策略是有意设计，不是缺陷。**

---

## 十三、提交检查清单

**审查方法**

- [ ] 给出缺陷结论前已完成业务验证、数据验证、影响范围验证
- [ ] 未擅自补充用户未要求的功能
- [ ] 假设的数据场景已用真实业务逻辑核实

**架构**

- [ ] 输出前已用文字说明改哪个文件、哪个函数、改什么（旧→新，含行号）
- [ ] 只输出了改动的函数，没有抛出整个文件（除非被要求）
- [ ] 改的是问题根源，没有在外部包裹补丁
- [ ] 修改后代码总量没有增加，无死变量、无僵尸函数
- [ ] 新增函数放在正确的层级，无跨层调用
- [ ] 数据变更通过 store 广播驱动，没有手动调渲染函数
- [ ] engine 函数的外部依赖通过参数传入（config 常量和纯工具函数除外）
- [ ] 业务参数已加入 `config.js`，无硬编码
- [ ] 计算函数在极端输入下有防御处理
- [ ] `funds` 修改后有 `saveFunds()` 调用
- [ ] interact 层未直接操作 localStorage，所有读写通过 store 封装函数
- [ ] 云推送 `syncCloud("push")` 在配置变更的 interact 函数中显式调用，未挂在 FUNDS 广播订阅里
- [ ] weight 值以 `parseFloat()` 数字存入 sell plan

**样式**

- [ ] 动态拼接的数字元素有 `class="num"`（style.css 已全局定义字体，无需重复 inline）
- [ ] 颜色通过 CSS 变量引用，无裸色值、无硬编码 hex
- [ ] 字重只使用 400 / 500 / 600，无 700
- [ ] 动态创建的 `<input>` 有完整字体和颜色声明
- [ ] 权益染色遵循第八节染色体系，`--up/--dn` 不用于权益方向
- [ ] 抽屉卡片体背景使用 `var(--bg3)`，不使用高饱和方向色背景
