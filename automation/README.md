# 旁路 PE 引擎

## 给 AI 的快速上下文

本目录只验证一个问题：

> 每个交易日 15:15 固化的旁路 PE 百分位，与当晚乐咕官方 PE 百分位相差多少？

核心指标：

```text
diffPp = 15:15 bypassPct - officialPct
```

- `diffPp = 0.00` 是有效且重要的真实结果，必须保留。
- 主日志不再记录旧锚方案误差、β、点位涨跌、链路一致性等研究字段。
- 旧日志没有真实 15:15 快照，不做伪造迁移；新验证序列从部署后的首个交易日开始。
- 当前仍是并行验证体系。正式执行依据是否切换，另走方法论升级流程。

## 为什么选 15:15

场外基金需要在 15:00 前提交，旁路在盘中持续使用实时腾讯总市值计算 PE。  
15:15 行情已经收盘且腾讯总市值基本定格，适合验证同一条实时数据通道能否准确复现当晚官方结果。

该指标直接验证：

- 腾讯总市值数据是否可靠；
- 总市值恒等式是否成立；
- 看板旁路 PE 与百分位计算是否正确。

它不直接测量 14:50 到 15:00 的最后十分钟漂移。盘中执行仍读取同一条实时通道，并由方法论规定的裁量空间处理收盘前不确定性。

## 计算口径

```text
旁路 PE = 昨夜官方 PE × 15:15 实时总市值 ÷ 昨收总市值

旁路百分位
  = 历史排序数组中小于等于旁路 PE 的样本数 ÷ 样本总数
```

百分位统一使用 `(PE <= x) / n`，与看板 `getEnginePE` 和本地脚本口径一致。

## 自动化数据流

```text
前一晚 GitHub Action
  └─ 更新 Gist fm_pe_engine.json
     （官方PE、昨收总市值、历史PE排序数组）

交易日 15:15 Cloudflare Worker
  ├─ 读取 Gist 夜锚
  ├─ 抓腾讯沪深300实时总市值
  ├─ 按看板同一公式计算旁路PE和百分位
  └─ 固化到仓库 automation/pe-snapshot.json

当晚 20:30 / 21:30 / 22:00 Cloudflare Worker
  └─ 触发现有 GitHub Action
     ├─ 抓乐咕当晚官方PE和百分位
     ├─ 配对当天15:15快照
     ├─ 更新 Gist 次日锚
     └─ 写 GitHub公开精简日志 validation-log.json
```

## 文件职责

| 文件 | 职责 |
|---|---|
| `cf_worker_pe_trigger.js` | 15:15固化快照；夜间三槽触发、自愈和Bark通知 |
| `pe_nightly.py` | 获取官方值、配对快照、计算 `diffPp`、更新Gist和公开日志 |
| `pe-snapshot.json` | Worker每天覆盖写入的15:15原始事实快照 |
| `validation-log.json` | 供人和AI读取的精简验证日志 |
| `../.github/workflows/pe-night-engine.yml` | 现有Action入口，无需修改 |

## 主日志格式

`validation-log.json` 顶层仅保留版本、最新交易日、指标定义和记录数组。

完整记录：

```json
{
  "date": "2026-06-19",
  "sampleAt": "15:15:08",
  "bypassPe": 13.6800,
  "bypassPct": 65.17,
  "officialPe": 13.6800,
  "officialPct": 65.17,
  "diffPp": 0.00,
  "status": "complete"
}
```

快照缺失：

```json
{
  "date": "2026-06-19",
  "sampleAt": null,
  "bypassPe": null,
  "bypassPct": null,
  "officialPe": 13.6800,
  "officialPct": 65.17,
  "diffPp": null,
  "status": "missing_snapshot"
}
```

没有快照时严禁使用20:30数据补造15:15读数。后续若补到同日有效快照并重跑Action，同一日期记录会被幂等更新，不会追加重复项。

## 幂等与异常纪律

- 15:15重复触发：同一交易日首个有效快照已存在时跳过，不覆盖。
- 腾讯行情日期不是当天：视为非交易日或行情未更新，不生成伪快照。
- 夜间Action重复运行：按交易日覆盖同一条验证记录。
- 已形成 `complete` 的记录不会因后续临时读取失败被降级为 `missing_snapshot`。
- 乐咕尚未更新：20:30槽温和退出，后续槽重试。
- 快照缺失：明确记录 `missing_snapshot`，不推算、不补造。
- `diffPp = 0`：按字段存在性处理，绝不因真假判断而丢失。
- 跨午夜补跑：凌晨08:00前允许把前一交易日官方数据与其快照配对。
- 主日志最多保留90个交易日。

原始快照中的 `sampleAt` 是 Worker 实际抓取时间；腾讯行情自身的最后更新时间另存为 `quoteAt`。公开验证日志只保留 `sampleAt`，避免把收盘行情时间误当成快照执行时间。

## Cloudflare Worker 配置

### 变量与机密

| 名称 | 类型 | 用途 |
|---|---|---|
| `GH_REPO` | 文本 | `srbaby/fund-monitor` |
| `GH_TOKEN` | 机密 | 仓库 Contents 写入及 Actions dispatch |
| `PE_GIST_ID` | 文本 | 看板使用的 Gist ID |
| `PE_GIST_TOKEN` | 机密、可选 | Gist无法匿名读取时配置 |
| `BARK_KEY` | 机密、可选 | Bark通知 |

`GH_TOKEN` 必须同时具有：

- 仓库 Contents 读写权限；
- Actions 触发权限。

### Cron

Cloudflare Cron 使用 UTC：

```text
15 7  * * MON-FRI   北京15:15 旁路快照
30 12 * * MON-FRI   北京20:30 夜间首试
30 13 * * MON-FRI   北京21:30 夜间兜底
0 14  * * MON-FRI   北京22:00 哨兵
```

注意：Cloudflare 星期字段应使用 `MON-FRI`。

## Bark语义

成功：

```text
🟢 旁路验证完成
2026-06-19｜15:15旁路 65.17%｜晚间官方 65.17%｜偏差 +0.00pp
```

异常只报告关键断点：

- `🔴 15:15旁路快照失败`
- `🔴 15:15旁路快照缺失`
- `🔴 PE夜间官方值未写`
- `🔴 PE引擎触发失败`

## 手动入口

Worker保留带密钥的手动入口：

```text
?key=校验片段                 手动触发夜间Action
?key=校验片段&action=snapshot 手动补抓当前时刻快照
```

手动快照只适合排障。若实际时间已不是15:15，它会记录腾讯返回的真实行情时间，不能伪装成15:15验证样本。

## 部署后首次检查

1. 部署新版 Worker。
2. 新增 `PE_GIST_ID`，必要时新增 `PE_GIST_TOKEN`。
3. 新增北京15:15对应的 Cron：`15 7 * * MON-FRI`。
4. 首个交易日15:15后确认仓库 `pe-snapshot.json` 出现当天快照。
5. 当晚确认 `validation-log.json` 只有精简字段，并真实保留 `diffPp`，包括 `0.00`。
