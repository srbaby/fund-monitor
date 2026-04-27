# Jany 基金看板 · 前端设计规范

> 本文档是项目唯一的样式决策来源。所有 UI 改动、新功能开发前必须先对照本文档，不符合规范的写法在 review 时直接打回。

---

## 一、字体系统

### 两套字体，职责严格分离

| 变量 | 字体栈 | 用途 |
|---|---|---|
| `--f-num` | Outfit → Helvetica Neue → Arial → sans-serif | **所有数字场景** |
| `--f-zh` | -apple-system → PingFang SC → Helvetica Neue → Microsoft YaHei → sans-serif | **所有中文标签、按钮、说明文字** |

`body` 默认字体为 `--f-zh`。凡是输出数字的元素，必须显式指定 `--f-num`。

### 使用规则

**静态 HTML（`.html` 文件）**：对数字容器加 `class="num"`，CSS 已声明 `.num { font-family: var(--f-num) }`，不要写 inline style。

```html
<!-- ✅ 正确 -->
<span class="num">30.13%</span>
<div class="dh-pct up">+1.23%</div>   <!-- dh-pct 类已含 f-num -->

<!-- ❌ 错误：缺字体声明 -->
<span>30.13%</span>
```

**JS 动态拼接 HTML（`interact.js`）**：CSS 类继承在 innerHTML 拼接的场景中不可靠，必须在每个输出数字的元素上写 `font-family:var(--f-num)`，或使用 `class="num"`。

```javascript
// ✅ 正确：inline style 显式指定
`<div style="font-size:15px;font-weight:600;font-family:var(--f-num)">${value.toFixed(2)}%</div>`

// ✅ 正确：用 class="num"
`<span class="num">${shares.toFixed(2)}</span> 份`

// ❌ 错误：没有任何字体声明，数字会用中文字体渲染
`<div style="font-size:15px;font-weight:600">${value.toFixed(2)}%</div>`
```

**需要 `--f-num` 的典型场景**：金额（`fmtMoney()`）、百分比（`.toFixed(2) + '%'`）、份数（`.toFixed(2) + ' 份'`）、净值、点位、时间戳、基金代码、所有 `<input type="number/tel">` 输入框。

**需要 `--f-zh` 的典型场景**：产品名称、标签文字（"持仓"、"权益"、"减仓权重"）、按钮文字、说明段落。

### Outfit 字重文件

| 文件 | font-weight |
|---|---|
| OutfitRegular.woff | 400 |
| OutfitMedium.woff | 500 |
| OutfitSemiBold.woff | 600 |
| OutfitExtraBold.woff | 700 |

---

## 二、颜色系统

### 所有颜色必须通过 CSS 变量引用，禁止在 JS 或 CSS 规则中硬编码色值

#### 基础令牌（`:root` 暗色默认）

| 变量 | 暗色值 | 语义 |
|---|---|---|
| `--bg` | `#0a0e14` | 页面底层背景 |
| `--bg2` | `#111720` | 卡片/面板背景 |
| `--bg3` | `#1a2130` | 内嵌容器背景 |
| `--bg4` | `#1f2a3d` | 最深层嵌套背景 |
| `--bd` | `rgba(255,255,255,0.07)` | 主分割线/边框 |
| `--bd2` | `rgba(255,255,255,0.13)` | 次级边框（输入框、按钮） |
| `--t1` | `#e8edf5` | 主文字 |
| `--t2` | `#9aaabb` | 次级文字 |
| `--t3` | `#6b7f96` | 辅助文字/占位符 |
| `--accent` | `#3b82f6` | 主品牌蓝（目标权益、确认按钮） |
| `--flat` | `#e8edf5` | 持平状态文字色 |
| `--sat` | `env(safe-area-inset-top)` | iOS 顶部安全区 |
| `--sab` | `env(safe-area-inset-bottom)` | iOS 底部安全区 |

#### 涨跌语义色

| 变量 | 暗色值 | 语义 |
|---|---|---|
| `--up` | `#f04444` | 上涨/卖出份数（A股红涨） |
| `--up-bg` | `rgba(240,68,68,0.12)` | 上涨背景（边框级） |
| `--up-bd` | `rgba(240,68,68,0.3)` | 上涨描边 |
| `--up-dim` | `rgba(240,68,68,0.04)` | 极淡红背景（降权区块底色） |
| `--dn` | `#22c55e` | 下跌/操作后绿（A股绿跌） |
| `--dn-bd` | `rgba(34,197,94,0.3)` | 下跌描边 |

#### 业务语义色

| 变量 | 暗色值 | 语义 | 使用场景 |
|---|---|---|---|
| `--buy` | `#60a5fa` | 增权蓝 | 增权预案标题、目标权益数字、分配金额 |
| `--buy-bg` | `rgba(59,130,246,0.08)` | 增权区块背景 | 增权区块容器 background |
| `--buy-bd` | `rgba(59,130,246,0.25)` | 增权区块描边 | 增权区块容器 border |
| `--sell` | `#f59e0b` | 降权橙 | 降权预案标题、需减比例、降权标签、优先按钮激活态 |
| `--sell-bg` | `rgba(245,158,11,0.08)` | 降权区块背景 | 降权优先按钮激活背景 |
| `--sell-bd` | `rgba(245,158,11,0.25)` | 降权区块描边 | 降权优先按钮激活描边 |
| `--warn` | `#f87171` | 警告红（轻量） | 方向警告、触发后降权目标、总摩擦费 |

#### 浅色模式覆盖（`@media (prefers-color-scheme: light)`）

浅色模式下业务语义色同步加深以保证对比度：

| 变量 | 浅色值 |
|---|---|
| `--buy` | `#2563eb` |
| `--buy-bg` | `rgba(37,99,235,0.08)` |
| `--buy-bd` | `rgba(37,99,235,0.25)` |
| `--sell` | `#d97706` |
| `--sell-bg` | `rgba(217,119,6,0.08)` |
| `--sell-bd` | `rgba(217,119,6,0.25)` |
| `--warn` | `#ef4444` |
| `--up-dim` | `rgba(220,38,38,0.04)` |

#### 禁止出现的写法

```css
/* ❌ 禁止：直接写色值 */
color: #60a5fa;
background: rgba(59,130,246,0.15);

/* ✅ 正确：引用变量 */
color: var(--buy);
background: var(--buy-bg);
```

```javascript
// ❌ 禁止：JS 里硬编码颜色
`style="color:#60a5fa"`
`style="background:rgba(59,130,246,.15)"`

// ✅ 正确：通过变量引用
`style="color:var(--buy)"`
`style="background:var(--buy-bg)"`
```

唯一例外：遮罩层背景 `rgba(0,0,0,0.6)` 为通用黑色半透明，不属于主题色，可直接写。

---

## 三、字号体系

全局 `body` 基础字号为 `14px`。以下是项目中实际使用的字号及对应场景：

| 字号 | 使用场景 |
|---|---|
| `26px` | 卡片展开态涨跌幅（`.dh-pct`） |
| `22px` | 表格涨跌幅（`.tbl-pct`） |
| `20px` | 顶部时钟、PE 数值 |
| `16px` | 卡片名称、持仓份额输入框、汇总卡数值 |
| `15px` | 预案抽屉数值 |
| `14px` | 基础正文、按钮、产品名称 |
| `13px` | 次级按钮、净值数据 |
| `12px` | 卡片 meta 信息、辅助说明 |
| `11px` | 标签文字、badge、时间 |
| `10px` | 最小辅助标注（单位、日期、占位说明） |
| `9px` | "已更新"角标 |

不要引入上表之外的字号。

---

## 四、圆角体系

| 值 | 使用场景 |
|---|---|
| `16px` | 抽屉顶角、弹窗容器 |
| `12px` | 基金卡片（`.fund-card`）、表格容器 |
| `10px` | 抽屉内卡片、输入框容器、PE弹窗输入框 |
| `8px` | 操作按钮（`.chb-btn`）、预案内小卡片 |
| `6px` | 小型按钮（`.del-btn`、`.tbl-del`、状态标签） |
| `50%` | 圆点（市场状态、PE追踪标记） |

---

## 五、层叠上下文（z-index）

| 值 | 元素 |
|---|---|
| `1~2` | PE 追踪轨道内部元素 |
| `100` | 卡片头部粘性栏（`.card-header-bar`） |
| `150` | 底部工具栏（移动端 fixed） |
| `200` | 顶部 Header |
| `500` | 抽屉遮罩（`.drawer-mask`） |
| `501` | 抽屉本体（`.drawer`） |
| `600` | PE 定锚弹窗（`.pe-modal`） |
| `9999` | JS 动态创建的口令弹窗 |

新增浮层必须在此序列中选择合适层级，不允许随意使用 `9999`。

---

## 六、动效规范

| 类型 | 参数 | 使用场景 |
|---|---|---|
| 抽屉入场 | `transform 0.3s cubic-bezier(.32,0,.67,0)` | 抽屉从底部滑入 |
| 遮罩渐显 | `opacity 0.25s` | 抽屉/弹窗背景遮罩 |
| PE 标记位移 | `left 0.3s, background 0.3s` | PE 追踪点横向移动 |
| 按钮点击 | `opacity 0.15s` | 主操作按钮 `.tbtn` |
| 数据闪烁 | `flashUp/flashDown 0.8s ease-out` | 涨跌数据刷新 |
| 市场开盘脉冲 | `pulse 2s infinite` | 市场状态绿点 |
| PE 脉冲 | `peMarkerPulse 2s infinite` | PE 追踪标记 |

---

## 七、响应式断点

唯一断点：`768px`

| 范围 | 布局 |
|---|---|
| `≤ 767px`（移动端） | 卡片视图，底部工具栏 fixed，抽屉全宽 |
| `≥ 768px`（桌面端） | 表格视图，抽屉居中最大宽 480px，卡片视图隐藏 |

---

## 八、JS 动态拼接 HTML 规范

抽屉和预案面板的内容由 `interact.js` 拼接 HTML 字符串写入 DOM，这是该项目的特殊场景，CSS 类无法通过继承覆盖，需遵守以下规则：

### 8.1 字体

- 所有输出数字的元素：加 `font-family:var(--f-num)` 或 `class="num"`
- 所有中文标签元素：默认继承 `body` 的 `--f-zh`，无需额外声明

### 8.2 颜色

- 只允许使用 `var(--)` 引用，禁止直接写色值
- 动态颜色变量（如 `diffCol`）也必须赋值为 `var(--)` 字符串：

```javascript
// ✅ 正确
const diffCol = wrongDir ? 'var(--warn)' : (diff > 0 ? 'var(--sell)' : 'var(--buy)');

// ❌ 错误
const diffCol = wrongDir ? '#f87171' : '#f59e0b';
```

### 8.3 输入框

所有动态创建的 `<input>` 必须同时声明：
- `font-family:var(--f-num)`（数字输入框）或 `--f-zh`（文本）
- `background:var(--bg)` 或 `var(--bg3)`
- `border:1px solid var(--bd2)`
- `color:var(--t1)`

### 8.4 增权/降权区块颜色配对

| 区块 | background | border | 标题文字色 | 数值色 |
|---|---|---|---|---|
| 增权 | `var(--buy-bg)` | `var(--buy-bd)` | `var(--buy)` | `var(--buy)` |
| 降权 | `var(--up-dim)` | `var(--up-bg)` | `var(--sell)` | `var(--sell)` / `var(--warn)` |

---

## 九、CSS 自身规范

- 所有颜色通过 `:root` 变量声明，CSS 规则体中禁止出现裸色值
- 浅色模式在 `@media(prefers-color-scheme:light)` 的 `:root` 覆盖块中统一声明，不单独为某个选择器写浅色覆盖（已有的 `.header`、`.toolbar`、`.card-header-bar` 三处 `background` 覆盖是必要例外，因为它们使用了带透明度的背景值）
- 新增颜色语义时，同步在暗色 `:root` 和浅色 `@media` 两处都加上

---

## 十、新功能开发检查清单

每次提交涉及 UI 的改动，对照以下清单自查：

- [ ] 新增数字输出是否使用了 `--f-num` / `.num`
- [ ] 新增颜色是否通过 CSS 变量引用，无裸色值
- [ ] 动态拼接的 `<input>` 是否有完整的字体和颜色声明
- [ ] 新增 z-index 是否在层叠上下文表中选择了合适的层级
- [ ] 新增圆角值是否在圆角体系内
- [ ] 新增字号是否在字号体系内
- [ ] 颜色变量是否在浅色模式下也有覆盖值
