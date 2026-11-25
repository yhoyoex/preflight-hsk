import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";
import { sqrtX96ToPriceE18, type Kline } from "../src/cex.ts";
import { ROUTER_ABI } from "../src/chain.ts";
import {
  aggregateByWallet,
  costHistogram,
  fetchGuardedSwaps,
  fetchTxSenders,
  indexSwaps,
  inferPreSqrtPrice,
  median,
  summarize,
  type IndexerLog,
} from "../src/indexer.ts";
import { decodeSwapLog, parsePoolStateJson } from "../src/pool.ts";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
// Small fixture: the first 40 on-chain swaps of the 30-day window.
const logs = (JSON.parse(fixture("swap_logs.json")) as IndexerLog[]).slice(0, 40);
const pool = parsePoolStateJson(fixture("pool_state.json"));
const tsOf = (l: IndexerLog) => Number(BigInt(l.blockTimestamp!));

/** 5 traded minutes ending at the minute of `tSec`, all at `priceE18`. */
const klinesAt = (tSec: number, priceE18: bigint): Kline[] =>
  Array.from({ length: 5 }, (_, k) => ({ openTimeMs: (Math.floor(tSec / 60) - 4 + k) * 60_000, closeE18: priceE18, volume: 1 }));

describe("indexSwaps", () => {
  it("dedupes, orders, and reproduces each swap from the previous state", () => {
    const shuffled = [...logs].reverse().concat(logs[3]!); // reversed + a duplicate
    const swaps = indexSwaps({ logs: shuffled, pool, klines: [] });
    expect(swaps).toHaveLength(40);
    expect(swaps.map((s) => s.txHash)).toEqual(logs.map((l) => l.transactionHash));
    expect(swaps[0]!.impactSource).toBe("inferred");
    for (const s of swaps.slice(1)) expect(s.impactSource).toMatch(/^sim-exact-(in|out)$/);
    const vol = logs.reduce((a, l) => {
      const ev = decodeSwapLog(l);
      return a + Number(ev.amount1 < 0n ? -ev.amount1 : ev.amount1) / 1e6;
    }, 0);
    expect(swaps.reduce((a, s) => a + s.volumeUsd, 0)).toBeCloseTo(vol, 9);
    for (const s of swaps) {
      expect(s.feeBps).toBe(30);
      expect(s.impactBps).toBeGreaterThanOrEqual(0);
      expect(s.devBps).toBeNull(); // no CEX data → stale
      expect(s.totalCostBps).toBe(s.executionCostBps);
      expect(s.totalCostUsd).toBeCloseTo((s.volumeUsd * s.totalCostBps) / 1e4, 12);
      expect(s.from).toBeNull();
    }
  });

  it("deviation vs med5: adverse for the trade direction, null when the reference is stale", () => {
    const one = logs.slice(4, 6); // swap 5 is indexed from swap 4's state
    const pre = decodeSwapLog(one[0]!).sqrtPriceX96;
    const t = tsOf(one[1]!);
    const dexE18 = sqrtX96ToPriceE18(pre);
    const cexAbove = klinesAt(t, (dexE18 * 10_100n) / 10_000n); // CEX 1% above DEX
    const s = indexSwaps({ logs: one, pool, klines: cexAbove })[1]!;
    expect(s.devBps).toBeGreaterThanOrEqual(-100);
    expect(s.devBps).toBeLessThanOrEqual(-98);
    // Buying WHSK below CEX is favourable; selling below CEX is adverse.
    expect(s.adverseDevBps).toBe(s.zeroForOne ? -s.devBps! : 0);
    expect(s.totalCostBps).toBeCloseTo(s.executionCostBps + s.adverseDevBps!, 6);

    const stale = klinesAt(t - 600, dexE18); // last trade 10 minutes earlier
    expect(indexSwaps({ logs: one, pool, klines: stale })[1]!.devBps).toBeNull();
  });

  it("inferPreSqrtPrice recovers the previous price of a non-crossing swap", () => {
    for (let i = 1; i < 10; i++) {
      const prev = decodeSwapLog(logs[i - 1]!);
      const cur = decodeSwapLog(logs[i]!);
      const got = inferPreSqrtPrice(cur, pool.feePips);
      const rel = Number(((got > prev.sqrtPriceX96 ? got - prev.sqrtPriceX96 : prev.sqrtPriceX96 - got) * 10n ** 12n) / prev.sqrtPriceX96);
      expect(rel).toBeLessThan(10); // < 1e-11 relative
    }
  });

  it("requires a timestamp", () => {
    const { blockTimestamp: _, ...noTs } = logs[0]!;
    expect(() => indexSwaps({ logs: [noTs], pool, klines: [] })).toThrow(/missing block timestamp/);
    expect(indexSwaps({ logs: [noTs], pool, klines: [], timestampOf: () => 123 })[0]!.timestamp).toBe(123);
  });
});

describe("aggregation", () => {
  const A = getAddress("0x000000000000000000000000000000000000000a");
  const B = getAddress("0x000000000000000000000000000000000000000b");
  const senders = new Map(logs.map((l, i) => [l.transactionHash.toLowerCase(), i % 4 === 0 ? B : A] as const));
  const swaps = indexSwaps({ logs, pool, klines: [], senders });

  it("per wallet: count, volume, mean/median cost, total cost", () => {
    const w = aggregateByWallet(swaps);
    expect(w.map((x) => x.swaps).reduce((a, b) => a + b, 0)).toBe(40);
    const a = w.find((x) => x.wallet === A)!;
    const mine = swaps.filter((s) => s.from === A);
    expect(a.swaps).toBe(30);
    expect(a.volumeUsd).toBeCloseTo(mine.reduce((x, s) => x + s.volumeUsd, 0), 9);
    expect(a.medianCostBps).toBe(median(mine.map((s) => s.totalCostBps)));
    expect(a.totalCostUsd).toBeCloseTo(mine.reduce((x, s) => x + s.totalCostUsd, 0), 12);
    expect(w[0]!.volumeUsd).toBeGreaterThanOrEqual(w[1]!.volumeUsd);
  });

  it("summary + histogram", () => {
    const sum = summarize(swaps);
    expect(sum).toMatchObject({ swaps: 40, uniqueWallets: 2, staleReference: 40 });
    expect(sum.feeImpactUsd).toBeCloseTo(sum.totalCostUsd, 9); // no adverse deviation without CEX data
    const h = costHistogram(swaps);
    expect(h.reduce((a, b) => a + b.swaps, 0)).toBe(40);
    expect(h[0]).toMatchObject({ fromBps: 30, toBps: 31 });
    expect(h.at(-1)!.toBps).toBeNull();
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("RPC helpers (mock transport)", () => {
  it("fetchTxSenders batches, caches and skips cached hashes", async () => {
    const seen: string[] = [];
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method !== "eth_getTransactionByHash") throw new Error(method);
          const [h] = params as [Hex];
          seen.push(h);
          return { from: getAddress(`0x${h.slice(-40)}`) };
        },
      }),
    }) as PublicClient;
    const hashes = logs.slice(0, 7).map((l) => l.transactionHash);
    const cache = new Map<string, Address>([[hashes[0]!.toLowerCase(), getAddress("0x00000000000000000000000000000000000000c0")]]);
    const rounds: number[] = [];
    const out = await fetchTxSenders(client, [...hashes, hashes[1]!.toUpperCase().replace("0X", "0x") as Hex], cache, {
      batchSize: 3,
      onProgress: (d) => void rounds.push(d),
    });
    expect(seen).toHaveLength(6);
    expect(rounds).toEqual([3, 6]);
    expect(out.size).toBe(7);
    expect(out.get(hashes[0]!.toLowerCase())).toBe("0x00000000000000000000000000000000000000C0");
  });

  it("fetchGuardedSwaps decodes GuardedSwap events in 5,000-block chunks", async () => {
    const router = getAddress("0x00000000000000000000000000000000000000bb");
    const agent = getAddress("0x00000000000000000000000000000000000a6e17");
    const poolAddr = getAddress("0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC");
    const ranges: [string, string][] = [];
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method !== "eth_getLogs") throw new Error(method);
          const [f] = params as [{ fromBlock: Hex; toBlock: Hex }];
          ranges.push([f.fromBlock, f.toBlock]);
          if (f.fromBlock !== "0x1388") return []; // only the 2nd chunk (5000..9999) has an event
          return [
            {
              address: router,
              topics: encodeEventTopics({ abi: ROUTER_ABI, eventName: "GuardedSwap", args: { agent, pool: poolAddr } }),
              data: encodeAbiParameters(
                [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
                [50_000_000n, parseUnits("616", 18), 2n, 145n, `0x${"ab".repeat(32)}`],
              ),
              blockNumber: "0x1400",
              blockHash: `0x${"01".repeat(32)}`,
              transactionHash: `0x${"02".repeat(32)}`,
              transactionIndex: "0x0",
              logIndex: "0x0",
              removed: false,
            },
          ];
        },
      }),
    }) as PublicClient;
    const feed = await fetchGuardedSwaps(client, router, 0n, 12_000n);
    expect(ranges).toEqual([
      ["0x0", "0x1387"],
      ["0x1388", "0x270f"],
      ["0x2710", "0x2ee0"],
    ]);
    expect(feed).toEqual([
      {
        txHash: `0x${"02".repeat(32)}`,
        blockNumber: 5120,
        agent,
        pool: poolAddr,
        amountIn: "50000000",
        amountOut: parseUnits("616", 18).toString(),
        impactBps: 2,
        devBps: 145,
        reasonHash: `0x${"ab".repeat(32)}`,
      },
    ]);
  });
});
