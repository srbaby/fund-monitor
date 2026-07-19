# -*- coding: utf-8 -*-
"""
夜间 PE 数据引擎（GitHub Actions 运行）

职责：抓取乐咕沪深300滚动 PE，把次日旁路锚（peYest / priceYest / mcapYest）
与历史 PE 排序数组写入 Gist fm_pe_engine.json，供看板 1.0 总市值路与
2.0 点位路盘中插值使用。

双路验证层已于 2026-07-19 拆除：15 个交易日的比对显示 1.0 平均绝对误差
0.41pp、从未超过 0.9pp，2.0 为 1.31pp 且 40% 的交易日超过 1pp，结论已定，
无须继续采样。2.0 保留在看板上，成分调整日 mcap 跳变时它仍是有效参照。

环境变量：
  PE_GIST_ID / PE_GIST_TOKEN
  RUN_SLOT=early|late
"""
import json
import os
import random
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

import akshare as ak

GIST_ID = os.environ["PE_GIST_ID"]
GIST_TOKEN = os.environ["PE_GIST_TOKEN"]
SLOT = os.environ.get("RUN_SLOT", "late")
GIST_FILE = "fm_pe_engine.json"

BJT = timezone(timedelta(hours=8))


def fetch_legu():
    raw = ak.stock_index_pe_lg(symbol="沪深300")
    return (
        raw[["日期", "指数", "滚动市盈率"]]
        .dropna()
        .sort_values("日期")
        .reset_index(drop=True)
    )


def fetch_qq_close():
    """腾讯接口取收盘点位、总市值（亿）与 PE_TTM；失败返回 (None, None, None)。"""
    url = f"https://qt.gtimg.cn/q=sh000300&r={random.randint(100000, 999999)}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"},
    )
    try:
        body = urllib.request.urlopen(req, timeout=10).read().decode("gbk", "ignore")
        fields = body.split("~")
        pe_qq = float(fields[39])
        mcap = float(fields[45])
        price = float(fields[3])
        return (
            (mcap if mcap > 0 else None),
            (pe_qq if pe_qq > 0 else None),
            (price if price > 0 else None),
        )
    except Exception as exc:
        print(f"⚠ 腾讯收盘快照抓取失败：{exc}")
        return None, None, None


def gist_patch(payload):
    body = json.dumps(
        {
            "files": {
                GIST_FILE: {
                    "content": json.dumps(
                        payload, ensure_ascii=False, separators=(",", ":")
                    )
                }
            }
        }
    ).encode()
    req = urllib.request.Request(
        f"https://api.github.com/gists/{GIST_ID}",
        data=body,
        method="PATCH",
        headers={
            "Authorization": f"token {GIST_TOKEN}",
            "User-Agent": "pe-engine",
            "Content-Type": "application/json",
        },
    )
    urllib.request.urlopen(req, timeout=20)


def main():
    now_bj = datetime.now(BJT)
    today_bj = now_bj.date()

    df = fetch_legu()
    last_date = str(df["日期"].iloc[-1])[:10]
    print(f"乐咕数据末行：{last_date}（{len(df)}个交易日）；北京今日：{today_bj}")

    pe_series = df["滚动市盈率"].astype(float).round(2)
    pe_sorted = sorted(pe_series.tolist())

    yesterday_bj = today_bj - timedelta(days=1)
    data_current = last_date == str(today_bj) or (
        now_bj.hour < 8 and last_date == str(yesterday_bj)
    )
    if today_bj.weekday() < 5 and not data_current:
        if SLOT == "early":
            print("⚠ 乐咕尚未更新当日数据，等待下一晚间槽位")
            return 0
        print("❌ 晚间槽位仍未取得当日数据，请人工确认")
        return 1

    official_pe = float(pe_series.iloc[-1])
    close_price = float(df["指数"].iloc[-1])
    sample_count = len(pe_series)
    official_pct = round(float((pe_series <= official_pe).sum()) / sample_count * 100, 2)
    close_mcap, qq_pe, close_price_qq = fetch_qq_close()

    version = now_bj.strftime("%Y-%m-%d %H:%M:%S")
    payload = {
        "v": version,
        "date": last_date,
        "peYest": official_pe,
        "pctYest": official_pct,
        "priceYest": close_price,          # 乐咕官方收盘点位（2.0主锚）
        "priceQQYest": close_price_qq,     # 腾讯收盘点位（参考，验证两源一致性）
        "mcapYest": close_mcap,            # 腾讯收盘总市值（1.0锚）
        "peQQYest": qq_pe,
        "n": sample_count,
        "peSorted": pe_sorted,
    }
    gist_patch(payload)
    print(f"✓ 已更新 Gist {GIST_FILE}：{last_date} 官方百分位 {official_pct:.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
