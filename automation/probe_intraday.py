# -*- coding: utf-8 -*-
"""
盘中数据源实时性探针（临时验证用，结论敲定后可删除本文件与对应workflow）
目的：判定 腾讯qt.gtimg / 东财push2 的指数级 PE、总市值字段是否在盘中随行情更新
方法：盘中多次采样追加到 automation/probe-log.md，对比时间戳与字段变动
基线（2026-06-10收盘）：qq时间戳20260610161404 点位4748.59 PE14.30 总市值544567.54亿
"""
import json
import random
import urllib.request
from datetime import datetime, timedelta, timezone

BJT = timezone(timedelta(hours=8))
LOG = "automation/probe-log.md"
UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"}


def fetch_qq():
    url = f"https://qt.gtimg.cn/q=sh000300&r={random.randint(100000, 999999)}"
    body = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=10).read().decode("gbk", "ignore")
    f = body.split("~")
    return {"ts": f[30], "price": f[3], "pe": f[39], "fmcap": f[44], "mcap": f[45]}


def fetch_em():
    url = (
        "https://push2.eastmoney.com/api/qt/ulist.np/get"
        f"?fltt=2&fields=f2,f3,f12,f20,f21,f9,f115&secids=1.000300&_={random.randint(100000, 999999)}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    data = json.loads(urllib.request.urlopen(req, timeout=10).read().decode())
    d = (data.get("data", {}).get("diff") or [{}])[0]
    return {"price": d.get("f2"), "pct": d.get("f3"), "mcap_f20": d.get("f20"),
            "fmcap_f21": d.get("f21"), "pe_f9": d.get("f9"), "pettm_f115": d.get("f115")}


def main():
    import os
    now_dt = datetime.now(BJT)
    now = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    plan = os.environ.get("PROBE_PLAN", "manual")  # 计划触发点(北京)，用于cron延时分析
    if plan != "manual":
        h, m = map(int, plan.split(":"))
        delay = f"{(now_dt - now_dt.replace(hour=h, minute=m, second=0, microsecond=0)).total_seconds() / 60:.1f}"
    else:
        delay = "—"
    try:
        qq = fetch_qq()
        qq_row = f"{qq['ts']} | {qq['price']} | {qq['pe']} | {qq['mcap']} | {qq['fmcap']}"
    except Exception as e:
        qq_row = f"抓取失败:{e} | | | |"
    try:
        em = fetch_em()
        em_row = f"{em['price']} | {em['mcap_f20']} | {em['fmcap_f21']} | {em['pe_f9']} | {em['pettm_f115']}"
    except Exception as e:
        em_row = f"抓取失败:{e} | | | |"

    header = (
        "# 指数级PE/总市值字段实时性探针日志\n\n"
        "基线(06-10收盘): qq ts=20260610161404, px=4748.59, PE=14.30, 总市值=544567.54亿\n\n"
        "判定: 盘中采样若 qq的ts为当日盘中时刻 且 PE/总市值随点位同步变动 → 实时确认; 若停留收盘值 → 批处理\n\n"
        "| 采样时间(北京) | 计划 | 延时(分) | qq时间戳 | qq点位 | qqPE | qq总市值(亿) | qq流通市值 | em点位f2 | em总市值f20 | em流通f21 | em f9 | em f115 |\n"
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
    )
    try:
        with open(LOG, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        content = header
    content += f"| {now} | {plan} | {delay} | {qq_row} | {em_row} |\n"
    with open(LOG, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"已采样 {now}\nqq: {qq_row}\nem: {em_row}")


if __name__ == "__main__":
    main()
