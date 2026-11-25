// HashKey Global HSKUSDT 1m klines → fair reference price (research/backtest.py :205, arb_sim.py :84-94 "med5").
import { parseUnits } from "viem";
import { withRetry, type RetryOptions } from "./pool.ts";
import { Q96 } from "./v3math.ts";

export const CEX_KLINES_URL = "https://api-glb.hashkey.com/quote/v1/klines";
export const CEX_SYMBOL = "HSKUSDT";
/** Median over the last K traded minutes (arb_sim.py MED_K). */
export const MED_K = 5;
/** Traded minutes older than this are ignored for the median (arb_sim.py MED_WINDOW_MIN). */
export const MED_WINDOW_MIN = 30;
/** Reference is stale when the last traded minute is ≥ N minutes old (arb_sim.py FRESH_N max). */
export const DEFAULT_FRESH_MIN = 5;
export const DEFAULT_CACHE_TTL_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 5_000;

const PRICE_DECIMALS = 18;
const E18 = 10n ** 18n;
/** WHSK (token0) and USDT (token1) decimals on HSK Chain. */
const TOKEN0_DECIMALS = 18n;
const TOKEN1_DECIMALS = 6n;

export interface Kline {
  openTimeMs: number;
  /** Close price, USDT per HSK, 18-decimal fixed point. */
  closeE18: bigint;
  volume: number;
}

export interface FairPrice {
  /** USDT per WHSK, 18-decimal fixed point. */
  priceE18: bigint;
  /** Same price as a Uniswap V3 sqrtPriceX96 (token1/token0 raw units). */
  sqrtPriceX96: bigint;
  /** Open time of the most recent traded minute used. */
  lastTradeMs: number;
  samples: number;
  source: string;
}

export class CexHttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "CexHttpError";
  }
}

function retryOn(err: unknown): boolean {
  if (err instanceof CexHttpError) return [429, 500, 502, 503, 504].includes(err.status);
  // fetch() network failures surface as TypeError; AbortSignal.timeout() as TimeoutError.
  return err instanceof TypeError || (err instanceof Error && err.name === "TimeoutError");
}

function parseKlines(raw: unknown): Kline[] {
  if (!Array.isArray(raw)) throw new TypeError("cex klines: expected an array");
  return raw.map((row, i) => {
    if (!Array.isArray(row) || row.length < 6) throw new TypeError(`cex klines: malformed row ${i}`);
    const [open, , , , close, volume] = row as unknown[];
    const closeStr = String(close);
    if (!/^\d+(\.\d+)?$/.test(closeStr)) throw new TypeError(`cex klines: invalid close at row ${i}`);
    const vol = Number(volume);
    const openTimeMs = Number(open);
    if (!Number.isFinite(vol) || !Number.isSafeInteger(openTimeMs)) {
      throw new TypeError(`cex klines: invalid open/volume at row ${i}`);
    }
    return { openTimeMs, closeE18: parseUnits(closeStr, PRICE_DECIMALS), volume: vol };
  });
}

export interface FetchKlinesOptions extends RetryOptions {
  limit?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

/** Latest 1m klines, oldest first. Retries 429/5xx/network/timeouts with exponential backoff. */
export async function fetchKlines(opts: FetchKlinesOptions = {}): Promise<Kline[]> {
  const url = `${opts.baseUrl ?? CEX_KLINES_URL}?symbol=${CEX_SYMBOL}&interval=1m&limit=${opts.limit ?? 60}`;
  const fetchFn = opts.fetchFn ?? fetch;
  const rows = await withRetry(
    async () => {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
      if (!res.ok) throw new CexHttpError(res.status, url);
      return parseKlines(await res.json());
    },
    { tries: 3, initialDelayMs: 300, ...opts, retryOn },
  );
  return [...rows].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

/**
 * med5 reference: median close of the last MED_K traded minutes within MED_WINDOW_MIN, or null when the
 * last traded minute is ≥ freshMin minutes before the current minute (arb_sim.py Market.ref).
 */
export function med5(
  klines: readonly Kline[],
  nowMs: number,
  freshMin = DEFAULT_FRESH_MIN,
): { priceE18: bigint; lastTradeMs: number; samples: number } | null {
  const nowMinute = Math.floor(nowMs / 60_000);
  const traded = klines.filter((k) => k.volume > 0 && Math.floor(k.openTimeMs / 60_000) <= nowMinute);
  const last = traded.at(-1);
  if (last === undefined || nowMinute - Math.floor(last.openTimeMs / 60_000) >= freshMin) return null;
  const window = traded
    .slice(-MED_K)
    .filter((k) => nowMinute - Math.floor(k.openTimeMs / 60_000) < MED_WINDOW_MIN)
    .map((k) => k.closeE18)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(window.length / 2);
  const hi = window[mid];
  if (hi === undefined) return null;
  const lo = window[mid - 1];
  const priceE18 = window.length % 2 === 1 || lo === undefined ? hi : (lo + hi) / 2n;
  return { priceE18, lastTradeMs: last.openTimeMs, samples: window.length };
}

/** Integer square root (floor). */
export function sqrtBigInt(x: bigint): bigint {
  if (x < 0n) throw new RangeError("sqrt of negative");
  if (x < 2n) return x;
  let r = BigInt(Math.floor(Math.sqrt(Number(x))));
  while (r * r > x) r = (r + x / r) / 2n;
  while ((r + 1n) * (r + 1n) <= x) r += 1n;
  return r;
}

/** USDT-per-WHSK (1e18 fixed point) → sqrtPriceX96 of the WHSK/USDT pool. */
export function priceE18ToSqrtX96(priceE18: bigint): bigint {
  return sqrtBigInt((priceE18 * 10n ** TOKEN1_DECIMALS * Q96 * Q96) / (E18 * 10n ** TOKEN0_DECIMALS));
}

/** sqrtPriceX96 of the WHSK/USDT pool → USDT per WHSK (1e18 fixed point). */
export function sqrtX96ToPriceE18(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * E18 * 10n ** TOKEN0_DECIMALS) / (Q96 * Q96 * 10n ** TOKEN1_DECIMALS);
}

interface CacheEntry {
  at: number;
  klines: Promise<Kline[]>;
}

export interface FairPriceOptions extends FetchKlinesOptions {
  ttlMs?: number;
  freshMin?: number;
  now?: () => number;
}

/** Fair-price source with an in-memory kline cache (TTL ~30 s). Concurrent callers share one request. */
export function createFairPriceSource(opts: FairPriceOptions = {}) {
  const ttl = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  let cache: CacheEntry | undefined;

  return async function getFairPrice(): Promise<FairPrice | null> {
    const t = now();
    if (cache === undefined || t - cache.at >= ttl) {
      const entry: CacheEntry = { at: t, klines: fetchKlines(opts) };
      cache = entry;
      entry.klines.catch(() => {
        if (cache === entry) cache = undefined;
      });
    }
    const ref = med5(await cache.klines, t, opts.freshMin);
    if (ref === null) return null;
    return {
      ...ref,
      sqrtPriceX96: priceE18ToSqrtX96(ref.priceE18),
      source: `HashKey Global ${CEX_SYMBOL} 1m med${MED_K}`,
    };
  };
}
