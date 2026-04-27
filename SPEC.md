# Jany 基金看板 · 项目规范

> 本文档是项目唯一的开发决策来源，覆盖架构分层、数据流、跨文件约定、视觉样式四个维度。所有 UI 改动和功能开发前必须先对照本文档，不符合规范的写法直接打回。

---

## 一、项目总览

纯原生前端，零构建工具，零框架依赖。唯一外部库：CDN 加载的 `Sortable.js`（拖拽排序）。

**定位**：个人量化配置执行终端。不连接券商，只输出操作数字，人工执行。

**文件总数上限：9个**（7 JS + 1 HTML + 1 CSS），禁止为新功能新建文件。

```
fund-monitor/
├── index.html
├── favicon.png
├── css/
│   └── style.css
└── js/
    ├── config.js      # 第1层：静态配置
    ├── store.js       # 第2层：状态与存储
    ├── data.js        # 第3层：网络数据
    ├── engine.js      # 第4层：计算引擎
    ├── ui.js          # 第5层：渲染
    ├── interact.js    # 第6层：控制器
    └── main.js        # 第7层：启动入口
```

---

## 二、分层架构与职责边界

七个 JS 文件通过 `index.html` 按顺序加载，共享同一个全局作用域（`window`）。**依赖方向单向向下**：上层可调用下层，下层绝对不能调用上层。

```
config.js
    ↓
store.js
    ↓
data.js  ←→  engine.js   （平级，互不依赖；engine 通过 store 读数据，data 通过 store 写结果）
    ↓              ↓
         ui.js
            ↓
       interact.js
            ↓
         main.js
```

### config.js — 静态配置层

**允许**：`const` 常量声明、对象字面量、数组字面量。

**禁止**：任何函数声明、任何逻辑计算、任何条件判断。

所有可调参数（费率、阈值、代码、时间点）必须在此声明，禁止在其他文件中硬编码业务参数。

```javascript
// ✅ 正确
const SYS_CONFIG = { FEE: 0.005, LIMIT_A500C: 0.20 };

// ❌ 错误：把配置散落在 engine.js 或 interact.js 里
const fee = 0.005;
```

### store.js — 状态与存储层

**允许**：全局内存变量声明（`funds`、`_lastResults`）、localStorage 读写封装、口令备份/恢复（`exportSnapshot`/`importSnapshot`）、公共工具函数（`getActiveProducts`）。

**禁止**：DOM 操作、网络请求、业务推演计算。

**关键约定**：

- `funds`：在此声明，修改后必须立即调用 `saveFunds()`。
- `_lastResults`：在此声明，由 `ui.js` 的 `renderAll()` 负责写入，其他层只读。
- `getActiveProducts()`：全局唯一实现，禁止在其他文件重复实现。

### data.js — 网络数据层

**允许**：JSONP 请求管理（`fetchEst`、`fetchOff`、`fetchIndices`）、内存 TTL 缓存（`offCache`）、串行请求队列（`offQ`/`drainOff`）、数据标准化输出（`fetchSingleFund`）、净值取用函数（`getNavByCode`）。

**禁止**：DOM 操作（除动态创建 `<script>` 标签外）、业务计算、localStorage 读写。

**关键约定**：

- `window._rt_csi300_price`：沪深300实时点位，由 `fetchIndices()` 写入，供 `engine.js` 读取。
- `getNavByCode(code)`：从 `_lastResults` 取最优净值（官方优先，否则估算），engine.js 通过此函数取净值，不直接读 `_lastResults`。
- 官方净值接口使用串行队列（`drainOff`），间隔 30ms 出队，防止并发触发反爬。
- 估算（`fetchEst`）和官方（`fetchOff`）并发执行，在 `fetchSingleFund` 中通过 `Promise.all` 合并。

**TTL 缓存策略**（`fetchOff`）：

| 条件               | TTL                        |
| ------------------ | -------------------------- |
| 已拿到今日官方数据 | 12 小时                    |
| 周末               | 12 小时                    |
| 19:30 以后         | 5 分钟（等待当日净值发布） |
| 其他时段           | 1 小时                     |

### engine.js — 计算引擎层

**允许**：纯函数计算——市场状态判断、Lagrange 插值推算 PE、权益计算、增权/降权推演、今日盈亏计算。

**禁止**：任何 DOM 操作、任何 localStorage 读写。所有输入通过参数传入，所有输出通过返回值传出。

**关键函数**：

| 函数                                                     | 输入                                              | 输出                                                         |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `getMarketState()`                                       | 当前系统时间                                      | `'WEEKEND'` / `'BEFORE_PRE'` / `'PRE_MARKET'` / `'TRADING'` / `'MID_BREAK'` / `'POST_MARKET'` |
| `todayDateStr()`                                         | 当前系统时间                                      | `'YYYY-MM-DD'` 字符串                                        |
| `getCurrentPE()`                                         | `loadPe()`（内部调用）+ `window._rt_csi300_price` | `{value, isDynamic, rawData, bounds}` 或 `null`              |
| `getDynamicTarget(mode)`                                 | `'buy'` / `'sell'` / `'neutral'`                  | 目标权益百分比数字或 `null`                                  |
| `calcCurrentEquity(holdings)`                            | 持仓份额对象                                      | `{equity, total}` 或 `null`                                  |
| `calcBuyPlanDraft(holdings)`                             | 持仓份额对象                                      | 增权推演结果对象或 `null`                                    |
| `calcSellExecutionDraft(holdings, ratios, priorityCode)` | 持仓、比例配置、优先品种                          | 降权推演结果对象                                             |
| `calcTodayProfit(results, holdings, mktState, todayStr)` | 基金数据、持仓、市场状态、日期                    | `{totalProfit, totalYestVal, allUpdated, hasHoldings, isWaitingForOpen}` |

**Lagrange 插值说明**：`getCurrentPE()` 用三点（买入触发点位/昨日基准点位/卖出触发点位）拟合抛物线，将实时沪深300点位映射为 PE 百分位估算值。三点重合时降级为线性插值；锚点缺失时退化为昨日静态 PE 值。

### ui.js — 渲染层

**允许**：所有 DOM 读写、CSS 类切换、HTML 字符串构建（静态部分）、格式化工具函数。

**禁止**：业务推演计算、localStorage 读写。

**格式化工具**（在此声明，供 `interact.js` 复用）：

| 函数                   | 输入        | 输出                                                |
| ---------------------- | ----------- | --------------------------------------------------- |
| `fp(v)`                | 数字或 null | `{cls: 'up'/'down'/'flat', txt: '+1.23%'}`          |
| `fmt(n, decimals)`     | 数字        | 千分位格式字符串，无效值返回 `'--'`                 |
| `fmtMoney(n)`          | 数字        | `'¥1,234.56'` 格式字符串                            |
| `getProductName(code)` | 基金代码    | 短名称，查 `SHORT_NAMES` → `PRODUCTS` → 退化为 code |

**渲染总调度 `renderAll(results)`**：写入 `_lastResults` → 调用 `updatePeBar()` → 计算闪烁状态 → 按 `funds` 顺序过滤结果集 → 调用 `renderCards()`、`renderTable()`、`renderTodayProfit()`。

**DOM 更新策略**：结构不变时只更新 `innerHTML`，结构变化（代码列表增删）时全量重建，通过比对 `currentCodes.join(',') === targetCodes.join(',')` 判断。

### interact.js — 控制器层

**允许**：响应用户事件、调用 store/data/engine 取数计算、调用 ui 渲染、管理抽屉状态、动态拼接抽屉内的 HTML。

**禁止**：核心数学计算公式（必须委托给 engine.js）、直接修改全局状态（必须通过 store 的函数操作）。

**关键函数**：

| 函数                                      | 触发来源               | 职责                                             |
| ----------------------------------------- | ---------------------- | ------------------------------------------------ |
| `refreshData()`                           | 定时器/按钮/导入口令后 | 拉取所有基金数据，调用 `renderAll()`             |
| `openHoldingDrawer()`                     | 持仓按钮               | 读取持仓和权益数据，拼接 HTML，打开抽屉          |
| `openPlanDrawer()` / `renderPlanDrawer()` | 预案按钮               | 读取增降权推演结果，拼接 HTML，打开抽屉          |
| `calcSellPreview()`                       | 降权区块输入变化       | 实时计算降权预案，更新 DOM                       |
| `exportToken()` / `importToken()`         | 口令按钮               | 调用 store 的 exportSnapshot/importSnapshot      |
| `addFund()` / `delFund()`                 | 添加/删除按钮          | 修改 funds，调用 saveFunds()，触发 refreshData() |

### main.js — 启动入口层

**允许**：系统初始化调用、`setInterval` 定时器设置、全局事件监听绑定（`visibilitychange`、`keydown`）。

**禁止**：任何 HTML 拼接、任何业务逻辑计算、任何直接 DOM 操作（事件绑定除外）。

保持极简——`main.js` 应该始终只有十几行。

---

## 三、数据流

### 主刷新流（60秒轮询）

```
main.js setInterval
    → interact.js refreshData()
        → store.js loadFunds()
        → data.js fetchIndices()        // 写 window._rt_csi300_price
        → data.js fetchSingleFund()×N  // 并发拉取所有基金
        → ui.js renderAll(results)
            → store.js _lastResults = results
            → engine.js calcTodayProfit()
            → ui.js renderCards() / renderTable() / renderTodayProfit()
```

### 指数实时流（10秒轮询）

```
main.js setInterval
    → data.js fetchIndices()
        → window._rt_csi300_price = 最新点位
        → ui.js updatePeBar()           // Lagrange 实时推算 PE
        → ui.js renderIndices(map)
```

### 持仓/预案抽屉流

```
用户点击按钮
    → interact.js openHoldingDrawer() / openPlanDrawer()
        → store.js loadHoldings() / loadPe()
        → engine.js calcCurrentEquity() / calcBuyPlanDraft() / calcSellExecutionDraft()
            → data.js getNavByCode()
        → interact.js 拼接 HTML → DOM
```

### PE 信号链

```
data.js fetchIndices() 写入 window._rt_csi300_price
    → ui.js updatePeBar()
        → engine.js getCurrentPE()      // Lagrange 插值
            → store.js loadPe()
        → engine.js getDynamicTarget('neutral')
        → ui.js 更新 PE 栏 DOM、进度条、权益偏离
```

---

## 四、跨文件共享约定

| 名称                                                 | 声明位置    | 可写位置                                           | 可读位置                              |
| ---------------------------------------------------- | ----------- | -------------------------------------------------- | ------------------------------------- |
| `funds`                                              | store.js    | store.js / interact.js（改后必须调 `saveFunds()`） | 所有层                                |
| `_lastResults`                                       | store.js    | ui.js `renderAll()`                                | data.js `getNavByCode()`、interact.js |
| `window._rt_csi300_price`                            | data.js     | data.js `fetchIndices()`                           | engine.js `getCurrentPE()`            |
| `getActiveProducts()`                                | store.js    | —                                                  | engine.js、interact.js、ui.js         |
| `getNavByCode()`                                     | data.js     | —                                                  | engine.js                             |
| `getMarketState()` / `todayDateStr()`                | engine.js   | —                                                  | ui.js、interact.js                    |
| `fmt()` / `fmtMoney()` / `fp()` / `getProductName()` | ui.js       | —                                                  | interact.js                           |
| `updatePeBar()` / `renderAll()`                      | ui.js       | —                                                  | interact.js、data.js                  |
| `refreshData()`                                      | interact.js | —                                                  | main.js、ui 按钮                      |

---

## 五、localStorage 结构

| 常量名            | Key 值                  | 存储内容                                                     |
| ----------------- | ----------------------- | ------------------------------------------------------------ |
| `STORE_CODES`     | `'fm_v20'`              | 基金代码数组 `string[]`                                      |
| `STORE_PE`        | `'jy_pe_v2_lagrange'`   | PE 定锚对象 `{bucketStr, peYest, priceAnchor, priceBuy, priceSell}` |
| `STORE_HOLDINGS`  | `'jy_holdings_v1'`      | 持仓份额对象 `{[code]: number}`                              |
| `STORE_SELL_PLAN` | `'jy_sell_plan_v1'`     | 降权减仓权重配置 `{[code]: string}`                          |
| （硬编码）        | `'jy_priority_sell_v1'` | 优先卖出品种代码，单个字符串                                 |

**口令备份格式**：`base64(encodeURIComponent(JSON.stringify({f, h, p, s})))`，其中 `f`=funds、`h`=holdings、`p`=PE定锚、`s`=降权预案。

`offCache`（官方净值缓存）仅存于内存，页面刷新后重置，不持久化。

---

## 六、API 接口

### 估算数据（JSONP）

```
https://fundgz.1234567.com.cn/js/{code}.js?rt={timestamp}
```

回调：`window.jsonpgz(data)`。字段：`gszzl` 估算涨跌%、`gsz` 估算净值、`gztime` 估算时间、`dwjz` 昨日净值（baseNav）、`jzrq` 昨日净值日期（baseDate）、`name` 基金名。

### 官方净值（JSONP，串行）

```
https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code={code}&page=1&per=1&v={timestamp}
```

回调：`window.apidata`。解析 HTML 表格：`tds[0]`=日期、`tds[1]`=净值、`tds[3]`=涨跌幅%。

### 指数行情（JSONP）

```
https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14&secids=...&cb={callback}
```

字段：`f2`=现价、`f3`=涨跌幅%、`f12`=代码、`f14`=名称。

---

## 七、`fetchSingleFund` 标准化输出结构

`interact.js` 和 `ui.js` 只消费此结构，不直接处理原始 API 响应：

```javascript
{
  code: string,
  error: boolean,
  name: string,
  estPct: number | null,    // 盘中估算涨跌幅%
  estVal: string | null,    // 估算净值
  estTime: string | null,   // 估算时间 'YYYY-MM-DD HH:mm'
  offPct: number | null,    // 官方涨跌幅%
  offVal: string | null,    // 官方净值
  offDate: string | null,   // 官方净值日期 'YYYY-MM-DD'
  baseNav: number | null,   // 昨日精确净值（盈亏计算基准）
  baseDate: string | null   // 昨日净值对应日期
}
```

---

## 八、Sortable.js 实例管理

卡片区和表格区各一个实例，声明于 `ui.js`（`cardSortable` / `tblSortable`）。每次 `refreshData()` 后先 `destroy()` 旧实例再 `Sortable.create()` 重建。拖拽结束回调（`onEnd`）从 DOM 读取新顺序写回 `funds`，调用 `saveFunds()`。

---

## 九、字体系统

### 两套字体，职责严格分离

| 变量      | 字体栈                                                       | 用途                             |
| --------- | ------------------------------------------------------------ | -------------------------------- |
| `--f-num` | Outfit → Helvetica Neue → Arial → sans-serif                 | **所有数字场景**                 |
| `--f-zh`  | -apple-system → PingFang SC → Helvetica Neue → Microsoft YaHei → sans-serif | **所有中文标签、按钮、说明文字** |

`body` 默认字体为 `--f-zh`。凡是输出数字的元素，必须显式指定 `--f-num`。

**静态 HTML**：数字容器加 `class="num"`，CSS 已声明 `.num { font-family: var(--f-num) }`。

**JS 动态拼接 HTML（`interact.js`）**：CSS 类继承不可靠，必须在每个输出数字的元素上写 `font-family:var(--f-num)`，或使用 `class="num"`。

```javascript
// ✅ 正确
`<div style="font-size:15px;font-weight:600;font-family:var(--f-num)">${value.toFixed(2)}%</div>`
`<span class="num">${shares.toFixed(2)}</span> 份`

// ❌ 错误：数字用中文字体渲染
`<div style="font-size:15px;font-weight:600">${value.toFixed(2)}%</div>`
```

**需要 `--f-num` 的场景**：金额（`fmtMoney()`）、百分比、份数、净值、点位、时间戳、基金代码、所有 `<input type="number/tel">`。

**需要 `--f-zh` 的场景**：产品名称、标签文字、按钮文字、说明段落。

### Outfit 字重

| 文件                 | font-weight |
| -------------------- | ----------- |
| OutfitRegular.woff   | 400         |
| OutfitMedium.woff    | 500         |
| OutfitSemiBold.woff  | 600         |
| OutfitExtraBold.woff | 700         |

---

## 十、颜色系统

**所有颜色必须通过 CSS 变量引用，禁止在 JS 或 CSS 规则中硬编码色值。**

### 基础令牌（`:root` 暗色默认）

| 变量              | 暗色值                   | 语义                           |
| ----------------- | ------------------------ | ------------------------------ |
| `--bg`            | `#0a0e14`                | 页面底层背景                   |
| `--bg2`           | `#111720`                | 卡片/面板背景                  |
| `--bg3`           | `#1a2130`                | 内嵌容器背景                   |
| `--bg4`           | `#1f2a3d`                | 最深层嵌套背景                 |
| `--bd`            | `rgba(255,255,255,0.07)` | 主分割线/边框                  |
| `--bd2`           | `rgba(255,255,255,0.13)` | 次级边框（输入框、按钮）       |
| `--t1`            | `#e8edf5`                | 主文字                         |
| `--t2`            | `#9aaabb`                | 次级文字                       |
| `--t3`            | `#6b7f96`                | 辅助文字/占位符                |
| `--accent`        | `#3b82f6`                | 主品牌蓝（目标权益、确认按钮） |
| `--flat`          | `#e8edf5`                | 持平状态文字色                 |
| `--sat` / `--sab` | `env(safe-area-inset-*)` | iOS 安全区                     |

### 涨跌语义色

| 变量       | 暗色值                 | 语义                       |
| ---------- | ---------------------- | -------------------------- |
| `--up`     | `#f04444`              | 上涨（A股红涨）            |
| `--up-bg`  | `rgba(240,68,68,0.12)` | 上涨背景                   |
| `--up-bd`  | `rgba(240,68,68,0.3)`  | 上涨描边                   |
| `--up-dim` | `rgba(240,68,68,0.04)` | 极淡红背景（降权区块底色） |
| `--dn`     | `#22c55e`              | 下跌（A股绿跌）            |
| `--dn-bd`  | `rgba(34,197,94,0.3)`  | 下跌描边                   |

### 业务语义色

| 变量        | 暗色值                  | 语义           | 使用场景                               |
| ----------- | ----------------------- | -------------- | -------------------------------------- |
| `--buy`     | `#60a5fa`               | 增权蓝         | 增权预案标题、目标权益、分配金额       |
| `--buy-bg`  | `rgba(59,130,246,0.08)` | 增权区块背景   | 增权容器 background                    |
| `--buy-bd`  | `rgba(59,130,246,0.25)` | 增权区块描边   | 增权容器 border                        |
| `--sell`    | `#f59e0b`               | 降权橙         | 降权预案标题、需减比例、优先按钮激活态 |
| `--sell-bg` | `rgba(245,158,11,0.08)` | 降权区块背景   | 降权优先按钮激活背景                   |
| `--sell-bd` | `rgba(245,158,11,0.25)` | 降权区块描边   | 降权优先按钮激活描边                   |
| `--warn`    | `#f87171`               | 警告红（轻量） | 方向警告、触发后降权目标、总摩擦费     |

### 浅色模式覆盖（`@media (prefers-color-scheme: light)`）

| 变量        | 浅色值                 |
| ----------- | ---------------------- |
| `--buy`     | `#2563eb`              |
| `--buy-bg`  | `rgba(37,99,235,0.08)` |
| `--buy-bd`  | `rgba(37,99,235,0.25)` |
| `--sell`    | `#d97706`              |
| `--sell-bg` | `rgba(217,119,6,0.08)` |
| `--sell-bd` | `rgba(217,119,6,0.25)` |
| `--warn`    | `#ef4444`              |
| `--up-dim`  | `rgba(220,38,38,0.04)` |

### 禁止写法

```css
/* ❌ */ color: #60a5fa;
/* ✅ */ color: var(--buy);
```

```javascript
// ❌ `style="color:#60a5fa"`
// ✅ `style="color:var(--buy)"`
```

唯一例外：遮罩层 `rgba(0,0,0,0.6)` 为通用黑色半透明，可直接写。

---

## 十一、字号体系

全局 `body` 基础字号 `14px`，不引入下表之外的字号：

| 字号   | 使用场景                         |
| ------ | -------------------------------- |
| `26px` | 卡片展开态涨跌幅（`.dh-pct`）    |
| `22px` | 表格涨跌幅（`.tbl-pct`）         |
| `20px` | 顶部时钟、PE 数值                |
| `16px` | 卡片名称、持仓输入框、汇总卡数值 |
| `15px` | 预案抽屉数值                     |
| `14px` | 基础正文、按钮、产品名称         |
| `13px` | 次级按钮、净值数据               |
| `12px` | 卡片 meta 信息、辅助说明         |
| `11px` | 标签文字、badge、时间            |
| `10px` | 最小辅助标注（单位、日期）       |
| `9px`  | "已更新"角标                     |

---

## 十二、圆角体系

| 值     | 使用场景                                     |
| ------ | -------------------------------------------- |
| `16px` | 抽屉顶角、弹窗容器                           |
| `12px` | 基金卡片、表格容器                           |
| `10px` | 抽屉内卡片、输入框容器                       |
| `8px`  | 操作按钮（`.chb-btn`）、预案内小卡片         |
| `6px`  | 小型按钮（`.del-btn`、`.tbl-del`、状态标签） |
| `50%`  | 圆点（市场状态、PE追踪标记）                 |

---

## 十三、层叠上下文（z-index）

| 值     | 元素                                 |
| ------ | ------------------------------------ |
| `1~2`  | PE 追踪轨道内部元素                  |
| `100`  | 卡片头部粘性栏（`.card-header-bar`） |
| `150`  | 底部工具栏（移动端 fixed）           |
| `200`  | 顶部 Header                          |
| `500`  | 抽屉遮罩（`.drawer-mask`）           |
| `501`  | 抽屉本体（`.drawer`）                |
| `600`  | PE 定锚弹窗（`.pe-modal`）           |
| `9999` | JS 动态创建的口令弹窗                |

新增浮层必须在此序列中选择合适层级。

---

## 十四、动效规范

| 类型         | 参数                                       | 使用场景           |
| ------------ | ------------------------------------------ | ------------------ |
| 抽屉入场     | `transform 0.3s cubic-bezier(.32,0,.67,0)` | 抽屉从底部滑入     |
| 遮罩渐显     | `opacity 0.25s`                            | 抽屉/弹窗背景遮罩  |
| PE 标记位移  | `left 0.3s, background 0.3s`               | PE 追踪点横向移动  |
| 按钮点击     | `opacity 0.15s`                            | 主操作按钮 `.tbtn` |
| 数据闪烁     | `flashUp/flashDown 0.8s ease-out`          | 涨跌数据刷新       |
| 市场开盘脉冲 | `pulse 2s infinite`                        | 市场状态绿点       |
| PE 脉冲      | `peMarkerPulse 2s infinite`                | PE 追踪标记        |

---

## 十五、响应式断点

唯一断点：`768px`

| 范围                | 布局                                         |
| ------------------- | -------------------------------------------- |
| `≤ 767px`（移动端） | 卡片视图，底部工具栏 fixed，抽屉全宽         |
| `≥ 768px`（桌面端） | 表格视图，抽屉居中最大宽 480px，卡片视图隐藏 |

---

## 十六、JS 动态拼接 HTML 规范

抽屉内容由 `interact.js` 拼接 HTML 字符串写入 DOM，CSS 类无法通过继承覆盖，必须遵守：

**字体**：输出数字的元素加 `font-family:var(--f-num)` 或 `class="num"`；中文标签默认继承 `--f-zh`，无需声明。

**颜色**：只允许 `var(--)` 引用，动态颜色变量也必须赋值为变量字符串：

```javascript
// ✅ const diffCol = wrongDir ? 'var(--warn)' : (diff > 0 ? 'var(--sell)' : 'var(--buy)');
// ❌ const diffCol = wrongDir ? '#f87171' : '#f59e0b';
```

**输入框**：所有动态创建的 `<input>` 必须同时声明 `font-family`、`background`、`border`、`color`：

```javascript
`<input style="font-family:var(--f-num);background:var(--bg);border:1px solid var(--bd2);color:var(--t1)">`
```

**增权/降权区块颜色配对**：

| 区块 | background      | border          | 标题色        | 数值色                        |
| ---- | --------------- | --------------- | ------------- | ----------------------------- |
| 增权 | `var(--buy-bg)` | `var(--buy-bd)` | `var(--buy)`  | `var(--buy)`                  |
| 降权 | `var(--up-dim)` | `var(--up-bg)`  | `var(--sell)` | `var(--sell)` / `var(--warn)` |

---

## 十七、开发铁律

1. **分层单向依赖**：下层绝对不能调用上层函数。
2. **计算在 engine，渲染在 ui，控制在 interact**：计算公式不进 `interact.js`/`ui.js`，DOM 操作不进 `engine.js`/`data.js`。
3. **改一个功能只动对应层文件**：穿透两层以上必须先说明原因。
4. **不允许新建 JS 文件**：功能扩展只能在现有 7 个文件内就地实现。
5. **参数改动只在 config.js**：不允许在其他文件硬编码业务数字。
6. **计算逻辑改动后验证极端值**：持仓为零、PE 未定锚、超量分配时，引擎函数必须返回合理的 `null` 或 `{error: true}`，不允许 NaN/undefined 流入渲染层。
7. **`funds` 修改必须立即持久化**：修改后必须跟 `saveFunds()`。

---

## 十八、新功能开发检查清单

**架构**

- [ ] 新增函数放在了正确的层级文件
- [ ] 没有跨层调用（下层调上层）
- [ ] 新增业务参数已加入 `config.js`，无硬编码
- [ ] 新增 localStorage key 已在第五节登记
- [ ] 新增跨文件共享函数/变量已在第四节登记
- [ ] 计算函数在极端输入下有防御处理
- [ ] `funds` 修改后有 `saveFunds()` 调用
- [ ] Sortable 实例在 refreshData 后有 destroy + 重建

**样式**

- [ ] 新增数字输出使用了 `--f-num` / `.num`
- [ ] 新增颜色通过 CSS 变量引用，无裸色值
- [ ] 动态拼接的 `<input>` 有完整的字体和颜色声明
- [ ] 新增 z-index 在层叠上下文表中选择了合适层级
- [ ] 新增圆角值在圆角体系内
- [ ] 新增字号在字号体系内
- [ ] 新增颜色变量在浅色模式下有覆盖值
