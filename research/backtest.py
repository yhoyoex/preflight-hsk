#!/usr/bin/env python3
"""Read-only backtest: pemulihan harga pool WHSK/USDT HSKSwap (Uniswap V3) setelah swap besar,
simulasi split order, dan selisih harga DEX vs HashKey Global (HSKUSDT).

Hanya stdlib. Hanya eth_call / eth_getBlockByNumber / eth_getLogs / HTTP GET.
Pakai: python3 backtest.py [--days 30] [--refresh]
Output (di folder script): data/*.json (cache mentah), swaps.csv, recovery_events.csv,
cex_spread.csv, REPORT.md
"""

import argparse
import bisect
import csv
import json
import math
import os
import statistics
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

RPC = "https://mainnet.hsk.xyz"
CEX_KLINES = "https://api-glb.hashkey.com/quote/v1/klines"
POOL = "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC"
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
DEC0, DEC1 = 18, 6  # WHSK, USDT
Q96 = 2**96
SEL = {  # Uniswap V3 pool selectors
    "slot0": "0x3850c7bd",
    "liquidity": "0x1a686502",
    "tickSpacing": "0xd0c93a7c",
    "tickBitmap": "0x5339c296",
    "ticks": "0xf30dba93",
}
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
UA = {"User-Agent": "hsk-research-backtest/1.0", "content-type": "application/json"}
SWAP_THRESHOLDS = (5, 10, 30, 100)
CURVE_MINUTES = [2, 5, 10, 15, 30, 60, 120, 240, 480, 1440]
GAP_START_BPS = 100  # episode DEX-vs-CEX untuk proxy pemulihan
TIMING_WINDOW_MIN = 240
TIMING_TRIGGER_BPS = 25


# ---------------------------------------------------------------- HTTP helpers
def http(url, body=None, tries=8):
    delay = 2.0
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url, data=body, headers=UA, method="POST" if body else "GET"
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(f"HTTP {e.code} for {url}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < tries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(f"network error for {url}: {e}") from e


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    res = http(RPC, body.encode())
    time.sleep(0.15)
    if "error" in res:
        raise RuntimeError(f"RPC {method} error: {res['error']}")
    return res["result"]


def call(data):
    return rpc("eth_call", [{"to": POOL, "data": data}, "latest"])


def words(hexstr):
    h = hexstr[2:] if hexstr.startswith("0x") else hexstr
    return [int(h[i : i + 64], 16) for i in range(0, len(h), 64)]


def signed(v, bits=256):
    return v - (1 << bits) if v >= 1 << (bits - 1) else v


def enc_int(v):
    return format(v % (1 << 256), "064x")


# ---------------------------------------------------------------- misc helpers
def sqrt_to_price(sqrt_x96):
    """USDT per WHSK."""
    return (sqrt_x96 / Q96) ** 2 * 10 ** (DEC0 - DEC1)


def pct(vals, q):
    if not vals:
        return float("nan")
    s = sorted(vals)
    k = (len(s) - 1) * q
    f, c = math.floor(k), math.ceil(k)
    return s[f] + (s[c] - s[f]) * (k - f)


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def fmt(v, d=1):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    return f"{v:,.{d}f}"


def cached(name, refresh, fn):
    path = os.path.join(DATA, name)
    if os.path.exists(path) and not refresh:
        with open(path) as f:
            return json.load(f)
    val = fn()
    os.makedirs(DATA, exist_ok=True)
    with open(path, "w") as f:
        json.dump(val, f)
    return val


# ---------------------------------------------------------------- data fetch
def block_ts(n):
    return int(rpc("eth_getBlockByNumber", [hex(n), False])["timestamp"], 16)


def fetch_all_logs(start, end):
    """RPC eth_getLogs, chunk 5000 blok (limit RPC <10000). Timestamp diinterpolasi linier dari
    blok sampel tiap 50k blok (block time HSK Chain ~konstan 2 s); diverifikasi oleh ts_check()."""
    logs = []
    b = start
    while b <= end:
        e = min(b + 4999, end)
        flt = {
            "address": POOL,
            "fromBlock": hex(b),
            "toBlock": hex(e),
            "topics": [SWAP_TOPIC],
        }
        logs.extend(rpc("eth_getLogs", [flt]))
        if (b - start) % 100_000 == 0:
            print(f"  logs s/d blok {e}: {len(logs)}")
        b = e + 1
    samples = sorted(set(list(range(start, end, 50_000)) + [end]))
    sample_ts = [block_ts(n) for n in samples]
    for lg in logs:
        bn = int(lg["blockNumber"], 16)
        i = min(max(bisect.bisect_right(samples, bn) - 1, 0), len(samples) - 2)
        b0, b1, t0, t1 = samples[i], samples[i + 1], sample_ts[i], sample_ts[i + 1]
        lg["timeStamp"] = hex(round(t0 + (t1 - t0) * (bn - b0) / (b1 - b0)))
    return logs


def ts_check(logs):
    """Bandingkan timestamp interpolasi vs timestamp blok asli untuk 5 swap sampel."""
    idx = [0, len(logs) // 4, len(logs) // 2, 3 * len(logs) // 4, len(logs) - 1]
    errs = []
    for i in idx:
        bn = int(logs[i]["blockNumber"], 16)
        errs.append(abs(block_ts(bn) - int(logs[i]["timeStamp"], 16)))
    return {"max_err_s": max(errs), "n": len(idx)}


def fetch_pool_state():
    s0 = words(call(SEL["slot0"]))
    liq = words(call(SEL["liquidity"]))[0]
    spacing = signed(words(call(SEL["tickSpacing"]))[0])
    sqrt_p, tick = s0[0], signed(s0[1])
    wpos = (tick // spacing) >> 8
    ticks = {}
    for w in range(wpos - 4, wpos + 5):
        bm = words(call(SEL["tickBitmap"] + enc_int(w)))[0]
        for bit in range(256):
            if bm >> bit & 1:
                t = ((w << 8) + bit) * spacing
                r = words(call(SEL["ticks"] + enc_int(t)))
                ticks[str(t)] = signed(r[1])  # liquidityNet (int128, ABI sign-extended)
    return {
        "sqrtPriceX96": sqrt_p,
        "tick": tick,
        "liquidity": liq,
        "tickSpacing": spacing,
        "ticks": ticks,
        "scanned_words": [wpos - 4, wpos + 4],
    }


def fetch_cex(start_ts, end_ts):
    rows = {}
    cur = end_ts * 1000
    start_ms = start_ts * 1000
    first_url = None
    while cur > start_ms:
        url = f"{CEX_KLINES}?symbol=HSKUSDT&interval=1m&limit=1000&endTime={cur}"
        first_url = first_url or url
        res = http(url)
        time.sleep(0.3)
        if not isinstance(res, list) or not res:
            break
        for k in res:
            rows[int(k[0])] = [int(k[0]), float(k[4]), float(k[5])]
        first = min(int(k[0]) for k in res)
        if first >= cur:
            break
        cur = first - 1
    return {
        "url_example": first_url or CEX_KLINES,
        "rows": sorted(v for v in rows.values() if v[0] >= start_ms),
    }


# ---------------------------------------------------------------- V3 swap sim (float)
class Pool:
    def __init__(self, state):
        self.sp = state["sqrtPriceX96"] / Q96  # sqrt(raw price token1/token0)
        self.L = float(state["liquidity"])
        ticks = sorted((int(t), float(n)) for t, n in state["ticks"].items())
        self.tick_list = [t for t, _ in ticks]
        self.net = dict(ticks)

    def copy(self):
        p = Pool.__new__(Pool)
        p.sp, p.L, p.tick_list, p.net = self.sp, self.L, self.tick_list, self.net
        return p

    def price(self):
        return self.sp**2 * 10 ** (DEC0 - DEC1)

    def _tick_of(self):
        return math.floor(math.log(self.sp**2) / math.log(1.0001))

    def _next(self, up):
        cur = self._tick_of()
        if up:
            i = bisect.bisect_right(self.tick_list, cur)
            nxt = self.tick_list[i] if i < len(self.tick_list) else None
            return nxt, (1.0001 ** (nxt / 2) if nxt is not None else float("inf"))
        i = bisect.bisect_right(self.tick_list, cur) - 1
        nxt = self.tick_list[i] if i >= 0 else None
        return nxt, (1.0001 ** (nxt / 2) if nxt is not None else 0.0)

    def _cross(self, nxt, up):
        self.L += self.net[nxt] if up else -self.net[nxt]
        if self.L <= 0:
            raise RuntimeError("likuiditas habis saat simulasi")

    def swap(self, amount_in_raw, zero_for_one):
        """Exact-in swap (amount_in sudah net fee). Return amount_out_raw. Mutates."""
        rem, out = amount_in_raw, 0.0
        while rem > 1e-9:
            up = not zero_for_one
            nxt, sp_b = self._next(up)
            if zero_for_one:
                need = self.L * (1 / sp_b - 1 / self.sp) if sp_b > 0 else float("inf")
                if rem < need:
                    new_sp = 1 / (1 / self.sp + rem / self.L)
                    out += self.L * (self.sp - new_sp)
                    self.sp, rem = new_sp, 0
                    continue
                out += self.L * (self.sp - sp_b)
            else:
                need = self.L * (sp_b - self.sp)
                if rem < need:
                    new_sp = self.sp + rem / self.L
                    out += self.L * (1 / self.sp - 1 / new_sp)
                    self.sp, rem = new_sp, 0
                    continue
                out += self.L * (1 / self.sp - 1 / sp_b)
            rem -= need
            self.sp = sp_b * ((1 + 1e-12) if up else (1 - 1e-12))
            self._cross(nxt, up)
        return out

    def move_price_to(self, target_price):
        """Geser harga (mewakili arbitrase/flow pihak lain); L ikut tick crossing."""
        target_sp = math.sqrt(target_price / 10 ** (DEC0 - DEC1))
        for _ in range(200):
            if abs(target_sp - self.sp) / self.sp < 1e-12:
                return
            up = target_sp > self.sp
            nxt, sp_b = self._next(up)
            if (up and target_sp < sp_b) or (not up and target_sp > sp_b):
                self.sp = target_sp
                return
            self.sp = sp_b * ((1 + 1e-12) if up else (1 - 1e-12))
            self._cross(nxt, up)


def execute(pool, usd, sell, n, recov_frac):
    """Eksekusi order `usd` (nilai pada mid awal) dalam n potongan; di antara potongan harga pulih
    sebesar recov_frac dari deviasi terhadap mid awal. Return (cost_usd, cost_bps), tanpa fee LP."""
    p = pool.copy()
    p0 = p.price()
    piece = usd / n
    cost = 0.0
    for k in range(n):
        if k > 0 and recov_frac > 0:
            cur = p.price()
            p.move_price_to(cur + (p0 - cur) * recov_frac)
        if sell:
            out = p.swap(piece / p0 * 10**DEC0, True) / 10**DEC1
            cost += piece - out
        else:
            out_whsk = p.swap(piece * 10**DEC1, False) / 10**DEC0
            cost += piece - out_whsk * p0
    return cost, cost / usd * 1e4


# ---------------------------------------------------------------- analysis
def decode(logs):
    rows, seen = [], set()
    for lg in logs:
        key = (lg["transactionHash"], lg["logIndex"])
        if key in seen:
            continue
        seen.add(key)
        w = words(lg["data"])
        rows.append(
            {
                "block": int(lg["blockNumber"], 16),
                "logIndex": int(lg["logIndex"], 16),
                "ts": int(lg["timeStamp"], 16),
                "tx": lg["transactionHash"],
                "amount0_whsk": signed(w[0]) / 10**DEC0,
                "amount1_usdt": signed(w[1]) / 10**DEC1,
                "sqrtPriceX96": w[2],
                "liquidity": w[3],
                "tick": signed(w[4]),
                "price_after": sqrt_to_price(w[2]),
            }
        )
    rows.sort(key=lambda r: (r["block"], r["logIndex"]))
    for i, r in enumerate(rows):
        r["direction"] = "sell_WHSK" if r["amount0_whsk"] > 0 else "buy_WHSK"
        r["usd"] = abs(r["amount1_usdt"])
        if i == 0:
            r["price_before"], r["impact_bps"] = None, None
        else:
            pb = rows[i - 1]["price_after"]
            r["price_before"] = pb
            r["impact_bps"] = abs(r["price_after"] - pb) / pb * 1e4
    return rows


def recovery(swaps, thr_bps, horizon=86400):
    ev = []
    for i, r in enumerate(swaps):
        if r["impact_bps"] is None or r["impact_bps"] < thr_bps:
            continue
        if r["ts"] + horizon > swaps[-1]["ts"]:
            continue  # horizon 24 jam belum lengkap di data
        pb, pa = r["price_before"], r["price_after"]
        res = {
            "idx": i,
            "block": r["block"],
            "ts": r["ts"],
            "tx": r["tx"],
            "dir": r["direction"],
            "usd": r["usd"],
            "impact_bps": r["impact_bps"],
        }
        for lvl in (50, 90):
            res[f"t{lvl}_min"] = None
            res[f"n{lvl}"] = None
            for j in range(i + 1, len(swaps)):
                s = swaps[j]
                if s["ts"] - r["ts"] > horizon:
                    break
                if (s["price_after"] - pa) / (pb - pa) >= lvl / 100:
                    res[f"t{lvl}_min"] = (s["ts"] - r["ts"]) / 60
                    res[f"n{lvl}"] = j - i
                    break
        ev.append(res)
    return ev


def swap_curve(swaps, events):
    """Fraksi pemulihan (clip 0..1) t menit setelah event swap, per event."""
    ts_list = [s["ts"] for s in swaps]
    curve = {}
    for m in CURVE_MINUTES:
        fr = []
        for e in events:
            r = swaps[e["idx"]]
            j = max(bisect.bisect_right(ts_list, r["ts"] + m * 60) - 1, e["idx"])
            f = (swaps[j]["price_after"] - r["price_after"]) / (
                r["price_before"] - r["price_after"]
            )
            fr.append(min(max(f, 0.0), 1.0))
        curve[m] = fr
    return curve


def summarize(events, key):
    vals = [e[key] for e in events if e[key] is not None]
    return vals, sum(1 for e in events if e[key] is None)


def frac_at(curve, m, q):
    """Interpolasi linier kuantil q kurva pemulihan pada menit m."""
    xs = CURVE_MINUTES
    ys = [
        (statistics.mean(curve[x]) if curve[x] else 0.0)
        if q is None
        else pct(curve[x], q)
        for x in xs
    ]
    if m <= xs[0]:
        return ys[0] * m / xs[0]
    for a, b, ya, yb in zip(xs, xs[1:], ys, ys[1:]):
        if a <= m <= b:
            return ya + (yb - ya) * (m - a) / (b - a)
    return ys[-1]


def cex_analysis(swaps, rows):
    sw_ts = [s["ts"] for s in swaps]
    series = []  # (minute_ts, dex, cex, vol, spread_bps)
    for t_ms, close, vol in rows:
        j = bisect.bisect_right(sw_ts, t_ms // 1000 + 60) - 1
        if j < 0:
            continue
        dex = swaps[j]["price_after"]
        series.append((t_ms // 1000, dex, close, vol, (dex - close) / close * 1e4))
    with open(os.path.join(HERE, "cex_spread.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["minute_ts", "dex_price", "cex_close", "cex_volume", "spread_bps"])
        w.writerows(series)
    sgn = [x[4] for x in series]
    ab = [abs(v) for v in sgn]
    episodes, cur = [], 0
    for v in ab:
        if v > 50:
            cur += 1
        elif cur:
            episodes.append(cur)
            cur = 0
    if cur:
        episodes.append(cur)

    # Proxy pemulihan: episode |gap| >= GAP_START_BPS (menit CEX bervolume), berapa bagian gap
    # yang ditutup oleh pergerakan harga DEX sendiri (dex(t)-dex0)/(cex0-dex0) pada t menit.
    gap_events, gap_curve = [], {m: [] for m in CURVE_MINUTES}
    prev_big = False
    for i, (t, dex0, cex0, vol, s0) in enumerate(series):
        big = abs(s0) >= GAP_START_BPS
        if big and not prev_big and vol > 0 and t + 86400 <= series[-1][0]:
            ev = {"t": t, "gap_bps": s0, "t50": None, "t90": None, "dex_t50": None}
            for k in range(i + 1, len(series)):
                tk, dk, ck, _, sk = series[k]
                if tk - t > 86400:
                    break
                closed = 1 - sk / s0
                dex_closed = (dk - dex0) / (cex0 - dex0)
                mins = (tk - t) / 60
                if ev["t50"] is None and closed >= 0.5:
                    ev["t50"] = mins
                if ev["t90"] is None and closed >= 0.9:
                    ev["t90"] = mins
                if ev["dex_t50"] is None and dex_closed >= 0.5:
                    ev["dex_t50"] = mins
            for m in CURVE_MINUTES:
                k = (
                    bisect.bisect_right(
                        [x[0] for x in series[i : i + m + 2]], t + m * 60
                    )
                    - 1
                    + i
                )
                dk = series[k][1]
                gap_curve[m].append(min(max((dk - dex0) / (cex0 - dex0), 0.0), 1.0))
            gap_events.append(ev)
        prev_big = big

    # Timing: mulai tiap jam, tunggu <= TIMING_WINDOW_MIN; jual saat spread >= +trigger
    # (beli saat <= -trigger), jika tidak tercapai eksekusi di akhir window. Gain vs eksekusi langsung.
    W = TIMING_WINDOW_MIN
    sell_gain, buy_gain, sell_oracle, buy_oracle = [], [], [], []
    for i in range(0, len(series) - W, 60):
        win = [x[4] for x in series[i : i + W + 1]]
        s_exec = next((v for v in win if v >= TIMING_TRIGGER_BPS), win[-1])
        b_exec = next((v for v in win if v <= -TIMING_TRIGGER_BPS), win[-1])
        sell_gain.append(s_exec - win[0])
        buy_gain.append(win[0] - b_exec)
        sell_oracle.append(max(win) - win[0])
        buy_oracle.append(win[0] - min(win))
    return {
        "n": len(series),
        "from": series[0][0],
        "to": series[-1][0],
        "signed_p50": pct(sgn, 0.5),
        "signed_mean": statistics.mean(sgn),
        "abs_p50": pct(ab, 0.5),
        "abs_p75": pct(ab, 0.75),
        "abs_p90": pct(ab, 0.9),
        "abs_p99": pct(ab, 0.99),
        "share_gt50": sum(1 for v in ab if v > 50) / len(ab),
        "share_gt100": sum(1 for v in ab if v > 100) / len(ab),
        "dex_above50": sum(1 for v in sgn if v > 50) / len(sgn),
        "dex_below50": sum(1 for v in sgn if v < -50) / len(sgn),
        "episodes": len(episodes),
        "ep_p50": pct(episodes, 0.5),
        "ep_p75": pct(episodes, 0.75),
        "ep_max": max(episodes) if episodes else 0,
        "zero_vol_share": sum(1 for x in series if x[3] == 0) / len(series),
        "gap_events": gap_events,
        "gap_curve": gap_curve,
        "timing": {
            "starts": len(sell_gain),
            "sell_mean": statistics.mean(sell_gain),
            "sell_p50": pct(sell_gain, 0.5),
            "buy_mean": statistics.mean(buy_gain),
            "buy_p50": pct(buy_gain, 0.5),
            "sell_oracle": statistics.mean(sell_oracle),
            "buy_oracle": statistics.mean(buy_oracle),
        },
    }


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--refresh", action="store_true", help="abaikan cache data/")
    args = ap.parse_args()

    def latest_meta():
        b = rpc("eth_getBlockByNumber", ["latest", False])
        n = int(b["number"], 16)
        return {
            "latest_block": n,
            "latest_ts": int(b["timestamp"], 16),
            "ref_ts": block_ts(n - 100_000),
        }

    meta = cached("meta.json", args.refresh, latest_meta)
    latest = meta["latest_block"]
    block_time = (meta["latest_ts"] - meta["ref_ts"]) / 100_000
    start = latest - int(args.days * 86400 / block_time)
    print(
        f"latest {latest} ({iso(meta['latest_ts'])}), block time {block_time:.3f}s, start {start}"
    )

    logs = cached("swap_logs.json", args.refresh, lambda: fetch_all_logs(start, latest))
    state = cached("pool_state.json", args.refresh, fetch_pool_state)
    tsc = cached("ts_check.json", args.refresh, lambda: ts_check(logs))
    swaps = decode(logs)
    print(
        f"swaps {len(swaps)}; ts interpolasi galat maks {tsc['max_err_s']}s ({tsc['n']} sampel)"
    )

    with open(os.path.join(HERE, "swaps.csv"), "w", newline="") as f:
        cols = [
            "block",
            "logIndex",
            "ts",
            "tx",
            "direction",
            "amount0_whsk",
            "amount1_usdt",
            "usd",
            "price_before",
            "price_after",
            "impact_bps",
            "tick",
            "liquidity",
            "sqrtPriceX96",
        ]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(swaps)

    # ---- pemulihan berbasis swap
    rec = {thr: recovery(swaps, thr) for thr in SWAP_THRESHOLDS}
    with open(os.path.join(HERE, "recovery_events.csv"), "w", newline="") as f:
        cols = [
            "threshold_bps",
            "block",
            "ts",
            "tx",
            "dir",
            "usd",
            "impact_bps",
            "t50_min",
            "n50",
            "t90_min",
            "n90",
        ]
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for thr, evs in rec.items():
            for e in evs:
                w.writerow({"threshold_bps": thr, **e})
    curve_thr = max(
        (t for t in SWAP_THRESHOLDS if len(rec[t]) >= 20), default=SWAP_THRESHOLDS[0]
    )
    s_curve = swap_curve(swaps, rec[curve_thr])

    # ---- CEX (opsional)
    cex_note, spread = None, None
    try:
        cex = cached(
            "cex_klines.json",
            args.refresh,
            lambda: fetch_cex(swaps[0]["ts"], swaps[-1]["ts"]),
        )
        if len(cex["rows"]) < 100:
            raise RuntimeError(f"hanya {len(cex['rows'])} kline")
        spread = cex_analysis(swaps, cex["rows"])
        spread["url"] = cex["url_example"]
    except (RuntimeError, ValueError, KeyError) as e:
        cex_note = (
            f"tidak tersedia: {e} (URL dicoba: {CEX_KLINES}?symbol=HSKUSDT&interval=1m)"
        )

    # ---- simulasi
    pool = Pool(state)
    # Interval: 60 mnt, ~median t50 event swap (136 mnt pada data ini), 240 mnt, 1440 mnt.
    t50_vals, _ = summarize(rec[curve_thr], "t50_min")
    intervals = sorted(
        {60, 240, 1440}
        | ({int(round(statistics.median(t50_vals)))} if t50_vals else set())
    )
    g_curve = spread["gap_curve"] if spread and spread["gap_events"] else None
    sims = []
    for usd in (10_000, 50_000):
        for sell in (True, False):
            c1, b1 = execute(pool, usd, sell, 1, 0)
            for n in (5, 10, 20):
                for iv in intervals:
                    row = {
                        "usd": usd,
                        "side": "jual WHSK" if sell else "beli WHSK",
                        "n": n,
                        "iv": iv,
                        "total_h": iv * (n - 1) / 60,
                        "once_bps": b1,
                        "once_usd": c1,
                    }
                    curves = {"a_med": (s_curve, 0.5), "a_mean": (s_curve, None)}
                    if g_curve:
                        curves.update(
                            {"b_med": (g_curve, 0.5), "b_mean": (g_curve, None)}
                        )
                    for key, (cv, q) in curves.items():
                        f = frac_at(cv, iv, q)
                        c, _ = execute(pool, usd, sell, n, f)
                        row[key] = (f, c1 - c, (c1 - c) / usd * 1e4)
                    sims.append(row)
    min_size = {}
    for sell in (True, False):
        for thr in (10, 30, 100):
            lo, hi = 1.0, 2_000_000.0
            for _ in range(60):
                mid = math.sqrt(lo * hi)
                if execute(pool, mid, sell, 1, 0)[1] >= thr:
                    hi = mid
                else:
                    lo = mid
            min_size[(sell, thr)] = hi

    write_report(
        {
            "meta": meta,
            "start": start,
            "block_time": block_time,
            "swaps": swaps,
            "tsc": tsc,
            "rec": rec,
            "curve_thr": curve_thr,
            "s_curve": s_curve,
            "state": state,
            "p_now": pool.price(),
            "sims": sims,
            "min_size": min_size,
            "spread": spread,
            "cex_note": cex_note,
        }
    )
    print("REPORT.md ditulis")


def conclusion(d):
    """Kesimpulan 3 kalimat; angka diambil dari hasil, interpretasi tetap (ditinjau manual)."""
    ev = d["rec"][SWAP_THRESHOLDS[0]]
    _, never = summarize(ev, "t50_min")
    sims = {(s["usd"], s["side"], s["n"], s["iv"]): s for s in d["sims"]}
    s10 = sims.get((10_000, "jual WHSK", 10, 240))
    s50 = sims.get((50_000, "jual WHSK", 20, 240))
    ms = d["min_size"]
    sp = d["spread"]
    st = d["state"]
    depth = (
        st["liquidity"] * st["sqrtPriceX96"] / Q96 / 10**DEC1
    )  # L*sqrtP = virtual USDT reserve
    gap = ""
    if sp and sp["gap_events"]:
        ge = sp["gap_events"]
        dex_closed = sum(1 for e in ge if e["dex_t50"] is not None)
        gap = (
            f"; dari {len(ge)} episode selisih DEX−CEX ≥{GAP_START_BPS} bps, harga DEX sendiri hanya "
            f"menutup ≥50% gap pada {dex_closed} episode (sisanya CEX yang bergerak)"
        )
    timing = ""
    if sp:
        t = sp["timing"]
        timing = (
            f" Klaim yang jujur untuk demo: (1) agent mengukur & menampilkan biaya dampak nyata sebelum eksekusi "
            f"(order $10k sekaligus ≈{s10['once_bps']:.0f} bps, $50k ≈{s50['once_bps']:.0f} bps), (2) timing "
            f"terhadap harga CEX untuk order kecil memperbaiki harga rata-rata ≈{t['sell_mean']:.0f}–"
            f"{t['buy_mean']:.0f} bps (median {t['sell_p50']:.0f}–{t['buy_p50']:.0f} bps) dengan tunggu "
            f"≤{TIMING_WINDOW_MIN // 60} jam, dan (3) split hanya disebut 'hingga' ≈"
            f"{s50['b_mean'][2]:.0f} bps untuk $50k/20 potongan/{s50['iv'] // 60} jam ({s50['total_h']:.0f} jam total) "
            f"di skenario optimistis — bukan angka tipikal."
        )
    return (
        f"1. **Split order tidak memberi penghematan nyata pada kasus tipikal di pool ini (timing vs CEX hanya membantu order kecil)**: dalam 30 hari tidak "
        f"ada satu pun swap ≥30 bps, dan setelah swap ≥{SWAP_THRESHOLDS[0]} bps harga median **tidak pulih sama sekali** "
        f"({never}/{len(ev)} tidak pulih 50% dalam 24 jam){gap} — artinya praktis tidak ada arbitrase aktif yang "
        f"mengembalikan harga di antara potongan, sehingga split ≈ sekaligus (hemat median 0).\n"
        f"2.{timing}\n"
        f"3. Ukuran order minimum yang membuat agent berguna: ≈${ms[(True, 30)]:,.0f} (dampak ≥30 bps, setara fee tier) "
        f"dan jelas berguna ≥${ms[(True, 100)]:,.0f} (dampak ≥100 bps); untuk order ≥$10k nilai terbesar agent adalah "
        f"menyarankan venue lain (CEX/OTC) atau menunda/menolak, karena cadangan virtual pool hanya ≈${depth:,.0f} USDT per sisi dan "
        f"volume DEX 30 hari total ≈${sum(s['usd'] for s in d['swaps']):,.0f}.\n"
    )


def write_report(d):
    swaps, rec, spread, state = d["swaps"], d["rec"], d["spread"], d["state"]
    impacts = [s["impact_bps"] for s in swaps if s["impact_bps"] is not None]
    usds = [s["usd"] for s in swaps]
    days = (swaps[-1]["ts"] - swaps[0]["ts"]) / 86400
    L = []
    a = L.append
    a("# Backtest pemulihan harga — HSKSwap WHSK/USDT 0.3%\n")
    a(f"Dibuat otomatis oleh `backtest.py` (read-only). Pool `{POOL}`.\n")
    a("## Data\n")
    a(
        f"- Rentang blok: {d['start']:,} – {d['meta']['latest_block']:,} (block time ≈{d['block_time']:.2f} s)"
    )
    a(
        f"- Swap pertama/terakhir: {iso(swaps[0]['ts'])} → {iso(swaps[-1]['ts'])} ({days:.1f} hari)"
    )
    a(
        f"- Jumlah swap: **{len(swaps)}** (≈{len(swaps) / days:.0f}/hari). Sumber: RPC `eth_getLogs` "
        f"(chunk 5000 blok); timestamp diinterpolasi dari blok sampel tiap 50k blok, galat maks "
        f"{d['tsc']['max_err_s']} s pada {d['tsc']['n']} swap sampel (Blockscout API kena rate-limit 429, tidak dipakai)."
    )
    a(
        f"- Ukuran swap (USD): median {fmt(pct(usds, 0.5), 0)}, p90 {fmt(pct(usds, 0.9), 0)}, "
        f"p99 {fmt(pct(usds, 0.99), 0)}, maks {fmt(max(usds), 0)}; total volume ≈{fmt(sum(usds), 0)}"
    )
    a(
        f"- Dampak harga per swap (bps): median {fmt(pct(impacts, 0.5))}, p90 {fmt(pct(impacts, 0.9))}, "
        f"p99 {fmt(pct(impacts, 0.99))}, maks {fmt(max(impacts))}; jumlah ≥30 bps: "
        f"{sum(1 for x in impacts if x >= 30)}, ≥100 bps: {sum(1 for x in impacts if x >= 100)}"
    )
    a(
        f"- State pool sekarang: harga {d['p_now']:.5f} USDT/WHSK, tick {state['tick']}, liquidity "
        f"{state['liquidity']:,}, tickSpacing {state['tickSpacing']}, {len(state['ticks'])} tick "
        f"terinisialisasi (word {state['scanned_words']})\n"
    )

    a("## Pemulihan setelah swap berdampak besar\n")
    a(
        "Pemulihan X% = harga pool (setelah swap berikutnya) kembali ≥X% jarak menuju harga sebelum swap. "
        "Event yang horizon 24 jamnya belum lengkap dikecualikan.\n"
    )
    a(
        "| Ambang | Event | Level | Median menit | p75 menit | Maks menit | Median #swap | p75 #swap | Tidak pulih ≤24 j |"
    )
    a("|---|---|---|---|---|---|---|---|---|")
    for thr, evs in rec.items():
        for lvl in (50, 90):
            tv, never = summarize(evs, f"t{lvl}_min")
            nv, _ = summarize(evs, f"n{lvl}")
            share = (
                f"{never}/{len(evs)} ({never / len(evs) * 100:.0f}%)" if evs else "—"
            )
            a(
                f"| ≥{thr} bps | {len(evs)} | {lvl}% | {fmt(pct(tv, 0.5))} | {fmt(pct(tv, 0.75))} | "
                f"{fmt(max(tv) if tv else None)} | {fmt(pct(nv, 0.5), 0)} | {fmt(pct(nv, 0.75), 0)} | {share} |"
            )

    a(
        f"\nKurva fraksi pemulihan. **A** = berbasis swap (event ≥{d['curve_thr']} bps; ambang tertinggi dengan ≥20 event). "
        f"**B** = proxy arbitrase: episode |DEX−CEX| ≥{GAP_START_BPS} bps, fraksi gap yang ditutup oleh pergerakan harga DEX sendiri.\n"
    )
    g = spread["gap_curve"] if spread and spread["gap_events"] else None
    a("| Menit setelah | A p25 | A median | A mean | B p25 | B median | B mean |")
    a("|---|---|---|---|---|---|---|")
    for m in CURVE_MINUTES:
        v = d["s_curve"][m]
        gv = g[m] if g else []
        a(
            f"| {m} | {fmt(pct(v, 0.25), 2)} | {fmt(pct(v, 0.5), 2)} | {fmt(statistics.mean(v) if v else None, 2)} | "
            f"{fmt(pct(gv, 0.25), 2)} | {fmt(pct(gv, 0.5), 2)} | {fmt(statistics.mean(gv) if gv else None, 2)} |"
        )

    a("\n## Simulasi split order (biaya dampak, di luar fee LP 0.3%)\n")
    a(
        "Model: swap disimulasikan dengan tick map pool saat ini (likuiditas konstan di antara tick terinisialisasi, "
        "matematika Uniswap V3). Antar-potongan, harga pool digeser kembali ke harga awal sebesar fraksi pemulihan "
        "median atau mean kurva A/B pada interval tsb (median = kasus tipikal; mean = optimistis, didorong sedikit event "
        "yang pulih). Biaya = nilai pada harga mid awal − hasil diterima. Fee 0.3% identik di kedua strategi sehingga "
        "tidak dihitung. Tanpa pemulihan, split = sekaligus (path-independent). Sel hemat = `USD (bps dari ukuran order)`.\n"
    )

    def cell(s, key):
        if key not in s:
            return "—", "—"
        f, usd_save, bps_save = s[key]
        usd_save, bps_save = (0.0, 0.0) if abs(usd_save) < 0.5 else (usd_save, bps_save)
        return f"{f:.2f}", f"{usd_save:,.0f} ({bps_save:.0f})"

    a(
        "| Ukuran USD | Sisi | N | Interval (mnt) | Durasi (j) | Sekaligus bps | Sekaligus USD | Hemat A-median | "
        "A-mean pulih | Hemat A-mean | Hemat B-median | B-mean pulih | Hemat B-mean |"
    )
    a("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for s in d["sims"]:
        am, bm = cell(s, "a_med"), cell(s, "b_med")
        aa, ba = cell(s, "a_mean"), cell(s, "b_mean")
        a(
            f"| {s['usd']:,} | {s['side']} | {s['n']} | {s['iv']} | {s['total_h']:.1f} | {s['once_bps']:.0f} | "
            f"{s['once_usd']:,.0f} | {am[1]} | {aa[0]} | {aa[1]} | {bm[1]} | {ba[0]} | **{ba[1]}** |"
        )
    a("\nUkuran order (USD) yang menimbulkan biaya dampak sekaligus (di luar fee):\n")
    a("| Sisi | ≥10 bps | ≥30 bps | ≥100 bps |")
    a("|---|---|---|---|")
    for sell, name in ((True, "jual WHSK"), (False, "beli WHSK")):
        ms = d["min_size"]
        a(
            f"| {name} | {ms[(sell, 10)]:,.0f} | {ms[(sell, 30)]:,.0f} | {ms[(sell, 100)]:,.0f} |"
        )

    a("\n## DEX vs CEX (HashKey Global HSKUSDT, kline 1 menit)\n")
    if spread:
        t = spread["timing"]
        ge = spread["gap_events"]
        a(f"- Sumber: `{spread['url']}` (endpoint publik, paginasi endTime)")
        a(
            f"- Menit dibandingkan: {spread['n']:,} ({iso(spread['from'])} → {iso(spread['to'])}); "
            f"menit dengan volume CEX 0: {spread['zero_vol_share'] * 100:.0f}% (close CEX sering basi)"
        )
        a(
            f"- Selisih DEX−CEX (bps, bertanda): median {spread['signed_p50']:.0f}, mean {spread['signed_mean']:.0f}"
        )
        a(
            f"- |selisih| bps: median {spread['abs_p50']:.0f}, p75 {spread['abs_p75']:.0f}, "
            f"p90 {spread['abs_p90']:.0f}, p99 {spread['abs_p99']:.0f}"
        )
        a(
            f"- Porsi waktu |selisih| >50 bps: {spread['share_gt50'] * 100:.1f}% (DEX di atas: "
            f"{spread['dex_above50'] * 100:.1f}%, di bawah: {spread['dex_below50'] * 100:.1f}%); >100 bps: "
            f"{spread['share_gt100'] * 100:.1f}%"
        )
        a(
            f"- Episode |selisih| >50 bps: {spread['episodes']}, durasi median {fmt(spread['ep_p50'], 0)} mnt, "
            f"p75 {fmt(spread['ep_p75'], 0)} mnt, maks {spread['ep_max']} mnt"
        )
        if ge:
            t50 = [e["t50"] for e in ge if e["t50"] is not None]
            t90 = [e["t90"] for e in ge if e["t90"] is not None]
            dt50 = [e["dex_t50"] for e in ge if e["dex_t50"] is not None]
            a(
                f"- Episode gap ≥{GAP_START_BPS} bps (awal di menit CEX bervolume): {len(ge)}; gap tertutup 50% "
                f"median {fmt(pct(t50, 0.5), 0)} mnt ({len(t50)}/{len(ge)} dalam 24 j), 90% median "
                f"{fmt(pct(t90, 0.5), 0)} mnt ({len(t90)}/{len(ge)}); ditutup ≥50% oleh gerak harga DEX: "
                f"{len(dt50)}/{len(ge)}, median {fmt(pct(dt50, 0.5), 0)} mnt"
            )
        a(
            f"- Timing (mulai tiap jam, {spread['timing']['starts']} sampel, tunggu ≤{TIMING_WINDOW_MIN} mnt, "
            f"eksekusi saat selisih menguntungkan ≥{TIMING_TRIGGER_BPS} bps, else akhir window): perbaikan harga "
            f"relatif CEX vs eksekusi langsung — jual mean {t['sell_mean']:.0f} bps (median {t['sell_p50']:.0f}), "
            f"beli mean {t['buy_mean']:.0f} bps (median {t['buy_p50']:.0f}); batas atas oracle (titik terbaik di window): "
            f"jual {t['sell_oracle']:.0f} bps, beli {t['buy_oracle']:.0f} bps."
        )
        a(
            "- Catatan: harga DEX = harga setelah swap terakhir sebelum akhir menit; CEX = close kline. Timing hanya "
            "berlaku untuk order kecil (tidak memperhitungkan dampak order sendiri)."
        )
    else:
        a(f"- {d['cex_note']}")

    a("\n## Kesimpulan\n")
    a(conclusion(d))
    a("## Asumsi & batasan\n")
    a(
        "- Harga sebelum swap = sqrtPrice swap sebelumnya (mint/burn tidak menggeser harga)."
    )
    a(
        "- Pemulihan hanya teramati saat ada swap berikutnya (resolusi waktu = jeda antar-swap)."
    )
    a(
        "- Simulasi memakai tick map saat ini; likuiditas historis bisa berbeda. Fraksi pemulihan kurva A diukur dari "
        "swap kecil (tidak ada swap ≥30 bps) dan diasumsikan berlaku proporsional untuk deviasi besar akibat order sendiri "
        "— ini asumsi optimistis; kurva B lebih relevan karena mengukur apakah harga DEX bergerak kembali ke harga CEX."
    )
    a(
        "- Pemulihan empiris mencampur arbitrase dan pergerakan pasar (drift); tidak ada kausalitas yang diklaim."
    )
    a(
        "- Tidak memperhitungkan gas (murah di HSK Chain) maupun risiko harga selama durasi eksekusi."
    )
    with open(os.path.join(HERE, "REPORT.md"), "w") as f:
        f.write("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
