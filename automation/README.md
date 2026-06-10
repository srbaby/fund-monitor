# 旁路PE引擎（并行验证体系）

> 现有体系（hs300_daily夜间定锚 + 看板4字段插值）**原样运行不动**。
> 本目录是旁路：GitHub Actions 夜间写数据 → 看板独立算一条"旁路PE"同屏对照。
> 验证达标后再议转正（届时按 2号SOP / 9号文档规范落档）。

## 原理

```
乐咕口径恒等式：滚动PE = ∑总市值/∑滚动净利润，盈利盘中不变
  → 盘中真PE = 昨夜官方PE × (实时总市值 / 昨收总市值)
  → 百分位   = 全量历史排序数组二分查找（精确ECDF，零插值误差）
消灭两大误差源（2026-06-10实测偏差1.25pp = β弹性0.86 + 线性插值0.38）
```

## 组件

| 文件 | 职责 |
|---|---|
| `pe_nightly.py` | Actions夜间跑：抓乐咕全量PE → 排序数组+昨收锚+腾讯收盘总市值 → 写Gist `fm_pe_engine.json`；自动追加"恒等式预测 vs 官方"逐日验证日志 |
| `probe_intraday.py` | 临时探针：盘中采样腾讯/东财指数级PE与总市值字段，验证是否实时（结论敲定后连同workflow删除） |
| `../.github/workflows/pe-night-engine.yml` | 北京20:30首试 + 22:30兜底，workflow_dispatch可手动 |
| `../.github/workflows/qq-realtime-probe.yml` | 北京10:02/14:02采样 → 提交到 `probe-log.md` |

看板端：`getEnginePE`(engine.js纯函数) + `fetchQQIndex`(data.js) + `pullPeEngine`(interact.js) + PE栏下方旁路读数行(ui.js/index.html)。腾讯快照挂现有10秒行情节拍，引擎数据开机/回前台拉取（30分钟节流）。

## 一次性配置（GitHub操作）

1. 仓库 **Settings → Secrets and variables → Actions** 新增两个 secret：
   - `PE_GIST_ID`：与看板云同步用的同一个 Gist ID
   - `PE_GIST_TOKEN`：有 gist 权限的 token（可用看板现用的）
2. push 本目录与 `.github/`。Gist 里的 `fm_pe_engine.json` 由首次运行自动创建。
3. 看板端**零配置**（复用已存的 GistID/Token）。

## 验证期检查点

- `fm_pe_engine.json` 的 `log[]`：每晚自动记录 `errPp`（恒等式预测百分位 − 官方百分位）。
  连续2周 |errPp| 中位数 <0.15pp 且无 >0.5pp 离群 → 恒等式口径成立。
- 看板"旁路"行的"与现行差"：盘中观察两套读数分歧，尤其大波动日。
- `probe-log.md`：腾讯/东财字段盘中实时性判定（决定主路用指数级字段还是成分股聚合）。

## 已知边界

- 盘中财报披露改变∑E → 当日恒等式有残差，夜间重锚自动吸收（乐咕同样当晚才反映）。
- 6月/12月成分调整生效日：总市值基数跳变，errPp 会放大，属预期内，验证期注意标注。
- 若探针证明腾讯指数级总市值是收盘批处理 → 主路改为成分股实时聚合（备选方案，另行设计）。
