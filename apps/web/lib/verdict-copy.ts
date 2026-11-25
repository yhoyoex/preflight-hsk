import type { RouterCheck, VerdictKind } from "@preflight/core";

export type Tone = "go" | "caution" | "info" | "stop";

export const VERDICT_COPY: Record<VerdictKind, { label: string; summary: string; tone: Tone }> = {
  DEX: { label: "Execute on DEX", summary: "Cost is within the agent policy. The quote can be signed and executed.", tone: "go" },
  CEX: { label: "Route to CEX / OTC", summary: "The pool is too thin for this size. A centralized venue may be cheaper.", tone: "caution" },
  TUNDA: { label: "Wait", summary: "The DEX price is off the CEX reference. Wait for the gap to close.", tone: "caution" },
  KECILKAN: { label: "Reduce size", summary: "This size breaks an on-chain limit. A smaller order passes.", tone: "caution" },
  NO_REFERENCE: { label: "No fresh reference", summary: "No CEX trade in the last 5 minutes. Cost is estimated against the DEX spot.", tone: "info" },
  OUT_OF_RANGE: { label: "Out of range", summary: "The order runs past the scanned liquidity. Cost cannot be bounded.", tone: "stop" },
};

export const TONE_CLASSES: Record<Tone, { card: string; badge: string; dot: string; chip: string; fill: string }> = {
  go: { card: "bg-emerald-400/10", badge: "text-emerald-300", dot: "bg-emerald-400", chip: "bg-emerald-400/15 text-emerald-200", fill: "fill-emerald-400" },
  caution: { card: "bg-amber-400/10", badge: "text-amber-300", dot: "bg-amber-400", chip: "bg-amber-400/15 text-amber-200", fill: "fill-amber-400" },
  info: { card: "bg-sky-400/10", badge: "text-sky-300", dot: "bg-sky-400", chip: "bg-sky-400/15 text-sky-200", fill: "fill-sky-400" },
  stop: { card: "bg-rose-400/10", badge: "text-rose-300", dot: "bg-rose-400", chip: "bg-rose-400/15 text-rose-200", fill: "fill-rose-400" },
};

export const CHECK_COPY: Record<RouterCheck, string> = {
  STATUS: "simulation did not fill",
  IMPACT: "price impact above policy",
  POST_SWAP_DEV: "post-swap price too far from reference",
  FAIR_FLOOR: "output below fair floor",
};
