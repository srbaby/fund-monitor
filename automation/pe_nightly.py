# -*- coding: utf-8 -*-
"""
夜间 PE 数据引擎（GitHub Actions 运行）

职责：
1. 抓取乐咕沪深300滚动 PE，更新次日旁路锚与历史排序数组；
2. 将当天 16:00 固化的旁路快照（1.0 总市值路 + 2.0 点位路），与当晚官方 PE 百分位配对；
3. 生成双路验证日志：
   bypass1 = 总市值恒等式（mcap路），bypass2 = 点位等比（price路）
   diffPp1/diffPp2 = 各路旁路百分位 - 官方百分位

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
# RUN_ACTION=snapshot 时只做快照写入；night/sentinel/默认 时做夜间配对
RUN_ACTION = os.environ.get("RUN_ACTION", "night")
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


def _pct_from_pe(pe_val, pe_sorted):
    """二分查找：(pe <= pe_val) / n，与看板 getEnginePE 口径一致。"""
    if pe_val is None or not pe_sorted:
        return None
    lo, hi = 0, len(pe_sorted)
    while lo < hi:
        mid = (lo + hi) // 2
        if pe_sorted[mid] <= pe_val:
            lo = mid + 1
        else:
            hi = mid
    return round(lo / len(pe_sorted) * 100, 2)


def build_validation_entry(trade_date, official_pe, official_pct, snapshot, pe_sorted):
    """
    构建双路验证日志条目。
    snapshot 字段说明：
      bypass1: 总市值路（mcap），旧有字段 bypassPe/bypassPct 兼容读取
      bypass2: 点位路（price），新增字段 bypass2Pe/bypass2Pct
    """
    if snapshot and snapshot.get("date") == trade_date:
        # --- 1.0 总市值路 ---
        b1_pe = snapshot.get("bypassPe") or snapshot.get("bypass1Pe")
        b1_pct = snapshot.get("bypassPct") or snapshot.get("bypass1Pct")
        # --- 2.0 点位路 ---
        b2_pe = snapshot.get("bypass2Pe")
        b2_pct = snapshot.get("bypass2Pct")

        # 兼容旧快照（只有1.0字段）：尝试用 pe_sorted 重算2.0（需要 priceRatio）
        # 旧快照无 priceRatio，无法补算2.0，留 None 即可

        has_b1 = b1_pe is not None and b1_pct is not None
        has_b2 = b2_pe is not None and b2_pct is not None

        if has_b1 or has_b2:
            off_pct = round(float(official_pct), 2)
            return {
                "date": trade_date,
                "sampleAt": snapshot.get("sampleAt"),
                # 1.0 总市值路
                "bypass1Pe": round(float(b1_pe), 4) if b1_pe is not None else None,
                "bypass1Pct": round(float(b1_pct), 2) if b1_pct is not None else None,
                "diffPp1": round(float(b1_pct) - off_pct, 2) if b1_pct is not None else None,
                # 2.0 点位路
                "bypass2Pe": round(float(b2_pe), 4) if b2_pe is not None else None,
                "bypass2Pct": round(float(b2_pct), 2) if b2_pct is not None else None,
                "diffPp2": round(float(b2_pct) - off_pct, 2) if b2_pct is not None else None,
                # 官方
                "officialPe": round(float(official_pe), 4),
                "officialPct": off_pct,
                "status": "complete",
            }

    return {
        "date": trade_date,
        "sampleAt": None,
        "bypass1Pe": None, "bypass1Pct": None, "diffPp1": None,
        "bypass2Pe": None, "bypass2Pct": None, "diffPp2": None,
        "officialPe": round(float(official_pe), 4),
        "officialPct": round(float(official_pct), 2),
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
        "metric": "diffPp1=bypass1(mcap路)百分位-官方 | diffPp2=bypass2(price路)百分位-官方",
        "log": log,
    }
    PUBLIC_LOG_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"✓ 已写精简验证日志：{PUBLIC_LOG_FILE}（{len(log)}条）")


def capture_snapshot(now_bj, pe_sorted):
    """
    16:00 快照任务：抓腾讯实时数据，同时计算 1.0（mcap）和 2.0（price）两路旁路 PE，
    写入 pe-snapshot.json 并由 Actions 步骤 commit。
    """
    today = str(now_bj.date())
    existing = load_snapshot()
    if existing and existing.get("date") == today and existing.get("status") == "captured":
        print(f"✓ 今日快照已存在（{today} {existing.get('sampleAt')}），跳过")
        return 0

    engine = gist_get()
    if not engine or engine.get("peYest") is None:
        print("❌ Gist 夜锚不完整，无法计算快照")
        return 1

    close_mcap, _qq_pe, close_price_qq = fetch_qq_close()
    if close_mcap is None and close_price_qq is None:
        print("❌ 腾讯行情获取失败，快照中止")
        return 1

    pe_yest = engine["peYest"]
    mcap_yest = engine.get("mcapYest")
    price_yest = engine.get("priceYest")      # 乐咕官方前收点位（2.0主锚）
    price_qq_yest = engine.get("priceQQYest")  # 腾讯前收点位（2.0备用锚）

    # 1.0 总市值路
    bypass1_pe, bypass1_pct = None, None
    if close_mcap and mcap_yest:
        bypass1_pe = round(pe_yest * (close_mcap / mcap_yest), 4)
        bypass1_pct = _pct_from_pe(bypass1_pe, pe_sorted)

    # 2.0 点位路（优先乐咕锚，腾讯锚备用）
    bypass2_pe, bypass2_pct = None, None
    price_anchor = price_yest or price_qq_yest
    if close_price_qq and price_anchor:
        bypass2_pe = round(pe_yest * (close_price_qq / price_anchor), 4)
        bypass2_pct = _pct_from_pe(bypass2_pe, pe_sorted)

    sample_at = now_bj.strftime("%H:%M:%S")
    snapshot = {
        "date": today,
        "sampleAt": sample_at,
        "anchorDate": engine.get("date", ""),
        # 1.0 总市值路
        "mcap": round(close_mcap, 2) if close_mcap else None,
        "bypass1Pe": bypass1_pe,
        "bypass1Pct": bypass1_pct,
        # 2.0 点位路
        "priceQQ": round(close_price_qq, 2) if close_price_qq else None,
        "bypass2Pe": bypass2_pe,
        "bypass2Pct": bypass2_pct,
        # 兼容旧字段名（历史 log 迁移期）
        "bypassPe": bypass1_pe,
        "bypassPct": bypass1_pct,
        "status": "captured",
    }
    SNAPSHOT_FILE.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    b1_str = f"bypass1={bypass1_pct:.2f}%" if bypass1_pct is not None else "bypass1=缺失"
    b2_str = f"bypass2={bypass2_pct:.2f}%" if bypass2_pct is not None else "bypass2=缺失"
    print(f"✓ 16:00快照 {today} {sample_at}：{b1_str} {b2_str}")
    return 0


def main():
    now_bj = datetime.now(BJT)
    today_bj = now_bj.date()

    df = fetch_legu()
    last_date = str(df["日期"].iloc[-1])[:10]
    print(f"乐咕数据末行：{last_date}（{len(df)}个交易日）；北京今日：{today_bj}")

    pe_series = df["滚动市盈率"].astype(float).round(2)
    pe_sorted = sorted(pe_series.tolist())

    # ── 快照分支（16:00 snapshot event 触发）──────────────────────
    if RUN_ACTION == "snapshot":
        return capture_snapshot(now_bj, pe_sorted)

    # ── 夜间配对分支（night / sentinel 触发）─────────────────────
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
    official_pe = float(pe_series.iloc[-1])
    close_price = float(df["指数"].iloc[-1])
    sample_count = len(pe_series)
    official_pct = round(float((pe_series <= official_pe).sum()) / sample_count * 100, 2)
    close_mcap, qq_pe, close_price_qq = fetch_qq_close()

    snapshot = load_snapshot()
    entry = build_validation_entry(last_date, official_pe, official_pct, snapshot, pe_sorted)
    log = upsert_log(clean_log(previous.get("log")), entry)

    if entry["status"] == "complete":
        b1 = f"bypass1={entry['bypass1Pct']:.2f}%" if entry["bypass1Pct"] is not None else "bypass1=缺失"
        b2 = f"bypass2={entry['bypass2Pct']:.2f}%" if entry["bypass2Pct"] is not None else "bypass2=缺失"
        d1 = f"diffPp1={entry['diffPp1']:+.2f}pp" if entry["diffPp1"] is not None else "diffPp1=缺失"
        d2 = f"diffPp2={entry['diffPp2']:+.2f}pp" if entry["diffPp2"] is not None else "diffPp2=缺失"
        print(f"16:00旁路 {b1} {b2} vs 晚间官方 {entry['officialPct']:.2f}% → {d1} {d2}")
    else:
        print(f"⚠ {last_date} 缺少有效16:00旁路快照，明确记录为 missing_snapshot")

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
