import { describe, expect, it } from "vitest";
import {
  createFairPriceSource,
  fetchKlines,
  med5,
  priceE18ToSqrtX96,
  sqrtBigInt,
  sqrtX96ToPriceE18,
  type Kline,
} from "../src/cex.ts";

const MIN = 60_000;
const T0 = 1_795_567_020_000; // minute boundary
const k = (minute: number, close: string, volume: number): Kline => ({
  openTimeMs: T0 + minute * MIN,
  closeE18: BigInt(Math.round(Number(close) * 1e6)) * 10n ** 12n,
  volume,
});

describe("med5 (arb_sim.py Market.ref mode=med5)", () => {
  const rows = [
    k(0, "0.0800", 10),
    k(1, "0.0810", 0),
    k(2, "0.0805", 5),
    k(3, "0.0820", 3),
    k(4, "0.0790", 1),
    k(5, "0.0815", 0),
    k(6, "0.0812", 2),
    k(7, "0.0830", 4),
  ];

  it("takes the median of the last 5 traded closes", () => {
    const r = med5(rows, T0 + 7 * MIN + 30_000);
    // traded: 0.0800 0.0805 0.0820 0.0790 0.0812 0.0830 → last 5 = 0.0805 0.0820 0.0790 0.0812 0.0830
    expect(r?.priceE18).toBe(81_200_000_000_000_000n);
    expect(r?.samples).toBe(5);
    expect(r?.lastTradeMs).toBe(T0 + 7 * MIN);
  });

  it("is null when the last trade is ≥5 minutes old", () => {
    expect(med5(rows, T0 + 11 * MIN + 59_000)).not.toBeNull();
    expect(med5(rows, T0 + 12 * MIN)).toBeNull();
    expect(med5([k(0, "0.08", 0)], T0)).toBeNull();
  });

  it("drops traded minutes older than 30 minutes and averages an even sample", () => {
    const sparse = [k(0, "0.0700", 1), k(27, "0.0800", 1), k(28, "0.0810", 1)];
    const r = med5(sparse, T0 + 31 * MIN);
    expect(r?.samples).toBe(2);
    expect(r?.priceE18).toBe(80_500_000_000_000_000n);
  });

  it("ignores klines from the future", () => {
    expect(med5([k(10, "0.09", 5)], T0 + 5 * MIN)).toBeNull();
  });
});

describe("price conversions", () => {
  it("round-trips sqrtPriceX96 ↔ USDT/WHSK", () => {
    const spot = 22523105442617287490681n;
    const p = sqrtX96ToPriceE18(spot);
    expect(Number(p) / 1e18).toBeCloseTo(0.0808, 3);
    const back = priceE18ToSqrtX96(p);
    const diff = back > spot ? back - spot : spot - back;
    expect(diff * 10n ** 12n < spot).toBe(true); // < 1e-12 relative
  });

  it("sqrtBigInt is exact floor", () => {
    for (const x of [0n, 1n, 2n, 15n, 16n, 17n, 10n ** 40n + 12345n]) {
      const r = sqrtBigInt(x);
      expect(r * r <= x && (r + 1n) * (r + 1n) > x).toBe(true);
    }
  });
});

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: string[] = [];
  const fn = async (url: string | URL | Request) => {
    calls.push(String(url));
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  };
  return { fn: fn as typeof fetch, calls };
}

const apiRows = [
  [T0, "0.0807", "0.0807", "0.0807", "0.0807", "203.3", 0, "16.4", 1, "0", "0"],
  [T0 + MIN, "0.0808", "0.0808", "0.0808", "0.0808", "0", 0, "0", 0, "0", "0"],
];

describe("fetchKlines / fair price source", () => {
  it("parses HashKey rows (string prices) and retries 429/5xx with backoff", async () => {
    const { fn, calls } = fakeFetch([{ status: 429 }, { status: 503 }, { status: 200, body: apiRows }]);
    const delays: number[] = [];
    const rows = await fetchKlines({ fetchFn: fn, sleep: async (ms) => void delays.push(ms) });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("symbol=HSKUSDT&interval=1m");
    expect(delays).toEqual([300, 600]);
    expect(rows[0]).toEqual({ openTimeMs: T0, closeE18: 80_700_000_000_000_000n, volume: 203.3 });
  });

  it("does not retry 4xx and rejects malformed payloads", async () => {
    const bad = fakeFetch([{ status: 400 }]);
    await expect(fetchKlines({ fetchFn: bad.fn })).rejects.toThrow("HTTP 400");
    expect(bad.calls).toHaveLength(1);
    const malformed = fakeFetch([{ status: 200, body: { code: -1 } }]);
    await expect(fetchKlines({ fetchFn: malformed.fn })).rejects.toThrow("expected an array");
  });

  it("caches klines for the TTL and returns null when stale", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: apiRows }]);
    let now = T0 + MIN + 10_000;
    const source = createFairPriceSource({ fetchFn: fn, ttlMs: 30_000, now: () => now });
    const a = await source();
    expect(a?.priceE18).toBe(80_700_000_000_000_000n);
    expect(a?.sqrtPriceX96).toBe(priceE18ToSqrtX96(a!.priceE18));
    now += 20_000;
    await source();
    expect(calls).toHaveLength(1);
    now += 15_000;
    await source();
    expect(calls).toHaveLength(2);
    now = T0 + 6 * MIN;
    expect(await source()).toBeNull();
  });
});
