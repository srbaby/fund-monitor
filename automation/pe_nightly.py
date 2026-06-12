# -*- coding: utf-8 -*-
"""
夜间PE数据引擎（GitHub Actions 运行）
职责：抓乐咕全量沪深300滚动PE → 构建排序数组+昨收锚 → 写入Gist fm_pe_engine.json
     并自动记录"总市值恒等式预测 vs 官方"的逐日验证日志（旁路验证核心）
环境变量：PE_GIST_ID / PE_GIST_TOKEN（gist 权限 PAT）
退出码：0=成功或合理跳过；1=晚间槽位仍拿不到当日数据（红色提醒）
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
SLOT = os.environ.get("RUN_SLOT", "late")  # early=20:30槽 / late=22:30槽
GIST_FILE = "fm_pe_engine.json"
LOG_KEEP = 90

BJT = timezone(timedelta(hours=8))


def fetch_legu():
    raw = ak.stock_index_pe_lg(symbol="沪深300")
    df = raw[["日期", "指数", "滚动市盈率"]].dropna().sort_values("日期").reset_index(drop=True)
    return df


def fetch_qq_close():
    """腾讯接口取收盘总市值(亿)与PE_TTM，失败返回(None, None)"""
    url = f"https://qt.gtimg.cn/q=sh000300&r={random.randint(100000, 999999)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"})
    try:
        body = urllib.request.urlopen(req, timeout=10).read().decode("gbk", "ignore")
        f = body.split("~")
        pe_qq = float(f[39])
        mcap = float(f[45])
        return (mcap if mcap > 0 else None), (pe_qq if pe_qq > 0 else None)
    except Exception as e:
        print(f"⚠ 腾讯收盘快照抓取失败：{e}")
        return None, None


def gist_get():
    """返回 (引擎数据, 看板手工PE锚fm_pe.json)；后者用于复算现行体系收盘读数"""
    req = urllib.request.Request(
        f"https://api.github.com/gists/{GIST_ID}",
        headers={"Authorization": f"token {GIST_TOKEN}", "User-Agent": "pe-engine"},
    )
    data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    files = data.get("files", {})

    def _parse(name):
        f = files.get(name)
        if not f:
            return None
        try:
            return json.loads(f["content"])
        except Exception:
            return None

    return _parse(GIST_FILE), _parse("fm_pe.json")


def calc_cur_system(pe_man, prev, px_today):
    """复算现行看板（4字段线性插值）当日收盘读数，口径=看板getCurrentPE。
    守卫：手工锚必须是昨晚的（priceAnchor==前一锚收盘点位），否则返回None不污染对比。"""
    try:
        p = pe_man.get("p", pe_man)  # 兼容 {p:{...}} 与扁平两种存法
        lo, hi = (float(x) for x in p["bucketStr"].split(","))
        pe_y, anchor = float(p["peYest"]), float(p["priceAnchor"])
        buy, sell = float(p["priceBuy"]), float(p["priceSell"])
        if not prev or not prev.get("priceYest") or abs(anchor - prev["priceYest"]) > 0.02:
            return None  # 锚不是昨晚的（用户已提前录今晚锚或漏录），跳过
        buy_pct, sell_pct = lo - 1.75, hi + 1.75
        if px_today < anchor and anchor != buy:
            v = buy_pct + (px_today - buy) / (anchor - buy) * (pe_y - buy_pct)
        elif sell != anchor:
            v = pe_y + (px_today - anchor) / (sell - anchor) * (sell_pct - pe_y)
        else:
            return None
        return round(v, 2)
    except Exception:
        return None


def gist_patch(payload):
    body = json.dumps(
        {"files": {GIST_FILE: {"content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}}}
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


SLOT_PLAN = {"early": "20:30", "late": "22:30"}  # 北京时间计划点，用于cron延时分析


def _delay_min(now_bj):
    """实际执行时间相对计划槽位的延迟（分钟）；手动触发返回None"""
    plan = SLOT_PLAN.get(SLOT)
    if not plan:
        return None
    h, m = map(int, plan.split(":"))
    planned = now_bj.replace(hour=h, minute=m, second=0, microsecond=0)
    return round((now_bj - planned).total_seconds() / 60, 1)


def main():
    today_bj = datetime.now(BJT).date()
    df = fetch_legu()
    last_date = str(df["日期"].iloc[-1])[:10]
    print(f"乐咕数据末行：{last_date}（{len(df)}个交易日）；北京今日：{today_bj}")

    prev, pe_man = gist_get()

    # 一次性回填(06-11/12)：errPp按已人工核实的链路一致性置0（引擎=本地脚本：63.88/65.17均一致）；
    # 原模型残差值改存fcstPp；补pctCur列。幂等；转正清理时可删除本块。
    _BACKFILL_CUR = {
        "2026-06-11": {"pctCur": 63.22, "errCurPp": -0.66, "pctLocal": 63.88, "errPp": 0.0},
        "2026-06-12": {"pctCur": 65.21, "errCurPp": 0.04, "pctLocal": 65.17, "errPp": 0.0},
    }
    _bf_changed = False
    if prev:
        for _e in prev.get("log", []):
            _bf = _BACKFILL_CUR.get(_e.get("d"))
            if not _bf:
                continue
            if "fcstPp" not in _e and "errPp" in _e:
                _e["fcstPp"] = _e.pop("errPp")  # 旧errPp是盘中预报残差，移交fcstPp
                _bf_changed = True
            if "pctCur" not in _e:
                _e.update(_bf)
                _bf_changed = True

    # errPp（核心KPI·链路一致性）：引擎昨晚产出的官方百分位 vs 本地脚本同日值。
    # 本地值取自大亨晚间录入的fm_pe.json锚（次日运行时完成上一交易日核对），期望恒为0。
    if prev and pe_man:
        _p = pe_man.get("p", pe_man)
        try:
            if abs(float(_p.get("priceAnchor", 0)) - float(prev.get("priceYest") or 0)) <= 0.02:
                for _e in prev.get("log", []):
                    if _e.get("d") == prev.get("date") and "errPp" not in _e:
                        _e["pctLocal"] = float(_p["peYest"])
                        _e["errPp"] = round(float(prev["pctYest"]) - _e["pctLocal"], 2)
                        _bf_changed = True
                        print(f"链路核对[{_e['d']}]：引擎 {prev['pctYest']} vs 本地脚本 {_e['pctLocal']} → errPp {_e['errPp']:+.2f}pp")
        except Exception:
            pass

    if prev and prev.get("date") == last_date:
        if _bf_changed:
            gist_patch(prev)
            print(f"✓ Gist 已是最新；回填合并 {len(_BACKFILL_CUR)} 条 errCurPp 并已补写")
        else:
            print("✓ Gist 已是最新，跳过")
        return 0

    is_weekday = today_bj.weekday() < 5
    if is_weekday and last_date != str(today_bj):
        if SLOT == "early":
            print("⚠ 乐咕尚未更新当日数据，等待晚间槽位重试")
            return 0
        print("❌ 晚间槽位仍未取到当日数据（可能非交易日或乐咕延迟，请人工确认）")
        return 1

    pe_arr = df["滚动市盈率"].astype(float).round(2)
    pe_yest = float(pe_arr.iloc[-1])
    price_yest = float(df["指数"].iloc[-1])
    n = len(pe_arr)
    pct_yest = round(float((pe_arr <= pe_yest).sum()) / n * 100, 2)
    pe_sorted = sorted(pe_arr.tolist())

    mcap_yest, pe_qq_yest = fetch_qq_close()
    print(f"官方PE={pe_yest} 百分位={pct_yest}% 点位={price_yest} | 腾讯总市值={mcap_yest}亿 PE_qq={pe_qq_yest}")

    # ---- 自动验证日志：用前一锚的总市值恒等式预测今天，与官方对比 ----
    # 字段足够丰富以支持AI系统分析：误差归因（恒等式残差 vs β弹性）、逐日β追踪、总市值/点位/PE三线变动
    log = (prev or {}).get("log", [])[-(LOG_KEEP - 1):]
    if prev and prev.get("date") and prev["date"] < last_date:
        r_px = round((price_yest / prev["priceYest"] - 1) * 100, 4) if prev.get("priceYest") else None
        r_pe = round((pe_yest / prev["peYest"] - 1) * 100, 4) if prev.get("peYest") else None
        beta_d = round(r_pe / r_px, 3) if r_px and abs(r_px) > 0.2 else None
        now_bj = datetime.now(BJT)
        entry = {
            "d": last_date,
            "px": price_yest,
            "rPx": r_px,            # 点位日变动%
            "rPe": r_pe,            # 官方PE日变动%
            "betaD": beta_d,        # 当日β（|rPx|>0.2%才记）
            "peOff": pe_yest,
            "pctOff": pct_yest,
            "mcap": mcap_yest,      # 腾讯收盘总市值(亿)
            "peQQ": pe_qq_yest,
            "slot": SLOT,                                   # 哪个槽位实际完成写入
            "runAt": now_bj.strftime("%H:%M:%S"),           # 实际执行时刻(北京)
            "delayMin": _delay_min(now_bj),                 # 相对计划点延迟(分)，手动=null
        }
        if prev.get("mcapYest") and mcap_yest:
            r_mcap = round((mcap_yest / prev["mcapYest"] - 1) * 100, 4)
            pe_pred = round(prev["peYest"] * mcap_yest / prev["mcapYest"], 4)
            pct_pred = round(sum(1 for x in pe_sorted if x <= pe_pred) / n * 100, 2)
            pe_pred_px = round(prev["peYest"] * price_yest / prev["priceYest"], 4) if prev.get("priceYest") else None
            entry.update({
                "rMcap": r_mcap,                      # 总市值日变动%
                "pePred": pe_pred,                    # 恒等式预测PE
                "pctPred": pct_pred,
                "fcstPp": round(pct_pred - pct_yest, 2),  # 盘中预报残差（侧写指标，非KPI）
                "pePredPx": pe_pred_px,               # 对照组：点位等比预测PE（β=1裸模型）
            })
            print(f"盘中预报残差：{pe_pred} vs 官方 {pe_yest} → fcstPp {entry['fcstPp']:+.2f}pp")
        # 三方对比补全：现行手工体系（4字段插值）收盘读数 vs 权威
        if pe_man:
            pct_cur = calc_cur_system(pe_man, prev, price_yest)
            if pct_cur is not None:
                entry["pctCur"] = pct_cur                          # 现行看板收盘读数
                entry["errCurPp"] = round(pct_cur - pct_yest, 2)   # 现行体系误差
                print(f"现行体系收盘读数 {pct_cur}% vs 官方 {pct_yest}% → 误差 {entry['errCurPp']:+.2f}pp")
        log.append(entry)

    payload = {
        "v": datetime.now(BJT).strftime("%Y-%m-%d %H:%M:%S"),
        "date": last_date,
        "peYest": pe_yest,
        "priceYest": price_yest,
        "pctYest": pct_yest,
        "mcapYest": mcap_yest,
        "peQQYest": pe_qq_yest,
        "n": n,
        "peSorted": pe_sorted,
        "log": log,
    }
    gist_patch(payload)
    print(f"✓ 已写入 Gist {GIST_FILE}（{n}样本，{len(log)}条验证日志）")

    # 验证日志副本落仓库（公开可读，供AI直接抓取分析，不含敏感信息）
    try:
        with open("automation/validation-log.json", "w", encoding="utf-8") as f:
            json.dump(
                {"v": payload["v"], "date": last_date, "peYest": pe_yest, "pctYest": pct_yest,
                 "priceYest": price_yest, "mcapYest": mcap_yest, "n": n, "log": log},
                f, ensure_ascii=False, indent=1,
            )
        print("✓ 验证日志副本已写 automation/validation-log.json")
    except Exception as e:
        print(f"⚠ 日志副本写入失败（不影响主流程）：{e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
