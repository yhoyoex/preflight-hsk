import type { CostStats, GuardedSwapFeedItem, Summary, WalletStats } from "@preflight/core";
import snapshot from "../data/leaderboard.json";

export interface Leaderboard {
  generatedAt: string;
  range: { fromBlock: number; toBlock: number; fromIso: string; toIso: string };
  sources: { logs: string; klines: string; senders: string };
  /** Research reference figures (research/REPORT.md) the snapshot is checked against. */
  reconciliation: { expectedSwaps: number; expectedVolumeUsd: number; swaps: number; volumeUsd: number; note: string };
  summary: Summary;
  histogram: { fromBps: number; toBps: number | null; swaps: number; volumeUsd: number }[];
  wallets: WalletStats[];
  feed: { router: string | null; items: GuardedSwapFeedItem[] };
}

export type { CostStats };

export const leaderboard = snapshot as unknown as Leaderboard;

export const BLOCKSCOUT = "https://hsk.blockscout.com";

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
