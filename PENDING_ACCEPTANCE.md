# 待办：市场数据网关的盘中验收（唯一未完成项）

> 建立于 2026-07-19 深夜。网关其余部分已全部验收通过并上线，**只剩这一条必须在交易日
> 盘中（9:30–15:00）才能验**。跑通后按文末「收尾」处理掉本文件。

## 一、直接执行

```bash
gh workflow run market-api-smoke.yml \
  -f base_url=https://fund-api.bailuzun.com \
  -f market_session=open
```

前置条件：**A股交易日、9:30–15:00 之间**。非盘中跑等于白跑（见下）。

查看结果：

```bash
gh run list --workflow=market-api-smoke.yml --limit 1
gh run view <run-id> --log-failed
```

## 二、这一跑到底在验什么

平时用 `market_session=closed` 跑的那 5 条腿早就绿了。`open` 会多验两件**非盘中物理上验不了**的事：

### 1. 腾讯基金估算备用（`/v1/funds/estimate?force=backup`）

**为什么非盘中验不了**：腾讯在非交易时段把估算字段清零、时间字段留空，整组必然 `unavailable`。
工作流在 `closed` 模式下会明确把这条腿标成 `UNVERIFIED` 而不是算通过——**别把那个绿灯当成验过了**。

**这里有一个未经证实的推断**：`js` 侧解析器把腾讯基金报价的 `[4]` 当作「估算时间」。
`[2]=估算净值`、`[3]=估算涨跌幅`、`[5..8]=官方净值块` 都已用实盘数据逐字段对过官方接口证实，
**唯独 `[4]` 因为采样时非交易时段一直是空字符串，没能证实**。它是按位置对称推断出来的。

若这条腿失败（`diagnostic` 里报 `incomplete_payload`），十有八九就是 `[4]` 猜错了。抓原始报文即可定位：

```bash
curl -s "https://qt.gtimg.cn/q=jj003949,jj022435" | iconv -f gbk -t utf-8
```

盘中正常的话应该能看到某个字段带时间戳。数出它是第几位（`split("~")` 后的下标），改
`workers/fund-market-api/src/parsers.mjs` 的 `parseTencentEstimates` 里 `estimateAt` 那一行，
同步改 `test/gateway.test.mjs` 里 `qqEstimates()` 夹具的对应下标。

### 2. 东财备用指数是不是延迟行情（`Compare HS300 primary and backup points` 步骤）

`market_session=open` 会自动启用这一步，比对主备两路的沪深300 点位，相对偏差需 ≤ 0.05%。

**背景**：东财唯一可达的镜像是 `push2delay`，名字里就带 delay。它现在只是**备用**（主线路是腾讯），
所以即便真是延迟源，影响也仅限于「腾讯挂掉时点位略陈旧」，不至于毁掉 PE bar——bar 锚在
1.0 总市值路，而备用本来就不给总市值。

若这步失败：说明确认是延迟源。**属于业务决策，不要自行改代码**，把实测偏差告诉用户，
由用户决定是否干脆撤掉东财备用、让指数组变成「腾讯或不可用」两态。

## 三、通过的样子

`gh run list` 显示 `success`，且日志里六条 `Checking ...` 全部形如：

```
{"ok":true,"status":"backup","source":"tencent","sourceLabel":"腾讯基金估算","count":6,"diagnostic":[]}
```

关键差异：估算备用那条从 `unavailable / count:0` 变成 `backup / count:6`，
且**不再出现** `Tencent estimate backup UNVERIFIED` 那条 warning。

## 四、收尾

跑通后：

1. 删除本文件。
2. 删除 `CLAUDE.md` 附录里指向本文件的那一行。
3. 把 `parsers.mjs` 中 `parseTencentEstimates` 上方注释里「`[2..4]` 估算」的措辞从推断改为已证实
   （若第 2 节里 `[4]` 需要修正，则一并改成实测下标）。

若第 1 或第 2 项失败，先修/先请示，**修完重跑通了再收尾**，不要留半套。

## 五、2026-07-20 盘中实测记录（观望中，未收尾）

当天两次触发（12:29 首跑失败疑似午休；13:05 午休结束后重跑仍失败）均在同一处失败：
`/v1/funds/estimate?force=backup` 返回 `{"ok":false,"status":"unavailable","diagnostic":[{"reason":"incomplete_payload"}]}`。

**已排除的假设**：不是午休（13:05 后仍失败）；不是防爬/请求头问题（换 Referer/User-Agent 无变化）；
不是文档原先怀疑的 `[4]` 字段猜错（问题出在 `[2]`/`[3]` 恒为 `0.0000`，压根走不到 `[4]`）。

**已确认的现象**：直接 `curl "https://qt.gtimg.cn/q=jj{code}"` 逐一测了 6 只基金（含债券型与股票型，
如流动性很好的 110022 易方达消费行业股票），`[2]`（估算净值）`[3]`（估算涨跌幅）**全部恒为 `0.0000`**。
同一时刻天天基金主线路（`fundgz`）能正常返回非零估算（如 022435 `estimatePct:1.04`），证明市场确实
在正常波动，问题只出在腾讯这条线本身。`parsers.mjs` 的 `estimateNav <= 0` 拒绝判据本身是对的，
没有代码 bug——是腾讯 `jj{code}` 报价接口现在不再提供实时估算字段（是否是临时故障还是已停供未知）。

**副作用**：本次因 step3 失败被 workflow 提前终止，验收清单第二项（东财备用指数是否延迟）这次
**完全没跑到**，仍未验证。

**用户决定（2026-07-20）**：先观望，过几天再找交易日盘中重跑一次，确认是否持续失活。若仍是同样的
`[2][3]` 恒零现象，再回来讨论是否要换备用源或接受估算组只剩主线路（天天基金 fundgz）没有备用兜底。
届时重跑请同时留意第二项（东财延迟对比）是否终于跑到。
