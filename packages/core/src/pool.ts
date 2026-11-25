// Uniswap V3 pool snapshot + exact-input swap simulation (integer math) for HSKSwap WHSK/USDT.
// Port of research/backtest.py (fetch_pool_state, Pool.swap) with on-chain-exact rounding.
import { hexToBigInt, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  Q96,
  computeSwapStep,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
} from "./v3math.ts";

export const HSK_CHAIN_ID = 177;
export const WHSK_USDT_POOL: Address = "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC";
export const SWAP_TOPIC: Hex = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const DEFAULT_FEE_PIPS = 3000;
/** Bitmap words scanned on each side of the current word (backtest.py :182). */
export const DEFAULT_WORD_RADIUS = 4;
export const LOG_CHUNK_BLOCKS = 5000n;

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function fee() view returns (uint24)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256, uint256, int56, uint160, uint32, bool initialized)",
]);

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tickSpacing: number;
  feePips: number;
  /** Initialized tick -> liquidityNet. Only complete within `scannedWords`. */
  ticks: ReadonlyMap<number, bigint>;
  /** Inclusive tick-bitmap word range whose initialized ticks are known. */
  scannedWords: readonly [number, number];
}

export type SwapStatus = "OK" | "OUT_OF_RANGE" | "PRICE_LIMIT";

export interface SwapResult {
  status: SwapStatus;
  amountIn: bigint; // consumed input including fee
  amountOut: bigint;
  feeAmount: bigint;
  sqrtPriceAfterX96: bigint;
  /** Raw price token1/token0 after the swap, Q96 fixed point (sqrtPrice^2 / 2^96). */
  priceAfterX96: bigint;
  tickAfter: number;
  liquidityAfter: bigint;
  ticksCrossed: number;
  /**
   * Execution cost vs pre-trade spot excluding the LP fee (same definition as GuardedRouter / REPORT.md),
   * 0.01 bps resolution. Infinity when status !== "OK" or the trade is dust (no reliable estimate).
   */
  impactBps: number;
  /** Integer bps rounded up exactly like PriceMath.impactBps on-chain (use this for quotes/policy checks). */
  impactBpsCeil: number;
  /** |price after / price before - 1| in bps. */
  priceMoveBps: number;
}

// ------------------------------------------------------------------------------------------ RPC helpers

export interface RetryOptions {
  tries?: number;
  initialDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the default retry predicate (HTTP 429/5xx, timeouts). */
  retryOn?: (err: unknown) => boolean;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return RETRY_STATUS.has(status);
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== err) return isRetryable(cause);
  const name = (err as { name?: unknown }).name;
  return name === "TimeoutError" || name === "HttpRequestError";
}

/** Exponential backoff on HTTP 429/5xx and network errors (backtest.py :47-67: 8 tries, 2 s doubling). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const tries = opts.tries ?? 8;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let delay = opts.initialDelayMs ?? 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries - 1 || !(opts.retryOn ?? isRetryable)(err)) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }
}

function compress(tick: number, spacing: number): number {
  return Math.floor(tick / spacing);
}

function wordOf(compressed: number): number {
  return compressed >> 8;
}

export interface FetchPoolOptions extends RetryOptions {
  pool?: Address;
  wordRadius?: number;
  blockNumber?: bigint;
}

/** Reads slot0, liquidity and initialized ticks within ±wordRadius bitmap words (backtest.py :175-196). */
export async function fetchPoolState(client: PublicClient, opts: FetchPoolOptions = {}): Promise<PoolState> {
  const address = opts.pool ?? WHSK_USDT_POOL;
  const radius = opts.wordRadius ?? DEFAULT_WORD_RADIUS;
  const blockNumber = opts.blockNumber ?? (await withRetry(() => client.getBlockNumber(), opts));
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    withRetry(
      () =>
        client.readContract({ address, abi: POOL_ABI, functionName, args, blockNumber } as Parameters<
          PublicClient["readContract"]
        >[0]) as Promise<T>,
      opts,
    );

  const [slot0, liquidity, spacing, fee] = await Promise.all([
    read<readonly [bigint, number, ...unknown[]]>("slot0"),
    read<bigint>("liquidity"),
    read<number>("tickSpacing"),
    read<number>("fee"),
  ]);
  const [sqrtPriceX96, tick] = slot0;
  const center = wordOf(compress(tick, spacing));
  const ticks = new Map<number, bigint>();
  for (let w = center - radius; w <= center + radius; w++) {
    const bitmap = await read<bigint>("tickBitmap", [w]);
    for (let bit = 0; bit < 256; bit++) {
      if (((bitmap >> BigInt(bit)) & 1n) === 0n) continue;
      const t = (w * 256 + bit) * spacing;
      const info = await read<readonly [bigint, bigint, ...unknown[]]>("ticks", [t]);
      ticks.set(t, info[1]);
    }
  }
  return {
    sqrtPriceX96,
    tick,
    liquidity,
    tickSpacing: spacing,
    feePips: fee,
    ticks,
    scannedWords: [center - radius, center + radius],
  };
}

/** eth_getLogs for Swap events in 5000-block chunks (RPC limit <10000; backtest.py :144). */
export async function fetchSwapLogs(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  opts: RetryOptions & { pool?: Address } = {},
): Promise<RawLog[]> {
  const address = opts.pool ?? WHSK_USDT_POOL;
  const logs: RawLog[] = [];
  for (let b = fromBlock; b <= toBlock; b += LOG_CHUNK_BLOCKS) {
    const e = b + LOG_CHUNK_BLOCKS - 1n < toBlock ? b + LOG_CHUNK_BLOCKS - 1n : toBlock;
    const chunk = await withRetry(
      () =>
        client.request({
          method: "eth_getLogs",
          params: [{ address, fromBlock: `0x${b.toString(16)}`, toBlock: `0x${e.toString(16)}`, topics: [SWAP_TOPIC] }],
        }) as Promise<RawLog[]>,
      opts,
    );
    logs.push(...chunk);
  }
  return logs;
}

// ------------------------------------------------------------------------------------------ serialization

/** Parses research/data/pool_state.json without losing precision on big integers. */
export function parsePoolStateJson(text: string, feePips = DEFAULT_FEE_PIPS): PoolState {
  const raw = JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source !== undefined
      ? BigInt(context.source)
      : value,
  ) as Record<string, unknown>;
  const big = (v: unknown, name: string): bigint => {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
    throw new TypeError(`pool state: invalid integer for ${name}`);
  };
  const int = (v: unknown, name: string): number => {
    if (typeof v === "number" && Number.isSafeInteger(v)) return v;
    throw new TypeError(`pool state: invalid number for ${name}`);
  };
  const rawTicks = raw.ticks;
  if (typeof rawTicks !== "object" || rawTicks === null) throw new TypeError("pool state: missing ticks");
  const ticks = new Map<number, bigint>();
  for (const [t, net] of Object.entries(rawTicks)) ticks.set(Number(t), big(net, `ticks[${t}]`));
  const words = raw.scanned_words ?? raw.scannedWords;
  if (!Array.isArray(words) || words.length !== 2) throw new TypeError("pool state: missing scanned_words");
  return {
    sqrtPriceX96: big(raw.sqrtPriceX96, "sqrtPriceX96"),
    tick: int(raw.tick, "tick"),
    liquidity: big(raw.liquidity, "liquidity"),
    tickSpacing: int(raw.tickSpacing, "tickSpacing"),
    feePips: typeof raw.feePips === "number" ? raw.feePips : feePips,
    ticks,
    scannedWords: [int(words[0], "scanned_words[0]"), int(words[1], "scanned_words[1]")],
  };
}

export interface RawLog {
  data: Hex;
  topics: Hex[];
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
}

export interface SwapEvent {
  blockNumber: bigint;
  logIndex: number;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

function signed(v: bigint, bits: number): bigint {
  return v >= 1n << BigInt(bits - 1) ? v - (1n << BigInt(bits)) : v;
}

export function decodeSwapLog(log: RawLog): SwapEvent {
  const hex = log.data.slice(2);
  if (hex.length !== 64 * 5) throw new TypeError(`swap log: unexpected data length ${hex.length}`);
  const w = (i: number) => BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`);
  return {
    blockNumber: hexToBigInt(log.blockNumber),
    logIndex: Number(hexToBigInt(log.logIndex)),
    amount0: signed(w(0), 256),
    amount1: signed(w(1), 256),
    sqrtPriceX96: w(2),
    liquidity: w(3),
    tick: Number(signed(w(4), 256)),
  };
}

// ------------------------------------------------------------------------------------------ simulation

/** TickBitmap.nextInitializedTickWithinOneWord over the known tick map; null if the word was not scanned. */
function nextInitializedTickWithinOneWord(
  state: PoolState,
  sortedTicks: readonly number[],
  tick: number,
  lte: boolean,
): { next: number; initialized: boolean } | null {
  const spacing = state.tickSpacing;
  const [wLo, wHi] = state.scannedWords;
  const compressed = compress(tick, spacing);
  if (lte) {
    const word = wordOf(compressed);
    if (word < wLo || word > wHi) return null;
    const bitPos = compressed - word * 256;
    const wordStart = (compressed - bitPos) * spacing;
    let best: number | undefined;
    for (const t of sortedTicks) {
      if (t >= wordStart && t <= compressed * spacing) best = t;
    }
    return best !== undefined ? { next: best, initialized: true } : { next: wordStart, initialized: false };
  }
  const c1 = compressed + 1;
  const word = wordOf(c1);
  if (word < wLo || word > wHi) return null;
  const bitPos = c1 - word * 256;
  const wordEnd = (c1 + (255 - bitPos)) * spacing;
  const found = sortedTicks.find((t) => t >= c1 * spacing && t <= wordEnd);
  return found !== undefined ? { next: found, initialized: true } : { next: wordEnd, initialized: false };
}

function bpsOf(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  return Number((numerator * 1_000_000n) / denominator) / 100;
}

/** ceil((ideal - out) * 10000 / ideal), 0 when out >= ideal (PriceMath.impactBps). Requires ideal > 0. */
export function impactBpsCeil(ideal: bigint, out: bigint): number {
  if (out >= ideal) return 0;
  const num = (ideal - out) * 10_000n;
  return Number((num + ideal - 1n) / ideal);
}

/** Output `amountIn` buys at spot after the LP fee, zero impact (matches PriceMath.spotOut). */
export function spotOut(zeroForOne: boolean, sqrtPriceX96: bigint, amountIn: bigint, feePips: number): bigint {
  const net = (amountIn * (1_000_000n - BigInt(feePips))) / 1_000_000n;
  return zeroForOne
    ? (((net * sqrtPriceX96) / Q96) * sqrtPriceX96) / Q96
    : (((net * Q96) / sqrtPriceX96) * Q96) / sqrtPriceX96;
}

/**
 * Simulates UniswapV3Pool.swap for an exact-input amount (gross, fee included) with no price limit.
 * Returns OUT_OF_RANGE when the swap would need tick-bitmap words outside `state.scannedWords`.
 */
export function simulateSwap(state: PoolState, zeroForOne: boolean, amountIn: bigint): SwapResult {
  if (amountIn <= 0n) throw new RangeError("amountIn must be positive");
  return runSwap(state, zeroForOne, amountIn);
}

/** Exact-output variant (e.g. "buy exactly N WHSK"); `amountIn` in the result is the required input incl. fee. */
export function simulateSwapExactOut(state: PoolState, zeroForOne: boolean, amountOut: bigint): SwapResult {
  if (amountOut <= 0n) throw new RangeError("amountOut must be positive");
  return runSwap(state, zeroForOne, -amountOut);
}

/** UniswapV3Pool.swap loop; amountSpecified > 0 exact input, < 0 exact output. */
function runSwap(state: PoolState, zeroForOne: boolean, amountSpecified: bigint): SwapResult {
  const exactIn = amountSpecified > 0n;
  const fee = BigInt(state.feePips);
  const sortedTicks = [...state.ticks.keys()].sort((a, b) => a - b);
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  let remaining = amountSpecified;
  let inTotal = 0n;
  let out = 0n;
  let feeTotal = 0n;
  let sqrtP = state.sqrtPriceX96;
  let tick = state.tick;
  let liquidity = state.liquidity;
  let crossed = 0;
  let status: SwapStatus = "OK";

  while (remaining !== 0n && sqrtP !== limit) {
    const start = sqrtP;
    const nxt = nextInitializedTickWithinOneWord(state, sortedTicks, tick, zeroForOne);
    if (nxt === null) {
      status = "OUT_OF_RANGE";
      break;
    }
    const tickNext = Math.min(Math.max(nxt.next, MIN_TICK), MAX_TICK);
    const sqrtNext = getSqrtRatioAtTick(tickNext);
    const target = zeroForOne ? (sqrtNext < limit ? limit : sqrtNext) : sqrtNext > limit ? limit : sqrtNext;
    const step = computeSwapStep(sqrtP, target, liquidity, remaining, fee);
    sqrtP = step.sqrtPriceNextX96;
    remaining = exactIn ? remaining - (step.amountIn + step.feeAmount) : remaining + step.amountOut;
    inTotal += step.amountIn + step.feeAmount;
    out += step.amountOut;
    feeTotal += step.feeAmount;

    if (sqrtP === sqrtNext) {
      if (nxt.initialized) {
        const net = state.ticks.get(tickNext) ?? 0n;
        liquidity += zeroForOne ? -net : net;
        if (liquidity < 0n) throw new RangeError(`negative liquidity after crossing tick ${tickNext}`);
        crossed++;
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtP !== start) {
      tick = getTickAtSqrtRatio(sqrtP);
    }
  }
  if (status === "OK" && remaining !== 0n) status = "PRICE_LIMIT";

  const used = inTotal;
  const ideal = spotOut(zeroForOne, state.sqrtPriceX96, used, state.feePips);
  const p0 = state.sqrtPriceX96 * state.sqrtPriceX96;
  const p1 = sqrtP * sqrtP;
  // A partial/unknown fill or dust (ideal == 0) must never look cheap.
  const unknown = status !== "OK" || ideal === 0n;
  return {
    status,
    amountIn: used,
    amountOut: out,
    feeAmount: feeTotal,
    sqrtPriceAfterX96: sqrtP,
    priceAfterX96: (sqrtP * sqrtP) / Q96,
    tickAfter: tick,
    liquidityAfter: liquidity,
    ticksCrossed: crossed,
    impactBps: unknown ? Number.POSITIVE_INFINITY : ideal > out ? bpsOf(ideal - out, ideal) : 0,
    impactBpsCeil: unknown ? Number.POSITIVE_INFINITY : impactBpsCeil(ideal, out),
    priceMoveBps: bpsOf(p1 > p0 ? p1 - p0 : p0 - p1, p0),
  };
}
