# Jany 基金看板 · 架构规范

> 本文档描述项目的文件结构、层级职责、数据流、跨文件约定，以及所有开发必须遵守的架构铁律。涉及样式的部分见 `DESIGN_SPEC.md`。

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
const fee = 0.005; // 写在 engine.js 里
```

### store.js — 状态与存储层

**允许**：全局内存变量声明（`funds`、`_lastResults`）、localStorage 读写封装、口令备份/恢复（`exportSnapshot`/`importSnapshot`）、公共工具函数（`getActiveProducts`）。

**禁止**：DOM 操作、网络请求、业务推演计算。

**关键约定**：
- `funds`（基金代码列表）：在此声明，修改后必须立即调用 `saveFunds()`。
- `_lastResults`（上次拉取的基金数据）：在此声明，由 `ui.js` 的 `renderAll()` 负责写入。任何层都可以读，但只有 `renderAll()` 写。
- `getActiveProducts()`：全局唯一实现，禁止在其他文件重复实现。

### data.js — 网络数据层

**允许**：JSONP 请求管理（`fetchEst`、`fetchOff`、`fetchIndices`）、内存 TTL 缓存（`offCache`）、串行请求队列（`offQ`/`drainOff`）、数据标准化输出（`fetchSingleFund`）、净值取用函数（`getNavByCode`）。

**禁止**：DOM 操作（除动态创建 `<script>` 标签外）、业务计算、localStorage 读写。

**关键约定**：
- `window._rt_csi300_price`：沪深300实时点位，由 `fetchIndices()` 写入，供 `engine.js` 的 `getCurrentPE()` 读取。
- `getNavByCode(code)`：从 `_lastResults` 中取当前最优净值（官方优先，否则估算）。engine.js 调用此函数，不直接读 `_lastResults`。
- `offCache`：内存缓存，页面刷新后重置，属正常行为。
- 官方净值接口使用串行队列（`drainOff`），防止并发请求触发反爬限制；间隔 30ms 出队。
- 估算接口（`fetchEst`）和官方接口（`fetchOff`）并发执行，在 `fetchSingleFund` 中通过 `Promise.all` 合并。

**TTL 缓存策略**（`fetchOff`）：

| 条件 | TTL |
|---|---|
| 已拿到今日官方数据 | 12 小时 |
| 周末 | 12 小时 |
| 19:30 以后 | 5 分钟（等待当日净值发布） |
| 其他时段 | 1 小时 |

### engine.js — 计算引擎层

**允许**：纯函数计算——市场状态判断、Lagrange 插值推算 PE、权益计算、增权/降权推演、今日盈亏计算。

**禁止**：任何 DOM 操作、任何 localStorage 读写。所有输入通过参数传入，所有输出通过返回值传出。

**关键函数**：

| 函数 | 输入 | 输出 |
|---|---|---|
| `getMarketState()` | 当前系统时间 | `'WEEKEND'`/`'BEFORE_PRE'`/`'PRE_MARKET'`/`'TRADING'`/`'MID_BREAK'`/`'POST_MARKET'` |
| `todayDateStr()` | 当前系统时间 | `'YYYY-MM-DD'` 字符串 |
| `getCurrentPE()` | `loadPe()`（内部调用）+ `window._rt_csi300_price` | `{value, isDynamic, rawData, bounds}` 或 `null` |
| `getDynamicTarget(mode)` | `'buy'`/`'sell'`/`'neutral'` | 目标权益百分比数字或 `null` |
| `calcCurrentEquity(holdings)` | 持仓份额对象 | `{equity, total}` 或 `null` |
| `calcBuyPlanDraft(holdings)` | 持仓份额对象 | 增权推演结果对象或 `null` |
| `calcSellExecutionDraft(holdings, ratios, priorityCode)` | 持仓、比例配置、优先品种 | 降权推演结果对象 |
| `calcTodayProfit(results, holdings, mktState, todayStr)` | 基金数据、持仓、市场状态、日期 | `{totalProfit, totalYestVal, allUpdated, hasHoldings, isWaitingForOpen}` |

**Lagrange 插值说明**：`getCurrentPE()` 用三点（买入触发点位/昨日基准点位/卖出触发点位）拟合抛物线，将实时沪深300点位映射为 PE 百分位估算值。三点重合时降级为线性插值；所有锚点缺失时退化为昨日静态 PE 值。

### ui.js — 渲染层

**允许**：所有 DOM 读写、CSS 类切换、HTML 字符串构建（静态部分）、格式化工具函数。

**禁止**：业务推演计算、localStorage 读写。

**格式化工具**（在此声明，供 `interact.js` 复用）：

| 函数 | 输入 | 输出 |
|---|---|---|
| `fp(v)` | 数字或 null | `{cls: 'up'/'down'/'flat', txt: '+1.23%'}` |
| `fmt(n, decimals)` | 数字 | 千分位格式字符串，`--` 表示无效值 |
| `fmtMoney(n)` | 数字 | `'¥1,234.56'` 格式字符串 |
| `getProductName(code)` | 基金代码 | 短名称，查 `SHORT_NAMES` 后查 `PRODUCTS`，最后退化为 code |

**渲染总调度 `renderAll(results)`**：

1. 写入 `_lastResults = results`
2. 调用 `updatePeBar()`
3. 计算闪烁状态 `calcFlash(results)`
4. 按 `funds` 顺序过滤出 UI 结果集
5. 调用 `renderCards()`、`renderTable()`、`renderTodayProfit()`

**DOM 更新策略**：结构不变时只更新 `innerHTML`，结构变化（代码列表增删）时全量重建。通过比对 `currentCodes.join(',') === targetCodes.join(',')` 判断。

### interact.js — 控制器层

**允许**：响应用户事件、调用 store/data/engine 取数计算、调用 ui 渲染、管理抽屉状态、动态拼接抽屉内的 HTML。

**禁止**：核心数学计算公式（必须委托给 engine.js）、直接修改 `funds`/`_lastResults` 等全局状态（必须通过 store 的函数操作）。

**关键函数**：

| 函数 | 触发来源 | 职责 |
|---|---|---|
| `refreshData()` | 定时器/按钮/导入口令后 | 拉取所有基金数据，调用 `renderAll()` |
| `openHoldingDrawer()` | 持仓按钮 | 读取持仓和权益数据，拼接 HTML，打开抽屉 |
| `openPlanDrawer()` / `renderPlanDrawer()` | 预案按钮 | 读取增降权推演结果，拼接 HTML，打开抽屉 |
| `calcSellPreview()` | 降权区块输入变化 | 实时计算降权预案，更新 DOM |
| `exportToken()` / `importToken()` | 口令按钮 | 调用 store 的 exportSnapshot/importSnapshot |
| `addFund()` / `delFund()` | 添加/删除按钮 | 修改 funds，调用 saveFunds()，触发 refreshData() |

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
        → store.js loadFunds()          // 读取基金列表
        → data.js fetchIndices()        // 拉取指数（写 window._rt_csi300_price）
        → data.js fetchSingleFund()×N  // 并发拉取所有基金（est + off）
        → ui.js renderAll(results)      // 渲染卡片/表格/盈亏
            → store.js _lastResults = results
            → engine.js calcTodayProfit()
            → ui.js renderCards() / renderTable() / renderTodayProfit()
```

### 指数实时流（10秒轮询）

```
main.js setInterval
    → data.js fetchIndices()
        → window._rt_csi300_price = 最新点位
        → ui.js updatePeBar()           // 立即更新 PE 栏（Lagrange 实时推算）
        → ui.js renderIndices(map)      // 更新指数栏显示
```

### 持仓/预案抽屉流

```
用户点击按钮
    → interact.js openHoldingDrawer() / openPlanDrawer()
        → store.js loadHoldings() / loadPe()
        → engine.js calcCurrentEquity() / calcBuyPlanDraft() / calcSellExecutionDraft()
            → data.js getNavByCode()    // engine 通过此函数取净值
        → interact.js 拼接 HTML → DOM
```

### PE 信号链

```
data.js fetchIndices() 写入 window._rt_csi300_price
    → ui.js updatePeBar()
        → engine.js getCurrentPE()
            → store.js loadPe()         // 读取用户定锚的三点坐标
            → Lagrange 插值推算实时 PE
        → engine.js getDynamicTarget('neutral')
        → ui.js 更新 PE 栏 DOM、进度条、权益偏离显示
```

---

## 四、跨文件共享约定

以下变量和函数是跨文件共享的"接口"，修改时必须通知所有使用方：

| 名称 | 声明位置 | 可写位置 | 可读位置 |
|---|---|---|---|
| `funds` | store.js | store.js（通过 `loadFunds`/`saveFunds`）、interact.js（增删后必须调 `saveFunds()`） | 所有层 |
| `_lastResults` | store.js | ui.js `renderAll()` | data.js `getNavByCode()`、interact.js |
| `window._rt_csi300_price` | data.js | data.js `fetchIndices()` | engine.js `getCurrentPE()` |
| `getActiveProducts()` | store.js | — | engine.js、interact.js、ui.js |
| `getNavByCode()` | data.js | — | engine.js |
| `getMarketState()` / `todayDateStr()` | engine.js | — | ui.js、interact.js |
| `fmt()` / `fmtMoney()` / `fp()` / `getProductName()` | ui.js | — | interact.js |
| `updatePeBar()` / `renderAll()` | ui.js | — | interact.js、data.js（`fetchIndices` 内直接调用） |
| `refreshData()` | interact.js | — | main.js、ui 按钮 |

---

## 五、localStorage 结构

| Key（常量名） | 常量值 | 存储内容 |
|---|---|---|
| `STORE_CODES` | `'fm_v20'` | 基金代码数组 `string[]` |
| `STORE_PE` | `'jy_pe_v2_lagrange'` | PE 定锚对象 `{bucketStr, peYest, priceAnchor, priceBuy, priceSell}` |
| `STORE_HOLDINGS` | `'jy_holdings_v1'` | 持仓份额对象 `{[code]: number}` |
| `STORE_SELL_PLAN` | `'jy_sell_plan_v1'` | 降权减仓权重配置 `{[code]: string}` |
| `'jy_priority_sell_v1'` | （硬编码字符串） | 优先卖出品种代码，单个字符串 |

**口令备份格式**：`base64(encodeURIComponent(JSON.stringify({f, h, p, s}))))`，其中 `f`=funds、`h`=holdings、`p`=PE定锚、`s`=降权预案。

**注意**：`offCache`（官方净值缓存）仅存于内存，页面刷新后重置，不持久化。

---

## 六、API 接口

### 估算数据（JSONP）

```
https://fundgz.1234567.com.cn/js/{code}.js?rt={timestamp}
```
回调函数：`window.jsonpgz(data)`

返回字段使用：`gszzl`（估算涨跌%）、`gsz`（估算净值）、`gztime`（估算时间）、`dwjz`（昨日净值 baseNav）、`jzrq`（昨日净值日期 baseDate）、`name`（基金名）。

### 官方净值（JSONP，串行）

```
https://fund.eastmoney.com/f10/F10DataApi.aspx?type=lsjz&code={code}&page=1&per=1&v={timestamp}
```
回调：`window.apidata`（JSONP 挂载到 window）

解析：从 HTML 表格中提取 `tds[0]`=日期、`tds[1]`=净值、`tds[3]`=涨跌幅%。

### 指数行情（JSONP）

```
https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14&secids=...&cb={callback}
```
字段：`f2`=现价、`f3`=涨跌幅%、`f12`=代码、`f14`=名称。

---

## 七、`fetchSingleFund` 标准化输出结构

`interact.js` 和 `ui.js` 只消费此标准结构，不直接处理原始 API 响应：

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
  baseNav: number | null,   // 昨日精确净值（用于盈亏计算基准）
  baseDate: string | null   // 昨日净值对应日期
}
```

---

## 八、Sortable.js 实例管理

卡片区和表格区各一个 Sortable 实例，声明于 `ui.js`：

```javascript
let cardSortable = null;
let tblSortable  = null;
```

每次 `refreshData()` 后：先调用 `destroy()` 销毁旧实例，再调用 `Sortable.create()` 重建。拖拽结束回调（`onEnd`）：从 DOM 读取新顺序写回 `funds`，调用 `saveFunds()`。

---

## 九、开发铁律

**1. 分层单向依赖**：不允许下层调用上层函数。违反一次，代码整个打回。

**2. 计算在 engine，渲染在 ui，控制在 interact**：任何计算公式不允许出现在 `interact.js` 或 `ui.js`；任何 DOM 操作不允许出现在 `engine.js` 或 `data.js`。

**3. 改一个功能只动对应层的文件**：若需要同时穿透两个以上文件，必须先说明原因，确认后再动手。

**4. 不允许擅自新建 JS 文件**：如果功能扩展或软件架构需要新建js文件，应先和用户协商确认。

**5. 参数改动必须只在 config.js**：费率、阈值、品种代码、时间参数改了 config，engine 自动生效，不允许在其他文件里硬编码数字。

**6. 修改计算逻辑后必须验证极端值**：持仓为零、PE 未定锚、超量分配、三点重合时，引擎函数必须返回合理的 null 或 `{error: true}`，不允许出现 NaN 或 undefined 流入渲染层。

**7. `funds` 修改必须立即持久化**：任何改变 `funds` 的操作后面必须跟 `saveFunds()`，不允许只改内存不写存储。

---

## 十、新功能开发检查清单

- [ ] 新增函数放在了正确的层级文件中
- [ ] 没有跨层直接调用（下层调上层）
- [ ] 新增业务参数已加入 `config.js`，没有在其他文件硬编码
- [ ] 新增 localStorage 存储已在本文档第五节登记
- [ ] 新增跨文件共享函数/变量已在本文档第四节登记
- [ ] 计算函数在极端输入下（null、0、空对象）有防御处理
- [ ] `funds` 修改后有 `saveFunds()` 调用
- [ ] Sortable 实例在 refreshData 后有 destroy + 重建
