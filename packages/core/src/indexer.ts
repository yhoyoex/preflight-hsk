// Execution-cost indexer for the WHSK/USDT pool: every Swap log → impact (pool.ts simulation from the pre-swap
// state), LP fee, deviation vs the CEX med5 reference of that minute, and the resulting cost in bps / USD;
// aggregated per tx sender. Also reads GuardedRouter `GuardedSwap` events for a live feed.
import { getAddress, hexToBigInt, type Address, type Hex, type PublicClient } from "viem";
import { med5, priceE18ToSqrtX96, type Kline } from "./cex.ts";
import { ROUTER_ABI } from "./chain.ts";
import {
  decodeSwapLog,
  LOG_CHUNK_BLOCKS,
  simulateSwap,
  simulateSwapExactOut,
  spotOut,
  withRetry,
  type PoolState,
  type RawLog,
  type RetryOptions,
  type SwapEvent,
} from "./pool.ts";
import { Q96 } from "./v3math.ts";
import { signedDeviationBps } from "./verdict.ts";

export interface IndexerLog extends RawLog {
  /** Unix seconds as hex (HSK RPC includes it in eth_getLogs results). */
  blockTimestamp?: Hex;
}

/** How the pre-swap state used for the impact was obtained. */
export type ImpactSource = "sim-exact-in" | "sim-exact-out" | "observed" | "inferred";

export interface IndexedSwap {
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  from: Address | null;
  /** true: WHSK in (sell), false: USDT in (buy). */
  zeroForOne: boolean;
  /** |USDT leg| in USD (research/backtest.py volume definition). */
  volumeUsd: number;
  feeBps: number;
  /** Price impact excl. the LP fee vs the pre-swap spot, 0.01 bps resolution. */
  impactBps: number;
  impactSource: ImpactSource;
  /** Signed pre-swap DEX spot vs CEX med5 (positive: DEX above CEX); null when the CEX reference is stale. */
  devBps: number | null;
  /** Part of devBps that hurt this direction (0 if favourable); null when stale. */
  adverseDevBps: number | null;
  /** feeBps + impactBps ("biaya eksekusi" paid to LPs and the curve). */
  executionCostBps: number;
  /** executionCostBps + (adverseDevBps ?? 0) — same definition as the quote API's totalCostBps. */
  totalCostBps: number;
  feeUsd: number;
  impactUsd: number;
  totalCostUsd: number;
}

const FEE_UNITS = 1_000_000n;

/** Chain order; logs are deduplicated by tx hash + log index (overlapping re-fetches). */
function dedupeSorted(logs: readonly IndexerLog[]): { log: IndexerLog; ev: SwapEvent }[] {
  const seen = new Set<string>();
  const out: { log: IndexerLog; ev: SwapEvent }[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ log, ev: decodeSwapLog(log) });
  }
  return out.sort((a, b) =>
    a.ev.blockNumber === b.ev.blockNumber ? a.ev.logIndex - b.ev.logIndex : a.ev.blockNumber < b.ev.blockNumber ? -1 : 1,
  );
}

/**
 * Pre-swap sqrtPrice from the swap itself, assuming no tick was crossed (used only for the first swap of the range,
 * whose predecessor is unknown): oneForZero post = pre + net1·Q96/L; zeroForOne 1/post = 1/pre + net0/(L·Q96).
 */
export function inferPreSqrtPrice(ev: SwapEvent, feePips: number): bigint {
  const zeroForOne = ev.amount0 > 0n;
  const gross = zeroForOne ? ev.amount0 : ev.amount1;
  const net = (gross * (FEE_UNITS - BigInt(feePips))) / FEE_UNITS;
  if (ev.liquidity === 0n) return ev.sqrtPriceX96;
  if (!zeroForOne) return ev.sqrtPriceX96 - (net * Q96) / ev.liquidity;
  const lq = ev.liquidity * Q96;
  const denom = lq - net * ev.sqrtPriceX96;
  return denom > 0n ? (lq * ev.sqrtPriceX96) / denom : ev.sqrtPriceX96;
}

function observedImpactBps(zeroForOne: boolean, preSqrt: bigint, amountIn: bigint, amountOut: bigint, feePips: number): number {
  const ideal = spotOut(zeroForOne, preSqrt, amountIn, feePips);
  if (ideal <= 0n || amountOut >= ideal) return 0;
  return Number(((ideal - amountOut) * 1_000_000n) / ideal) / 100;
}

/** Impact of `cur` from the state after `prev` (pool.test.ts replay: post-swap liquidity unless a tick was crossed). */
function impactOf(
  template: PoolState,
  prev: SwapEvent | null,
  cur: SwapEvent,
): { impactBps: number; source: ImpactSource; preSqrt: bigint } {
  const zeroForOne = cur.amount0 > 0n;
  const amountIn = zeroForOne ? cur.amount0 : cur.amount1;
  const amountOut = -(zeroForOne ? cur.amount1 : cur.amount0);
  if (prev === null) {
    const preSqrt = inferPreSqrtPrice(cur, template.feePips);
    return { impactBps: observedImpactBps(zeroForOne, preSqrt, amountIn, amountOut, template.feePips), source: "inferred", preSqrt };
  }
  const preSqrt = prev.sqrtPriceX96;
  const base: PoolState = { ...template, sqrtPriceX96: preSqrt, tick: prev.tick, liquidity: cur.liquidity };
  for (const s of [base, { ...base, liquidity: prev.liquidity }]) {
    const a = simulateSwap(s, zeroForOne, amountIn);
    if (a.status === "OK" && a.amountOut === amountOut && a.sqrtPriceAfterX96 === cur.sqrtPriceX96) {
      return { impactBps: a.impactBps, source: "sim-exact-in", preSqrt };
    }
    const b = simulateSwapExactOut(s, zeroForOne, amountOut);
    if (b.status === "OK" && b.amountIn === amountIn && b.sqrtPriceAfterX96 === cur.sqrtPriceX96) {
      return { impactBps: b.impactBps, source: "sim-exact-out", preSqrt };
    }
  }
  // Simulation did not reproduce the log (e.g. liquidity changed by a mint/burn in between): measure directly.
  return { impactBps: observedImpactBps(zeroForOne, preSqrt, amountIn, amountOut, template.feePips), source: "observed", preSqrt };
}

/** Index of the last kline with openTimeMs <= t (klines sorted ascending), or -1. */
function lastAtOrBefore(klines: readonly Kline[], t: number): number {
  let lo = 0;
  let hi = klines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (klines[mid]!.openTimeMs <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface IndexSwapsInput {
  logs: readonly IndexerLog[];
  /** Pool template (tick map, spacing, fee); sqrtPrice/tick/liquidity are replaced per swap. */
  pool: PoolState;
  /** CEX 1m klines sorted by open time. */
  klines: readonly Kline[];
  /** tx hash (lowercase) → sender. */
  senders?: ReadonlyMap<string, Address>;
  /** Fallback when a log has no blockTimestamp. */
  timestampOf?: (blockNumber: bigint) => number;
  freshMin?: number;
}

export function indexSwaps(input: IndexSwapsInput): IndexedSwap[] {
  const feeBps = input.pool.feePips / 100;
  const events = dedupeSorted(input.logs);
  return events.map(({ log, ev }, i) => {
    const timestamp =
      log.blockTimestamp !== undefined ? Number(hexToBigInt(log.blockTimestamp)) : input.timestampOf?.(ev.blockNumber);
    if (timestamp === undefined) throw new Error(`swap ${log.transactionHash}: missing block timestamp`);
    const zeroForOne = ev.amount0 > 0n;
    const { impactBps, source, preSqrt } = impactOf(input.pool, i > 0 ? events[i - 1]!.ev : null, ev);

    // med5 only needs the last ~30 minutes; slice to keep the scan cheap over 30 days of klines.
    const tMs = timestamp * 1000;
    const end = lastAtOrBefore(input.klines, tMs);
    const ref = end < 0 ? null : med5(input.klines.slice(Math.max(0, end - 40), end + 1), tMs, input.freshMin);
    const devBps = ref === null ? null : signedDeviationBps(preSqrt, priceE18ToSqrtX96(ref.priceE18));
    const adverseDevBps = devBps === null ? null : Math.max(0, zeroForOne ? -devBps : devBps);

    const volumeUsd = Number(ev.amount1 < 0n ? -ev.amount1 : ev.amount1) / 1e6;
    const executionCostBps = round2(feeBps + impactBps);
    const totalCostBps = round2(executionCostBps + (adverseDevBps ?? 0));
    return {
      txHash: log.transactionHash,
      logIndex: ev.logIndex,
      blockNumber: Number(ev.blockNumber),
      timestamp,
      from: input.senders?.get(log.transactionHash.toLowerCase()) ?? null,
      zeroForOne,
      volumeUsd,
      feeBps,
      impactBps: round2(impactBps),
      impactSource: source,
      devBps,
      adverseDevBps,
      executionCostBps,
      totalCostBps,
      feeUsd: (volumeUsd * feeBps) / 1e4,
      impactUsd: (volumeUsd * impactBps) / 1e4,
      totalCostUsd: (volumeUsd * totalCostBps) / 1e4,
    };
  });
}

// ------------------------------------------------------------------------------------------ aggregation

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const mean = (xs: readonly number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export interface CostStats {
  swaps: number;
  volumeUsd: number;
  meanCostBps: number | null;
  medianCostBps: number | null;
  /** Σ totalCostUsd / Σ volumeUsd. */
  volumeWeightedCostBps: number | null;
  totalCostUsd: number;
  /** Fee + impact only (what the market paid to the LP fee and the curve). */
  feeImpactUsd: number;
}

function stats(swaps: readonly IndexedSwap[]): CostStats {
  const volumeUsd = swaps.reduce((a, s) => a + s.volumeUsd, 0);
  const totalCostUsd = swaps.reduce((a, s) => a + s.totalCostUsd, 0);
  const costs = swaps.map((s) => s.totalCostBps);
  return {
    swaps: swaps.length,
    volumeUsd,
    meanCostBps: mean(costs),
    medianCostBps: median(costs),
    volumeWeightedCostBps: volumeUsd > 0 ? (totalCostUsd / volumeUsd) * 1e4 : null,
    totalCostUsd,
    feeImpactUsd: swaps.reduce((a, s) => a + s.feeUsd + s.impactUsd, 0),
  };
}

export interface WalletStats extends CostStats {
  wallet: Address | "unknown";
  lastSwapAt: number;
}

/** Per-sender stats, highest volume first. Swaps without a known sender are grouped as "unknown". */
export function aggregateByWallet(swaps: readonly IndexedSwap[]): WalletStats[] {
  const groups = new Map<string, IndexedSwap[]>();
  for (const s of swaps) {
    const k = s.from ?? "unknown";
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  return [...groups.entries()]
    .map(([wallet, g]) => ({
      wallet: wallet as Address | "unknown",
      ...stats(g),
      lastSwapAt: Math.max(...g.map((s) => s.timestamp)),
    }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd);
}

export interface Summary extends CostStats {
  uniqueWallets: number;
  medianImpactBps: number | null;
  medianExecutionCostBps: number | null;
  /** Swaps whose CEX reference was stale (devBps null). */
  staleReference: number;
  impactSources: Record<ImpactSource, number>;
  firstSwapAt: number | null;
  lastSwapAt: number | null;
}

export function summarize(swaps: readonly IndexedSwap[]): Summary {
  const sources: Record<ImpactSource, number> = { "sim-exact-in": 0, "sim-exact-out": 0, observed: 0, inferred: 0 };
  for (const s of swaps) sources[s.impactSource]++;
  return {
    ...stats(swaps),
    uniqueWallets: new Set(swaps.filter((s) => s.from !== null).map((s) => s.from!.toLowerCase())).size,
    medianImpactBps: median(swaps.map((s) => s.impactBps)),
    medianExecutionCostBps: median(swaps.map((s) => s.executionCostBps)),
    staleReference: swaps.filter((s) => s.devBps === null).length,
    impactSources: sources,
    firstSwapAt: swaps.length ? Math.min(...swaps.map((s) => s.timestamp)) : null,
    lastSwapAt: swaps.length ? Math.max(...swaps.map((s) => s.timestamp)) : null,
  };
}

export const COST_BUCKETS_BPS = [30, 31, 32, 35, 50, 100, 200] as const;

/** Histogram of totalCostBps: [30,31), [31,32), …, [200, ∞). Values below 30 cannot occur (fee floor). */
export function costHistogram(swaps: readonly IndexedSwap[], edges: readonly number[] = COST_BUCKETS_BPS) {
  const buckets = edges.map((lo, i) => ({ fromBps: lo, toBps: edges[i + 1] ?? null, swaps: 0, volumeUsd: 0 }));
  for (const s of swaps) {
    let i = buckets.length - 1;
    while (i > 0 && s.totalCostBps < buckets[i]!.fromBps) i--;
    buckets[i]!.swaps++;
    buckets[i]!.volumeUsd += s.volumeUsd;
  }
  return buckets;
}

// ------------------------------------------------------------------------------------------ RPC

export interface FetchSendersOptions extends RetryOptions {
  /** Concurrent requests per round (batched into one HTTP call with `http(url, { batch: true })`). */
  batchSize?: number;
  /** Called after each round, e.g. to persist the cache. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

/** tx hash → `from` via eth_getTransactionByHash; fills and reuses `cache` (keys lowercase). */
export async function fetchTxSenders(
  client: PublicClient,
  hashes: readonly Hex[],
  cache: Map<string, Address> = new Map(),
  opts: FetchSendersOptions = {},
): Promise<Map<string, Address>> {
  const todo = [...new Set(hashes.map((h) => h.toLowerCase()))].filter((h) => !cache.has(h)) as Hex[];
  const size = opts.batchSize ?? 50;
  for (let i = 0; i < todo.length; i += size) {
    const round = todo.slice(i, i + size);
    const txs = await Promise.all(
      round.map((hash) =>
        withRetry(
          () => client.request({ method: "eth_getTransactionByHash", params: [hash] }) as Promise<{ from: Address } | null>,
          opts,
        ),
      ),
    );
    txs.forEach((tx, k) => {
      if (tx === null) throw new Error(`transaction ${round[k]} not found`);
      cache.set(round[k]!, getAddress(tx.from));
    });
    await opts.onProgress?.(Math.min(i + size, todo.length), todo.length);
  }
  return cache;
}

/** Logs in 5,000-block chunks with backoff, typed with `blockTimestamp` (unlike pool.ts `fetchSwapLogs`). */
export async function fetchIndexerLogs(
  client: PublicClient,
  address: Address,
  topic: Hex,
  fromBlock: bigint,
  toBlock: bigint,
  opts: RetryOptions = {},
): Promise<IndexerLog[]> {
  const logs: IndexerLog[] = [];
  for (let b = fromBlock; b <= toBlock; b += LOG_CHUNK_BLOCKS) {
    const e = b + LOG_CHUNK_BLOCKS - 1n < toBlock ? b + LOG_CHUNK_BLOCKS - 1n : toBlock;
    const chunk = await withRetry(
      () =>
        client.request({
          method: "eth_getLogs",
          params: [{ address, fromBlock: `0x${b.toString(16)}`, toBlock: `0x${e.toString(16)}`, topics: [topic] }],
        }) as Promise<IndexerLog[]>,
      opts,
    );
    logs.push(...chunk);
  }
  return logs;
}

export interface GuardedSwapFeedItem {
  txHash: Hex;
  blockNumber: number;
  agent: Address;
  pool: Address;
  amountIn: string;
  amountOut: string;
  impactBps: number;
  devBps: number;
  reasonHash: Hex;
}

/** GuardedRouter `GuardedSwap` events (newest first), 5,000-block chunks with backoff. */
export async function fetchGuardedSwaps(
  client: PublicClient,
  router: Address,
  fromBlock: bigint,
  toBlock: bigint,
  opts: RetryOptions = {},
): Promise<GuardedSwapFeedItem[]> {
  const items: GuardedSwapFeedItem[] = [];
  for (let b = fromBlock; b <= toBlock; b += LOG_CHUNK_BLOCKS) {
    const e = b + LOG_CHUNK_BLOCKS - 1n < toBlock ? b + LOG_CHUNK_BLOCKS - 1n : toBlock;
    const evs = await withRetry(
      () => client.getContractEvents({ address: router, abi: ROUTER_ABI, eventName: "GuardedSwap", fromBlock: b, toBlock: e }),
      opts,
    );
    for (const ev of evs) {
      items.push({
        txHash: ev.transactionHash,
        blockNumber: Number(ev.blockNumber),
        agent: ev.args.agent!,
        pool: ev.args.pool!,
        amountIn: ev.args.amountIn!.toString(),
        amountOut: ev.args.amountOut!.toString(),
        impactBps: Number(ev.args.impactBps!),
        devBps: Number(ev.args.devBps!),
        reasonHash: ev.args.reasonHash!,
      });
    }
  }
  return items.sort((a, b) => b.blockNumber - a.blockNumber);
}
