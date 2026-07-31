# Jany 基金看板 · 协作入口

> 本文件只负责导航、红线和交付检查。业务逻辑、当前架构、实现约束、开发纪律分别进入 `docs/01`–`04`；未实现且等待用户裁决的事项只进入 `docs/05`。

## 1. 文档体系

正式正文只有五篇：

| 文档 | 唯一职责 | 何时必读 |
|---|---|---|
| [docs/01-业务意图.md](docs/01-业务意图.md) | 产品为什么存在、数字回答什么问题、投资纪律与边界 | 改业务规则、信号、算量、数据口径前 |
| [docs/02-系统架构.md](docs/02-系统架构.md) | 当前组件、数据源、数据流、同步与部署关系 | 改分层、取数、网关、Worker、自动任务前 |
| [docs/03-实现约束.md](docs/03-实现约束.md) | 反直觉但必须保留的代码规则、函数边界、业务参数 | 改任何运行时代码前 |
| [docs/04-开发纪律.md](docs/04-开发纪律.md) | 审查方法、改动范围、验证与交付清单 | 实施和提交前 |
| [docs/05-未实现项.md](docs/05-未实现项.md) | 已知但尚未批准实施的能力 | 觉得“这里少功能”时 |

组件 README 只写该组件的部署、接口和运维，不重复业务逻辑：

- [workers/fund-market-api/README.md](workers/fund-market-api/README.md)
- [workers/fund-nav-collector/README.md](workers/fund-nav-collector/README.md)

不新增第六篇正式文档，不建归档目录，不恢复 `docs/DECISIONS.md`。历史原因由 Git 保存；正文只描述当前事实和仍然有效的事故教训。

## 2. 当前系统一览

```text
官方净值：
东财 FundMNFInfo ─┐
                  ├─ fund-nav-collector ─→ NAV KV ─→ /v1/nav/today ─→ 前端
腾讯 jj 官方块 ───┘

盘中行情（DATA_MODE 只控制这一条）：
direct  ─→ 浏览器直连腾讯
gateway ─→ /v1/indices ─→ 腾讯主源 / 东财备源

盘中基金估算：
最近官方净值 × BENCHMARK_PROXY 行情因子（本地计算，不是外部估值源）

PE 夜间锚：
乐咕沪深300 PE + 腾讯收盘快照 ─→ GitHub Actions ─→ Gist fm_pe_engine.json
```

完整数据源登记表以 `docs/02-系统架构.md` §2.4 为唯一说明。

## 3. 不可破坏的红线

1. **官方净值链固定**
   - 前端只读 `NAV_BASE/v1/nav/today`，不受 `DATA_MODE` 影响。
   - 真实上游是采集器服务端并行请求的东财与腾讯；浏览器不得恢复官方净值直连。
   - 百分比由相邻两次官方净值派生，禁止用百分比反推金额基准。

2. **`DATA_MODE` 只切盘中行情**
   - `direct`：浏览器一次请求腾讯，覆盖 6 个可见指数和 4 个隐藏估算因子。
   - `gateway`：前端只请求 `/v1/indices`，网关腾讯主源、东财备源。
   - 不得在两条既有分支之外新增第三条取数路径。

3. **旧数据必须可见地回退**
   - 单次失败不能清空已有行情或官方净值。
   - gateway 使用服务端 last-known-good；前端仍保留本设备快照/上一轮有效结果。
   - 任何旧值必须显示“陈旧”或“行情暂断”，不得冒充实时数据。

4. **代理不是真实估值**
   - `BENCHMARK_PROXY` 只是盘中方向代理，基准必须来自官方净值窗口。
   - 主模型必须整套完整；缺一腿就整套切 `fallbackLegs`，两套都不完整返回空值。
   - 代理不点亮“已更新”状态。

5. **两种净值口径不得混用**
   - 市值：最新可得净值。
   - 收益：交易日必须使用今日活动净值与相邻官方基准；非交易日才回退最近净值日。
   - 顶部和抽屉共同调用 `calcFundProfit`，不得复制收益判据。

6. **业务参数只在 `js/config.js`**
   - 权重、阈值、代码、费率、时点和模式开关不得散落到 data/engine/ui。
   - `BENCHMARK_PROXY` 是代理权重运行时唯一参数源。

7. **分层保持单向**
   - `config → store → data/engine → ui → interact → main`。
   - engine 保持纯函数；ui 不写 store，不触发同步。
   - 已批准的 `ui-pe.js` 只读计算例外以 `docs/03` 为准，不得扩大。

8. **配置写入和同步必须收敛**
   - interact/ui 不得绕开 store 直接写业务 localStorage。
   - `f/h/s/pr` 每条写入路径必须在 store 封装内自增配置版本。
   - 云端只采纳更高版本；本地更新时允许反向推回云端自愈。

9. **结构性改动先确认**
   - 新增/删除文件、改变目录、跨层重构、删除疑似有意机制，先说明影响边界。
   - 修复应改根因，不保留僵尸函数，不用外围 if 包住旧错误。

10. **验证与文档同步**
    - 改代理：运行 `test/proxy-estimate.test.mjs`。
    - 改网关：运行 `workers/fund-market-api/test/gateway.test.mjs`。
    - 改采集器：运行 `workers/fund-nav-collector/test/collector.test.mjs`。
    - 任何代码改动至少运行相关测试、`node --check` 和 `git diff --check`。
    - 数据源、接口、业务口径或部署方式改变时，同步更新其唯一归属文档和组件 README。

## 4. 文档维护规则

| 变化 | 更新位置 |
|---|---|
| 投资纪律、数字语义、数据可信边界 | `docs/01` |
| 组件、数据源、接口、数据流、同步关系 | `docs/02` |
| 函数判据、白名单例外、业务参数表 | `docs/03` |
| 开发和验收流程 | `docs/04` |
| 尚未获批的功能 | `docs/05` |
| Worker 部署与故障排查 | 对应 Worker README |

- 同一事实只在一个地方完整描述；其他位置用一句话加链接。
- 不在正文维护变更日志，不新增 `D-0xx` 编号。旧 `D-0xx` 仅作为 Git 历史坐标保留。
- 文档中的端点、测试数量、基金代码和文件名必须能从当前仓库验证。
- 删除机制前先查正文；正文没有解释而代码明显反直觉时，再查 Git 历史，不凭印象删除。

## 5. 项目结构与常用验证

```text
index.html / css/ / js/             原生前端
workers/fund-market-api/            Pages Functions 网关与 KV 读端点
workers/fund-nav-collector/         Cron 官方净值采集器
workers/pe-night-trigger/           夜间 PE 工作流触发器
automation/pe_nightly.py            夜间 PE 数据任务
.github/workflows/                  自动任务与网关冒烟检查
docs/                               五篇正式正文
```

```bash
node --test test/proxy-estimate.test.mjs
node --test workers/fund-market-api/test/gateway.test.mjs
node --test workers/fund-nav-collector/test/collector.test.mjs
git diff --check
```
