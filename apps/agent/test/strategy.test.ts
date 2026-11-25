// Fixtures generated from research/arb_sim.py (Market.ref mode=med5, size_trade) on research/data/cex_klines.json.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { med5, type Kline } from "@preflight/core";
import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { decide, gasUsd, priceOf, signal, sizeTrade, spOf } from "../src/strategy.ts";

interface Fixture {
  constants: { gasUsdAt0_08: number };
  rows: [number, number, number][];
  refs: { i: number; n: number; ref: number | null }[];
  sizeCases: {
    sp: number;
    L: number;
    ref: number;
    sell: boolean;
    whsk: number;
    usdt: number;
    maxUsd: number;
    out: [number, number, number] | null;
  }[];
}

const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/arb_sim.json", import.meta.url)), "utf8"),
) as Fixture;
const klines: Kline[] = fx.rows.map(([openTimeMs, close, volume]) => ({
  openTimeMs,
  closeE18: parseUnits(String(close), 18),
  volume,
}));

const close = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-30);

describe("med5 trigger reference (core med5 vs arb_sim Market.ref)", () => {
  it("matches all 240 research samples (fresh n = 1 and 5)", () => {
    let nulls = 0;
    for (const { i, n, ref } of fx.refs) {
      const row = fx.rows[i]!;
      const got = med5(klines.slice(0, i + 1), row[0] + 30_000, n);
      if (ref === null) {
        nulls++;
        expect(got, `i=${i} n=${n}`).toBeNull();
      } else {
        expect(got, `i=${i} n=${n}`).not.toBeNull();
        expect(Number(got!.priceE18) / 1e18).toBeCloseTo(ref, 12);
      }
    }
    expect(nulls).toBeGreaterThan(0);
    expect(nulls).toBeLessThan(fx.refs.length);
  });
});

describe("size_trade port", () => {
  it("matches all 30 research cases", () => {
    for (const c of fx.sizeCases) {
      const got = sizeTrade(c.sp, c.L, c.ref, c.sell, c.whsk, c.usdt, c.maxUsd);
      if (c.out === null) {
        expect(got).toBeNull();
        continue;
      }
      expect(got).not.toBeNull();
      expect(close(got!.target, c.out[0])).toBe(true);
      expect(close(got!.amountIn, c.out[1])).toBe(true);
      expect(close(got!.amountOut, c.out[2])).toBe(true);
    }
  });

  it("gas and price helpers match arb_sim", () => {
    expect(close(gasUsd(0.08), fx.constants.gasUsdAt0_08)).toBe(true);
    expect(close(priceOf(spOf(0.0813)), 0.0813)).toBe(true);
  });
});

describe("trigger (100 bps) + decide", () => {
  const c0 = fx.sizeCases[0]!;
  const dex = priceOf(c0.sp);

  it("fires only beyond the threshold", () => {
    expect(signal(dex, dex / 1.0099)).toBeNull(); // ~99 bps
    expect(signal(dex, dex / 1.0101)).toEqual({ gapBps: expect.closeTo(101, 0), sell: true });
    expect(signal(dex, dex / 0.985)?.sell).toBe(false);
  });

  it("buy when DEX is cheap, capped at 50% of capital", () => {
    const d = decide({ sp: c0.sp, L: c0.L, ref: dex * 1.015, whsk: 0, usdt: 1_000, capitalUsd: 100 });
    expect("hold" in d).toBe(false);
    if ("hold" in d) return;
    expect(d.sell).toBe(false);
    expect(d.maxAmountIn).toBeLessThanOrEqual(50 + 1e-9);
    expect(d.maxAmountIn).toBeGreaterThan(49);
    expect(d.minAmountIn).toBe(1);
    expect(d.edgeUsd).toBeGreaterThanOrEqual(2 * d.gasUsd);
  });

  it("holds inside the band, without inventory, or below gas", () => {
    expect(decide({ sp: c0.sp, L: c0.L, ref: dex, whsk: 1e6, usdt: 1e6, capitalUsd: 100 })).toMatchObject({ hold: true, why: "no-signal" });
    expect(decide({ sp: c0.sp, L: c0.L, ref: dex / 1.02, whsk: 0, usdt: 1e6, capitalUsd: 100 })).toMatchObject({ hold: true });
    expect(decide({ sp: c0.sp, L: c0.L, ref: dex * 1.015, whsk: 0, usdt: 1e6, capitalUsd: 0.01 })).toMatchObject({ hold: true });
  });
});
