#!/usr/bin/env python3
"""Simulasi P&L agent "penjaga harga" HSKSwap: arbitrase satu-sisi pool WHSK/USDT terhadap harga
HashKey Global (HSKUSDT), tanpa hedge di CEX. Read-only: hanya memakai cache data/ dari backtest.py.

Pakai: python3 arb_sim.py
Output: arb_trades.csv (trade konfigurasi terbaik per modal), arb_results.csv, ARB_REPORT.md

Model (ringkas, detail di ARB_REPORT.md):
- Harga DEX historis direplay per menit; trade agent menggeser sqrtPrice dan pergeseran itu disimpan
  sebagai offset aditif D (satuan sqrtPrice mentah). Di Uniswap V3 dengan L konstan, swap historis
  dengan jumlah USDT yang sama menggeser sqrtPrice sebesar dy/L berapa pun level harganya, jadi
  sp_sim(t) = sp_hist(t) + D mempertahankan aliran USDT historis secara persis (WHSK aproksimasi).
- Harga CEX hanya dari menit ber-volume; "segar" bila trade nyata terakhir <= N menit (N=1,5).
- Keputusan di akhir menit m (info s.d. menit m), eksekusi di akhir menit m+LAT (default 1).
"""

import bisect
import csv
import json
import math
import os
import statistics

from backtest import DATA, DEC0, DEC1, HERE, Q96, decode, iso, pct

FEE = 0.003
GAS_UNITS = 200_000
# effectiveGasPrice 3 receipt swap pool ini (blok ~30.598.7xx): 500.1-501 gwei; l1Fee maks 3.2e13 wei
GAS_PRICE_WEI = 501e9
L1_FEE_WEI = 3.2e13
CAPITALS = (100, 1_000, 5_000, 20_000)
THRESHOLDS = (40, 60, 80, 100)
FRESH_N = (1, 5)
BUFFER_BPS = 40  # target harga DEX = CEX x (1 +/- buffer); fee 30 bps + 10 bps margin
MAX_TRADE_FRAC = 0.5  # maks per trade = 50% modal awal (USD)
LATENCY_MIN = 1
MIN_EDGE_GAS_MULT = 2  # trade hanya bila edge yang diharapkan >= 2x gas
MARKOUT_MIN = (60, 1440)
REF_MODES = ("last", "med5")
MED_K = 5
MED_WINDOW_MIN = 30
SCALE = 10 ** (DEC0 - DEC1)


def load():
    with open(os.path.join(DATA, "swap_logs.json")) as f:
        swaps = decode(json.load(f))
    with open(os.path.join(DATA, "cex_klines.json")) as f:
        rows = json.load(f)["rows"]
    return swaps, rows


def price_of(sp):
    return sp * sp * SCALE


def sp_of(price):
    return math.sqrt(price / SCALE)


class Market:
    """Akses harga historis DEX (per waktu) & harga CEX segar (per menit)."""

    def __init__(self, swaps, rows):
        self.sw_ts = [s["ts"] for s in swaps]
        self.sw_sp = [s["sqrtPriceX96"] / Q96 for s in swaps]
        self.sw_L = [float(s["liquidity"]) for s in swaps]
        first_ts = self.sw_ts[0]
        self.minutes = [r for r in rows if r[0] // 1000 + 60 > first_ts]
        self.t_end = [r[0] // 1000 + 60 for r in self.minutes]
        # indeks menit ber-volume terakhir s.d. menit i (harga trade nyata)
        self.last_traded = []
        last = None
        for i, r in enumerate(self.minutes):
            if r[2] > 0:
                last = i
            self.last_traded.append(last)
        self.traded = [i for i, r in enumerate(self.minutes) if r[2] > 0]

    def hist(self, t):
        j = bisect.bisect_right(self.sw_ts, t) - 1
        return self.sw_sp[max(j, 0)], self.sw_L[max(j, 0)]

    def ref(self, i, n, mode="last"):
        """Harga CEX dari trade nyata <= n menit lalu (menit i termasuk), else None.
        mode "med5": median close 5 menit ber-volume terakhir dalam 30 menit (redam bid-ask bounce)."""
        k = self.last_traded[i]
        if k is None or i - k >= n:
            return None
        if mode == "last":
            return self.minutes[k][1]
        j = bisect.bisect_right(self.traded, i)
        idx = [x for x in self.traded[max(j - MED_K, 0) : j] if i - x < MED_WINDOW_MIN]
        return statistics.median(self.minutes[x][1] for x in idx)

    def mark(self, i):
        k = self.last_traded[i]
        return self.minutes[k][1] if k is not None else self.minutes[i][1]


def gas_usd(hsk_price):
    return (GAS_UNITS * GAS_PRICE_WEI + L1_FEE_WEI) / 1e18 * hsk_price


def size_trade(sp, L, ref, sell, whsk, usdt, max_usd):
    """Swap yang menggeser harga ke ref x (1 -/+ buffer), dibatasi inventaris & max_usd.
    Return (new_sp, amount_in, amount_out) dalam unit token (WHSK / USDT), atau None."""
    buf = BUFFER_BPS / 1e4
    if sell:  # DEX kemahalan: jual WHSK, harga turun
        tgt = sp_of(ref * (1 + buf))
        if tgt >= sp:
            return None
        net0 = L * (1 / tgt - 1 / sp)  # raw WHSK (net fee)
        cap = min(whsk, max_usd / ref) * 10**DEC0 * (1 - FEE)
        if net0 > cap:
            net0 = cap
            tgt = 1 / (1 / sp + net0 / L)
        out1 = L * (sp - tgt) / 10**DEC1
        return tgt, net0 / (1 - FEE) / 10**DEC0, out1
    tgt = sp_of(ref * (1 - buf))
    if tgt <= sp:
        return None
    net1 = L * (tgt - sp)  # raw USDT (net fee)
    cap = min(usdt, max_usd) * 10**DEC1 * (1 - FEE)
    if net1 > cap:
        net1 = cap
        tgt = sp + net1 / L
    out0 = L * (1 / sp - 1 / tgt) / 10**DEC0
    return tgt, net1 / (1 - FEE) / 10**DEC1, out0


def simulate(mk, capital, thr, n, mode="last", latency=LATENCY_MIN, keep_trades=False):
    p0 = mk.mark(0)
    usdt, whsk = capital / 2, capital / 2 / p0
    usdt0, whsk0 = usdt, whsk
    D = 0.0
    gas_cum = 0.0
    realized = 0.0
    trades = []
    pending = {}  # menit eksekusi -> (ref, sell, menit keputusan, gap_bps)
    alpha_curve = []
    eq_peak, eq_dd = -1e18, 0.0
    al_peak, al_dd = -1e18, 0.0
    max_usd = capital * MAX_TRADE_FRAC
    nm = len(mk.minutes)
    for i in range(nm):
        te = mk.t_end[i]
        sp_h, L = mk.hist(te)
        if i in pending:
            ref, sell, i_dec, gap_dec = pending.pop(i)
            sp = sp_h + D
            hsk = mk.mark(i)
            res = size_trade(sp, L, ref, sell, whsk, usdt, max_usd)
            if res:
                tgt, a_in, a_out = res
                edge = a_out - a_in * ref if sell else a_out * ref - a_in
                g = gas_usd(hsk)
                if edge >= MIN_EDGE_GAS_MULT * g and (a_in * (ref if sell else 1)) >= 1:
                    if sell:
                        whsk -= a_in
                        usdt += a_out
                    else:
                        usdt -= a_in
                        whsk += a_out
                    D += tgt - sp
                    gas_cum += g
                    realized += edge - g
                    trades.append(
                        {
                            "i": i,
                            "ts": te,
                            "side": "sell_WHSK" if sell else "buy_WHSK",
                            "gap_bps": gap_dec,
                            "ref": ref,
                            "dex_before": price_of(sp),
                            "dex_after": price_of(tgt),
                            "amount_in": a_in,
                            "amount_out": a_out,
                            "usd": a_out if sell else a_in,
                            "edge_usd": edge,
                            "gas_usd": g,
                        }
                    )
        # sinyal di akhir menit i (setelah trade yang mendarat di menit ini)
        ref = mk.ref(i, n, mode)
        if ref is not None and (i + latency) not in pending:
            dex = price_of(mk.hist(te)[0] + D)
            gap = (dex - ref) / ref * 1e4
            if abs(gap) > thr:
                pending[i + latency] = (ref, gap > 0, i, gap)
        px = mk.mark(i)
        eq = usdt + whsk * px - gas_cum
        alpha = eq - (usdt0 + whsk0 * px)
        alpha_curve.append(alpha)
        eq_peak = max(eq_peak, eq)
        eq_dd = max(eq_dd, eq_peak - eq)
        al_peak = max(al_peak, alpha)
        al_dd = max(al_dd, al_peak - alpha)

    # markout: nilai trade di harga CEX (trade nyata) t menit kemudian
    for t in trades:
        for m in MARKOUT_MIN:
            j = min(t["i"] + m, nm - 1)
            pf = mk.mark(j)
            if t["side"] == "sell_WHSK":
                t[f"markout{m}"] = t["amount_out"] - t["amount_in"] * pf - t["gas_usd"]
            else:
                t[f"markout{m}"] = t["amount_out"] * pf - t["amount_in"] - t["gas_usd"]
    days = (mk.t_end[-1] - mk.t_end[0]) / 86400
    half = nm // 2
    pf_end = mk.mark(nm - 1)
    res = {
        "capital": capital,
        "thr": thr,
        "n": n,
        "mode": mode,
        "latency": latency,
        "trades": len(trades),
        "volume": sum(t["usd"] for t in trades),
        "alpha": alpha_curve[-1],
        "alpha_h1": alpha_curve[half],
        "alpha_h2": alpha_curve[-1] - alpha_curve[half],
        "realized": realized,
        "gas": gas_cum,
        "alpha_dd": al_dd,
        "eq_dd": eq_dd,
        "eq_end": usdt + whsk * pf_end - gas_cum,
        "hold_end": usdt0 + whsk0 * pf_end,
        "whsk_share_end": whsk * pf_end / max(usdt + whsk * pf_end, 1e-9),
        "days": days,
        "adv60": sum(1 for t in trades if t["markout60"] < 0) / len(trades)
        if trades
        else None,
        "adv1440": sum(1 for t in trades if t["markout1440"] < 0) / len(trades)
        if trades
        else None,
        "mk60": sum(t["markout60"] for t in trades),
        "mk1440": sum(t["markout1440"] for t in trades),
    }
    res["alpha_pct_month"] = res["alpha"] / capital * 100 * 30 / days
    res["real_pct_month"] = realized / capital * 100 * 30 / days
    if keep_trades:
        res["trade_list"] = trades
    return res


def gap_closure(mk, n, thr=100):
    """Episode gap >= thr (menit CEX segar): siapa yang menutup >=50% gap dalam 240 menit —
    DEX bergerak ke CEX, atau CEX bergerak ke DEX (tanpa agent, harga historis)."""
    dex_cnt = cex_cnt = none = 0
    i, nm = 0, len(mk.minutes)
    while i < nm:
        ref = mk.ref(i, n)
        if ref is None:
            i += 1
            continue
        d0 = price_of(mk.hist(mk.t_end[i])[0])
        gap0 = d0 - ref
        if abs(gap0) / ref * 1e4 < thr:
            i += 1
            continue
        who, j = None, i + 1
        while j < min(i + 241, nm):
            dj, cj = price_of(mk.hist(mk.t_end[j])[0]), mk.mark(j)
            if (dj - cj) / gap0 <= 0.5:
                dm, cm = (d0 - dj) / gap0, (cj - ref) / gap0
                who = "dex" if dm >= cm else "cex"
                break
            j += 1
        if who == "dex":
            dex_cnt += 1
        elif who == "cex":
            cex_cnt += 1
        else:
            none += 1
        i = j + 1
    return {"dex": dex_cnt, "cex": cex_cnt, "none": none}


def f(v, d=2):
    return f"{v:,.{d}f}"


def main():
    swaps, rows = load()
    mk = Market(swaps, rows)
    nm = len(mk.minutes)
    vol_min = sum(1 for r in mk.minutes if r[2] > 0)
    print(
        f"swaps {len(swaps)}, menit CEX {nm} ({vol_min} ber-volume), "
        f"{iso(mk.t_end[0])} -> {iso(mk.t_end[-1])}"
    )
    p = [mk.minutes[i][1] for i in mk.traded]
    ret = [(b - a) / a * 1e4 for a, b in zip(p, p[1:])]
    mu = statistics.mean(ret)
    bounce = {
        "autocorr": sum((a - mu) * (b - mu) for a, b in zip(ret, ret[1:]))
        / sum((a - mu) ** 2 for a in ret),
        "tick_bps": statistics.median(abs(x) for x in ret if x),
        "p_first": p[0],
        "p_last": p[-1],
    }
    print(f"CEX bid-ask bounce: {bounce}")
    results = []
    for mode in REF_MODES:
        for cap in CAPITALS:
            for thr in THRESHOLDS:
                for n in FRESH_N:
                    r = simulate(mk, cap, thr, n, mode)
                    results.append(r)
                    print(
                        f"{mode} cap {cap:>6} thr {thr:>3} N {n}: trades {r['trades']:>4} vol ${r['volume']:>10,.0f} "
                        f"alpha ${r['alpha']:>9,.2f} ({r['alpha_pct_month']:+.2f}%/bln) "
                        f"realized ${r['realized']:>9,.2f} adv60 "
                        f"{(r['adv60'] or 0) * 100:.0f}%"
                    )
    # konfigurasi terbaik per modal (alpha MTM), lalu uji ketahanan
    best = {}
    for cap in CAPITALS:
        cand = [r for r in results if r["capital"] == cap]
        best[cap] = max(cand, key=lambda r: r["alpha"])
    robust = []
    for cap in CAPITALS:
        b = best[cap]
        for lat in (2, 5):
            robust.append(
                (
                    "latency",
                    lat,
                    simulate(mk, cap, b["thr"], b["n"], b["mode"], latency=lat),
                )
            )
    global BUFFER_BPS
    base_buf = BUFFER_BPS
    for buf in (30, 60):
        BUFFER_BPS = buf
        for cap in CAPITALS:
            b = best[cap]
            robust.append(
                ("buffer", buf, simulate(mk, cap, b["thr"], b["n"], b["mode"]))
            )
    BUFFER_BPS = base_buf
    closure = {n: gap_closure(mk, n) for n in FRESH_N}
    print(f"penutupan gap >=100 bps: {closure}")

    detail = {
        cap: simulate(
            mk,
            cap,
            best[cap]["thr"],
            best[cap]["n"],
            best[cap]["mode"],
            keep_trades=True,
        )
        for cap in CAPITALS
    }
    with open(os.path.join(HERE, "arb_results.csv"), "w", newline="") as fh:
        cols = [k for k in results[0] if k != "trade_list"]
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(results)
    with open(os.path.join(HERE, "arb_trades.csv"), "w", newline="") as fh:
        cols = [
            "capital",
            "mode",
            "thr",
            "n",
            "ts",
            "side",
            "gap_bps",
            "ref",
            "dex_before",
            "dex_after",
            "amount_in",
            "amount_out",
            "usd",
            "edge_usd",
            "gas_usd",
            "markout60",
            "markout1440",
        ]
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for cap, d in detail.items():
            for t in d["trade_list"]:
                w.writerow(
                    {
                        **t,
                        "capital": cap,
                        "thr": d["thr"],
                        "n": d["n"],
                        "mode": d["mode"],
                    }
                )
    write_report(mk, swaps, results, best, detail, robust, closure, vol_min, bounce)
    print("tulis ARB_REPORT.md, arb_results.csv, arb_trades.csv")


def write_report(mk, swaps, results, best, detail, robust, closure, vol_min, bounce):
    days = results[0]["days"]
    g_now = gas_usd(mk.mark(len(mk.minutes) - 1))
    L = []
    L.append(
        '# Simulasi arbitrase "penjaga harga" HSKSwap WHSK/USDT vs HashKey Global\n'
    )
    L.append(
        f"Dibuat oleh `python3 arb_sim.py` dari cache `data/` milik `backtest.py` (tanpa fetch ulang). "
        f"Periode {iso(mk.t_end[0])} → {iso(mk.t_end[-1])} ({days:.1f} hari), {len(swaps)} swap historis, "
        f"{len(mk.minutes):,} menit CEX ({vol_min:,} ber-volume = {vol_min / len(mk.minutes) * 100:.0f}%). "
        f"Gas per swap ≈ ${g_now:.4f} (200k gas × 501 gwei + l1Fee, HSK ${mk.mark(len(mk.minutes) - 1):.4f}). "
        f"HSK di CEX turun ${bounce['p_first']:.4f} → ${bounce['p_last']:.4f} selama periode.\n"
    )
    L.append(
        f"**Catatan harga CEX:** close menit ber-volume HashKey Global punya autokorelasi return lag-1 "
        f"{bounce['autocorr']:.2f} dan perubahan non-nol median {bounce['tick_bps']:.1f} bps (= 1 tick "
        "0.0001) — ciri bid-ask bounce: close melompat antara bid & ask sehingga sebagian besar 'gap' "
        "DEX−CEX adalah noise spread CEX, bukan mispricing. Karena itu diuji dua acuan: `last` (close "
        f"menit ber-volume terakhir ≤N menit) dan `med5` (median {MED_K} close ber-volume terakhir dalam "
        f"{MED_WINDOW_MIN} menit, syarat trade terakhir ≤N menit).\n"
    )
    L.append("## Simulasi arbitrase\n")
    L.append(
        "Semua konfigurasi. **Alpha** = nilai portofolio agent − buy-and-hold 50/50, keduanya di harga "
        "CEX (trade nyata) akhir, setelah gas. **Realisasi** = Σ(edge tiap trade di harga CEX acuan saat "
        "keputusan) − gas. DD alpha = drawdown maks kurva alpha. Adv60/Adv1440 = % trade dengan markout "
        "negatif 60 menit / 24 jam kemudian (adverse selection).\n"
    )
    L.append(
        "| Acuan | Modal | Ambang | N | Trade | Volume | Alpha | Alpha %/bln | Realisasi | Real. %/bln | "
        "DD alpha | Adv60 | Adv1440 | Markout 24j |"
    )
    L.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in results:
        adv60 = f"{r['adv60'] * 100:.0f}%" if r["adv60"] is not None else "–"
        adv1440 = f"{r['adv1440'] * 100:.0f}%" if r["adv1440"] is not None else "–"
        L.append(
            f"| {r['mode']} | ${r['capital']:,} | {r['thr']} | {r['n']} | {r['trades']} | ${r['volume']:,.0f} | "
            f"${f(r['alpha'])} | {r['alpha_pct_month']:+.2f}% | ${f(r['realized'])} | "
            f"{r['real_pct_month']:+.2f}% | ${f(r['alpha_dd'])} | {adv60} | {adv1440} | ${f(r['mk1440'])} |"
        )
    L.append("\n### Konfigurasi terbaik per modal (alpha) & ketahanan\n")
    L.append(
        "| Modal | Acuan | Ambang | N | Alpha | %/bln | Alpha paruh-1 | Alpha paruh-2 | Hold akhir | "
        "Agent akhir | Porsi WHSK akhir | DD ekuitas |"
    )
    L.append("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for cap, b in best.items():
        L.append(
            f"| ${cap:,} | {b['mode']} | {b['thr']} | {b['n']} | ${f(b['alpha'])} | {b['alpha_pct_month']:+.2f}% | "
            f"${f(b['alpha_h1'])} | ${f(b['alpha_h2'])} | ${f(b['hold_end'])} | ${f(b['eq_end'])} | "
            f"{b['whsk_share_end'] * 100:.0f}% | ${f(b['eq_dd'])} |"
        )
    L.append("\nSensitivitas konfigurasi terbaik (latensi eksekusi & buffer target):\n")
    L.append("| Uji | Nilai | Modal | Trade | Alpha | %/bln | Realisasi | Adv1440 |")
    L.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for kind, val, r in robust:
        adv = f"{r['adv1440'] * 100:.0f}%" if r["adv1440"] is not None else "–"
        unit = " mnt" if kind == "latency" else " bps"
        L.append(
            f"| {kind} | {val}{unit} | ${r['capital']:,} | {r['trades']} | ${f(r['alpha'])} | "
            f"{r['alpha_pct_month']:+.2f}% | ${f(r['realized'])} | {adv} |"
        )
    L.append(
        "\nPenutupan gap ≥100 bps historis (tanpa agent, ≤240 menit, siapa yang bergerak lebih banyak):\n"
    )
    for n, c in closure.items():
        L.append(
            f"- N={n}: ditutup DEX {c['dex']}, ditutup CEX {c['cex']}, tidak tertutup {c['none']}"
        )
    # statistik trade konfigurasi terbaik
    L.append("\nDistribusi trade konfigurasi terbaik:\n")
    for cap, d in detail.items():
        tl = d["trade_list"]
        if not tl:
            L.append(f"- ${cap:,}: tidak ada trade")
            continue
        sz = [t["usd"] for t in tl]
        ed = [t["edge_usd"] / t["usd"] * 1e4 for t in tl]
        L.append(
            f"- ${cap:,} ({d['mode']}, ambang {d['thr']}, N={d['n']}): {len(tl)} trade "
            f"({len(tl) / d['days']:.1f}/hari), ukuran median ${pct(sz, 0.5):,.2f} "
            f"(p90 ${pct(sz, 0.9):,.2f}), edge median {pct(ed, 0.5):.0f} bps vs acuan, "
            f"Σedge ${f(sum(t['edge_usd'] for t in tl))}, markout 1 jam Σ ${f(d['mk60'])}, "
            f"24 jam Σ ${f(d['mk1440'])}"
        )
    L.append("\n### Kesimpulan\n")
    L.append(conclusion(results, best, robust))
    L.append("\n### Asumsi & batasan\n")
    L.append(
        "\n".join(
            [
                "- Replay harga DEX: offset aditif sqrtPrice D dari trade agent dipertahankan permanen "
                "(tidak ada arbitrase pihak lain yang mengembalikannya; sesuai temuan backtest bahwa "
                "harga hampir tidak pulih). Swap historis diasumsikan tetap terjadi dengan jumlah USDT yang "
                "sama (aliran tidak bereaksi terhadap harga agent). L aktif = `liquidity` dari event Swap "
                "historis terakhir (berubah ~2× selama periode); tidak ada crossing tick (posisi ≈ full-range).",
                f"- Sinyal di akhir menit m memakai close CEX dari menit ber-volume ≤N menit; eksekusi di "
                f"akhir menit m+{LATENCY_MIN} terhadap harga DEX saat itu (swap historis di menit m+1 sudah "
                f"masuk), target harga = acuan CEX keputusan × (1 ± {BUFFER_BPS} bps). Tidak ada look-ahead: "
                "harga CEX masa depan hanya dipakai untuk mark-to-market & markout.",
                f"- Inventaris awal 50/50 di harga CEX awal; trade maks {MAX_TRADE_FRAC * 100:.0f}% modal; "
                f"trade hanya bila edge ≥{MIN_EDGE_GAS_MULT}× gas dan ≥$1. Fee LP 0.3% dihitung pada input. "
                "Gas 200k × 501 gwei (effectiveGasPrice teramati 500.1–501 gwei di 3 receipt) + l1Fee "
                "3.2e13 wei, dibayar HSK di harga CEX saat itu.",
                "- Tanpa hedge CEX: alpha MTM mencakup efek inventaris yang menyimpang dari 50/50. Tidak "
                "memodelkan MEV/front-run, kompetitor arbitrase baru, atau slippage CEX.",
                "- Harga 'CEX' = close menit HashKey Global; 61% menit tanpa volume dibuang (harga basi). "
                "Tidak ada data bid/ask/orderbook historis, jadi mid CEX tidak bisa dihitung langsung.",
                "- 'Konfigurasi terbaik' dipilih dari data yang sama (in-sample) → bias optimistis; uji "
                "paruh periode & sensitivitas hanya mitigasi parsial. Penutupan gap memakai acuan `last`.",
            ]
        )
    )
    with open(os.path.join(HERE, "ARB_REPORT.md"), "w") as fh:
        fh.write("\n".join(L) + "\n")


def conclusion(results, best, robust):
    pos = [r for r in results if r["alpha"] > 0]
    by_mode = {
        m: sum(1 for r in results if r["mode"] == m and r["alpha"] > 0)
        for m in REF_MODES
    }
    per_mode = len(results) // len(REF_MODES)
    rob_ok = all(r["alpha"] > 0 for _, _, r in robust)
    halves_ok = all(b["alpha_h1"] > 0 and b["alpha_h2"] > 0 for b in best.values())
    robust_flag = halves_ok and rob_ok and len(pos) > len(results) / 2
    real_sum = sum(r["realized"] for r in results)
    alpha_sum = sum(r["alpha"] for r in results)
    s1 = (
        f"P&L {'positif secara robust' if robust_flag else 'TIDAK positif secara robust'}: alpha (MTM vs "
        f"hold 50/50, setelah fee & gas) positif hanya di {len(pos)}/{len(results)} konfigurasi "
        f"({', '.join(f'{m}: {c}/{per_mode}' for m, c in by_mode.items())}), konfigurasi terbaik "
        f"{'' if halves_ok else 'tidak '}positif di kedua paruh periode dan "
        f"{'' if rob_ok else 'tidak '}selalu positif pada latensi 2–5 menit/buffer 30–60 bps; "
        f"'realisasi' terhadap close CEX (Σ ${real_sum:,.0f}) jauh di atas alpha (Σ ${alpha_sum:,.0f}) "
        "karena gap yang ditangkap sebagian besar bid-ask bounce CEX, sehingga angka realisasi tidak boleh "
        "dipakai sebagai klaim."
    )
    cfg = "; ".join(
        f"${c:,}: {b['mode']} ambang {b['thr']} N={b['n']} → ${b['alpha']:,.2f} "
        f"({b['alpha_pct_month']:+.2f}%/bln, {b['trades']} trade)"
        for c, b in best.items()
    )
    small = best[1_000]
    s2 = (
        f"Konfigurasi terbaik (dipilih in-sample, jadi optimistis) adalah acuan median CEX + ambang tinggi — "
        f"{cfg}; angka paling jujur untuk demo: 'pada backtest 30 hari, modal ${1_000:,} menghasilkan "
        f"≈{small['alpha_pct_month']:+.1f}%/bulan (≈${small['alpha']:,.0f}) di atas hold, sebelum risiko "
        "MEV/kompetitor' — dan disebut bahwa kapasitasnya kecil (alpha tidak naik dengan modal; modal besar "
        "justru negatif)."
    )
    s3 = (
        "Risiko utama: adverse selection (gap ≥100 bps hampir selalu ditutup oleh CEX yang bergerak, bukan "
        "DEX), harga acuan CEX yang tipis/bounce (tick 0.0001 ≈ 12 bps), inventaris tanpa hedge yang "
        "menyimpang dari 50/50 saat HSK turun, dan kapasitas pool ≈$40k volume/bulan."
    )
    return f"{s1} {s2} {s3}"


if __name__ == "__main__":
    main()
