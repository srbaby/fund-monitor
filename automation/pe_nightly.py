# -*- coding: utf-8 -*-
"""
夜间 PE 数据引擎（GitHub Actions 运行）

职责：
1. 抓取乐咕沪深300滚动 PE，更新次日旁路锚与历史排序数组；
2. 将当天 15:15 固化的旁路快照，与当晚官方 PE 百分位配对；
3. 生成只回答一个问题的验证日志：
   diffPp = 15:15 旁路 PE 百分位 - 当晚官方 PE 百分位。

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
from pathlib import Path

import akshare as ak

GIST_ID = os.environ["PE_GIST_ID"]
GIST_TOKEN = os.environ["PE_GIST_TOKEN"]
SLOT = os.environ.get("RUN_SLOT", "late")
GIST_FILE = "fm_pe_engine.json"
SNAPSHOT_FILE = Path("automation/pe-snapshot.json")
PUBLIC_LOG_FILE = Path("automation/validation-log.json")
LOG_KEEP = 90

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
    """腾讯接口取收盘总市值（亿）与 PE_TTM；失败返回 (None, None)。"""
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
        return (mcap if mcap > 0 else None), (pe_qq if pe_qq > 0 else None)
    except Exception as exc:
        print(f"⚠ 腾讯收盘快照抓取失败：{exc}")
        return None, None


def gist_get():
    req = urllib.request.Request(
        f"https://api.github.com/gists/{GIST_ID}",
        headers={"Authorization": f"token {GIST_TOKEN}", "User-Agent": "pe-engine"},
    )
    data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    item = data.get("files", {}).get(GIST_FILE)
    if not item:
        return None
    try:
        return json.loads(item["content"])
    except Exception:
        return None


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


def load_snapshot():
    try:
        return json.loads(SNAPSHOT_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def clean_log(raw_log):
    """
    只保留新口径记录。旧日志没有真实 15:15 快照，不能伪装迁移。
    """
    cleaned = []
    for item in raw_log or []:
        if not isinstance(item, dict):
            continue
        if item.get("status") not in {"complete", "missing_snapshot"}:
            continue
        if not item.get("date") or "officialPct" not in item:
            continue
        cleaned.append(item)
    return cleaned[-LOG_KEEP:]


def build_validation_entry(trade_date, official_pe, official_pct, snapshot):
    if snapshot and snapshot.get("date") == trade_date:
        required = ("sampleAt", "bypassPe", "bypassPct")
        if all(snapshot.get(key) is not None for key in required):
            bypass_pct = round(float(snapshot["bypassPct"]), 2)
            return {
                "date": trade_date,
                "sampleAt": snapshot["sampleAt"],
                "bypassPe": round(float(snapshot["bypassPe"]), 4),
                "bypassPct": bypass_pct,
                "officialPe": round(float(official_pe), 4),
                "officialPct": round(float(official_pct), 2),
                "diffPp": round(bypass_pct - float(official_pct), 2),
                "status": "complete",
            }

    return {
        "date": trade_date,
        "sampleAt": None,
        "bypassPe": None,
        "bypassPct": None,
        "officialPe": round(float(official_pe), 4),
        "officialPct": round(float(official_pct), 2),
        "diffPp": None,
        "status": "missing_snapshot",
    }


def upsert_log(log, entry):
    existing = next(
        (item for item in log if item.get("date") == entry["date"]), None
    )
    if (
        existing
        and existing.get("status") == "complete"
        and entry.get("status") == "missing_snapshot"
    ):
        return log[-LOG_KEEP:]
    result = [item for item in log if item.get("date") != entry["date"]]
    result.append(entry)
    result.sort(key=lambda item: item["date"])
    return result[-LOG_KEEP:]


def write_public_log(version, trade_date, log):
    payload = {
        "v": version,
        "date": trade_date,
        "metric": "diffPp = 15:15 bypassPct - officialPct",
        "log": log,
    }
    PUBLIC_LOG_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"✓ 已写精简验证日志：{PUBLIC_LOG_FILE}（{len(log)}条）")


def main():
    now_bj = datetime.now(BJT)
    today_bj = now_bj.date()

    df = fetch_legu()
    last_date = str(df["日期"].iloc[-1])[:10]
    print(f"乐咕数据末行：{last_date}（{len(df)}个交易日）；北京今日：{today_bj}")

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

    previous = gist_get() or {}
    pe_series = df["滚动市盈率"].astype(float).round(2)
    official_pe = float(pe_series.iloc[-1])
    close_price = float(df["指数"].iloc[-1])
    sample_count = len(pe_series)
    official_pct = round(float((pe_series <= official_pe).sum()) / sample_count * 100, 2)
    pe_sorted = sorted(pe_series.tolist())
    close_mcap, qq_pe = fetch_qq_close()

    snapshot = load_snapshot()
    entry = build_validation_entry(last_date, official_pe, official_pct, snapshot)
    log = upsert_log(clean_log(previous.get("log")), entry)

    if entry["status"] == "complete":
        print(
            f"15:15旁路 {entry['bypassPct']:.2f}% vs "
            f"晚间官方 {entry['officialPct']:.2f}% → "
            f"diffPp {entry['diffPp']:+.2f}pp"
        )
    else:
        print(f"⚠ {last_date} 缺少有效15:15旁路快照，明确记录为 missing_snapshot")

    version = now_bj.strftime("%Y-%m-%d %H:%M:%S")
    payload = {
        "v": version,
        "date": last_date,
        "peYest": official_pe,
        "pctYest": official_pct,
        "priceYest": close_price,
        "mcapYest": close_mcap,
        "peQQYest": qq_pe,
        "n": sample_count,
        "peSorted": pe_sorted,
        "log": log,
    }
    gist_patch(payload)
    print(
        f"✓ 已更新 Gist {GIST_FILE}：官方百分位 {official_pct:.2f}%，"
        f"验证状态 {entry['status']}"
    )

    write_public_log(version, last_date, log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
