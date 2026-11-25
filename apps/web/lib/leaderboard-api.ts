// Versioned JSON envelope for GET /api/leaderboard, built from the static snapshot (apps/web/data/leaderboard.json).
// Every number here is read from the snapshot or derived exactly from it (fee is a flat 30 bps per swap).
import { HSK_CHAIN_ID, USDT, WHSK, WHSK_USDT_POOL } from "@preflight/core";
import { isAddress } from "viem";
import { z } from "zod";
import { GITHUB_URL } from "./deployments";
import { BLOCKSCOUT, leaderboard, type Leaderboard } from "./leaderboard";

export const API_VERSION = "1";
const FEE_BPS = 30;
export const SORT_KEYS = ["volume", "swaps", "costBps", "costUsd"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

const uint = (name: string) =>
  z
    .string()
    .regex(/^\d{1,9}$/, `${name} must be a non-negative integer`)
    .transform(Number);

export const LeaderboardQuery = z.object({
  sort: z.enum(SORT_KEYS, { error: `sort must be one of ${SORT_KEYS.join(", ")}` }).default("volume"),
  order: z.enum(["asc", "desc"], { error: "order must be asc or desc" }).default("desc"),
  limit: uint("limit")
    .pipe(z.number().min(1, "limit must be between 1 and 100").max(100, "limit must be between 1 and 100"))
    .default(50),
  offset: uint("offset").default(0),
  wallet: z
    .string()
    .refine((s) => isAddress(s, { strict: false }), "wallet must be a 0x-prefixed 20-byte address")
    .transform((s) => s.toLowerCase())
    .optional(),
  pretty: z.enum(["1", "true", "0", "false"], { error: "pretty must be 1, true, 0 or false" }).optional(),
});
export type LeaderboardQuery = z.output<typeof LeaderboardQuery>;

export type ParseResult = { ok: true; query: LeaderboardQuery } | { ok: false; message: string };

/** Unknown params are ignored; a repeated param uses its first value. */
export function parseQuery(params: URLSearchParams): ParseResult {
  const raw: Record<string, string> = {};
  for (const key of Object.keys(LeaderboardQuery.shape)) {
    const v = params.get(key);
    if (v !== null) raw[key] = v;
  }
  const r = LeaderboardQuery.safeParse(raw);
  if (r.success) return { ok: true, query: r.data };
  const issue = r.error.issues[0];
  return { ok: false, message: issue ? `${issue.path.join(".") || "query"}: ${issue.message}` : "invalid query" };
}

type Wallet = Leaderboard["wallets"][number];

const sortValue: Record<SortKey, (w: Wallet) => number | null> = {
  volume: (w) => w.volumeUsd,
  swaps: (w) => w.swaps,
  costBps: (w) => w.meanCostBps,
  costUsd: (w) => w.totalCostUsd,
};

/** Orders by `key` in `dir` (1 asc, -1 desc); null values always go last, ties break by address. */
function compareWallets(key: (w: Wallet) => number | null, dir: 1 | -1) {
  return (a: Wallet, b: Wallet): number => {
    const x = key(a);
    const y = key(b);
    const byValue = x === null || y === null ? (x === null ? 1 : 0) - (y === null ? 1 : 0) : dir * (x - y);
    return byValue || a.wallet.toLowerCase().localeCompare(b.wallet.toLowerCase());
  };
}

const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString();
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const bps = (usd: number, volumeUsd: number) => (volumeUsd > 0 ? round((usd / volumeUsd) * 1e4, 4) : null);

/** Fee / curve impact / adverse CEX gap in USD; exact because the LP fee is a flat 30 bps of the USDT leg. */
function breakdownUsd(s: { volumeUsd: number; feeImpactUsd: number; totalCostUsd: number }) {
  const feeUsd = (s.volumeUsd * FEE_BPS) / 1e4;
  return { feeUsd, impactUsd: s.feeImpactUsd - feeUsd, cexGapUsd: s.totalCostUsd - s.feeImpactUsd };
}

function walletRow(w: Wallet, rank: number) {
  const known = w.wallet !== "unknown";
  const b = breakdownUsd(w);
  return {
    rank,
    address: known ? w.wallet : null,
    explorerUrl: known ? `${BLOCKSCOUT}/address/${w.wallet}` : null,
    swaps: w.swaps,
    volumeUsd: round(w.volumeUsd),
    meanCostBps: w.meanCostBps === null ? null : round(w.meanCostBps, 4),
    medianCostBps: w.medianCostBps,
    volumeWeightedCostBps: w.volumeWeightedCostBps === null ? null : round(w.volumeWeightedCostBps, 4),
    totalCostUsd: round(w.totalCostUsd, 4),
    costBreakdownUsd: { fee: round(b.feeUsd, 4), impact: round(b.impactUsd, 4), cexGap: round(b.cexGapUsd, 4) },
    firstSeen: iso(w.firstSwapAt),
    lastSeen: iso(w.lastSwapAt),
  };
}

/** Snapshot histogram (edges 30,31,32,35,50,100,200) regrouped into the API buckets. */
function distribution(lb: Leaderboard) {
  const groups = [
    { label: "<35", fromBps: null, toBps: 35 },
    { label: "35-50", fromBps: 35, toBps: 50 },
    { label: "50-100", fromBps: 50, toBps: 100 },
    { label: ">=100", fromBps: 100, toBps: null },
  ] as const;
  return groups.map((g) => {
    const hit = lb.histogram.filter(
      (h) => (g.fromBps === null || h.fromBps >= g.fromBps) && (g.toBps === null || h.fromBps < g.toBps),
    );
    const swaps = hit.reduce((a, h) => a + h.swaps, 0);
    const volumeUsd = hit.reduce((a, h) => a + h.volumeUsd, 0);
    return {
      ...g,
      swaps,
      shareOfSwaps: round(swaps / lb.summary.swaps, 4),
      volumeUsd: round(volumeUsd),
    };
  });
}

function meta(lb: Leaderboard) {
  return {
    chainId: HSK_CHAIN_ID,
    network: "HashKey Chain mainnet",
    pool: {
      address: WHSK_USDT_POOL,
      protocol: "Uniswap V3",
      feeBps: FEE_BPS,
      explorerUrl: `${BLOCKSCOUT}/address/${WHSK_USDT_POOL}`,
      token0: { address: WHSK, symbol: "WHSK", decimals: 18 },
      token1: { address: USDT, symbol: "USDT", decimals: 6 },
    },
    source: {
      kind: "snapshot",
      generatedAt: lb.generatedAt,
      swapLogs: lb.sources.logs,
      cexReference: lb.sources.klines,
      senders: lb.sources.senders,
    },
    range: {
      fromBlock: lb.range.fromBlock,
      toBlock: lb.range.toBlock,
      firstSwapAt: lb.range.fromIso,
      lastSwapAt: lb.range.toIso,
    },
    units: { volume: "USD (USDT leg of each swap)", cost: "basis points of volume (1 bps = 0.01%) and USD", time: "ISO 8601 UTC" },
    definitions: {
      costBps: "Execution cost per swap: feeBps + impactBps + adverse CEX gap. Wallet sort key costBps = meanCostBps.",
      feeBps: "LP fee of the pool, flat 30 bps.",
      impactBps: "Output shortfall vs the pre-swap spot, excluding the LP fee (Uniswap V3 replay of the pool state).",
      cexGapBps: "Pre-swap pool price vs the CEX med5 reference, counted only when it goes against the trade direction.",
      med5: "Median close of the last 5 traded 1-minute candles of HashKey Global HSKUSDT; stale if the last trade is 5+ minutes old.",
      wallet: "Transaction sender (`from`); may be a bot, router or aggregator.",
    },
    methodology: [
      "Each Swap log of the pool is replayed from the previous swap's state to measure impact without the LP fee.",
      "The CEX gap uses the med5 reference of that minute; swaps with a stale reference count no gap.",
      "USD cost = volumeUsd × costBps / 10,000.",
    ],
    limitations: [
      "In-sample 30-day window; a static snapshot, not live data.",
      "The CEX reference is an off-chain price (the same one the Preflight attestor signs); it is not an on-chain oracle.",
      `${lb.summary.staleReference} swaps had a stale CEX reference and are counted without a CEX gap.`,
      "Not trading advice.",
    ],
  };
}

function summary(lb: Leaderboard) {
  const s = lb.summary;
  const b = breakdownUsd(s);
  return {
    swaps: s.swaps,
    uniqueWallets: s.uniqueWallets,
    volumeUsd: round(s.volumeUsd),
    costBps: {
      mean: s.meanCostBps === null ? null : round(s.meanCostBps, 4),
      median: lb.costPercentilesBps.p50,
      p75: lb.costPercentilesBps.p75,
      p90: lb.costPercentilesBps.p90,
      volumeWeighted: s.volumeWeightedCostBps === null ? null : round(s.volumeWeightedCostBps, 4),
    },
    /** Volume-weighted; fee + impact + cexGap = volumeWeighted cost. */
    costBreakdownBps: { fee: FEE_BPS, impact: bps(b.impactUsd, s.volumeUsd), cexGap: bps(b.cexGapUsd, s.volumeUsd) },
    costBreakdownUsd: { fee: round(b.feeUsd, 4), impact: round(b.impactUsd, 4), cexGap: round(b.cexGapUsd, 4) },
    totalCostUsd: round(s.totalCostUsd, 4),
    distribution: distribution(lb),
    staleCexReference: s.staleReference,
  };
}

export const DOCS_URL = `${GITHUB_URL}#leaderboard-api`;

/** Builds the response body for an already validated query; `url` is the request URL (for links). */
export function buildLeaderboardResponse(query: LeaderboardQuery, url: URL, lb: Leaderboard = leaderboard) {
  const ranked = [...lb.wallets]
    .sort(compareWallets(sortValue[query.sort], query.order === "asc" ? 1 : -1))
    .map((w, i) => walletRow(w, i + 1));
  const filtered = query.wallet === undefined ? ranked : ranked.filter((r) => r.address?.toLowerCase() === query.wallet);
  const data = filtered.slice(query.offset, query.offset + query.limit);

  const pageUrl = (offset: number) => {
    const u = new URL(url);
    u.searchParams.set("offset", String(offset));
    u.searchParams.set("limit", String(query.limit));
    return u.toString();
  };
  const hasNext = query.offset + query.limit < filtered.length;
  return {
    apiVersion: API_VERSION,
    meta: meta(lb),
    summary: summary(lb),
    query: { sort: query.sort, order: query.order, limit: query.limit, offset: query.offset, wallet: query.wallet ?? null },
    pagination: {
      total: filtered.length,
      limit: query.limit,
      offset: query.offset,
      next: hasNext ? pageUrl(query.offset + query.limit) : null,
    },
    data,
    links: {
      self: url.toString(),
      next: hasNext ? pageUrl(query.offset + query.limit) : null,
      docs: DOCS_URL,
      page: new URL("/leaderboard", url).toString(),
    },
  };
}
