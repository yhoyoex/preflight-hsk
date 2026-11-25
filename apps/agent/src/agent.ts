// One price-guard tick: med5 reference → deterministic trigger/sizing → LLM size+reason → attestor quote →
// GuardedRouter.guardedSwap (live) or unsigned txs (dry-run). The Guard is the last word either way.
import { appendFile } from "node:fs/promises";
import {
  buildGuardedSwapTxs,
  ERC20_ABI,
  med5,
  reasonHashOf,
  sendGuardedSwap,
  USDT,
  WHSK,
  type Kline,
  type PoolState,
  type QuoteClient,
  type SendOptions,
  type SendResult,
} from "@preflight/core";
import { formatUnits, parseUnits, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";
import type { Proposer } from "./llm.ts";
import { decide, spFromX96, THRESHOLD_BPS } from "./strategy.ts";

export interface AgentDeps {
  agent: Address;
  router: Address;
  client: PublicClient;
  quotes: QuoteClient;
  proposer: Proposer;
  klines: () => Promise<Kline[]>;
  poolState: () => Promise<PoolState>;
  capitalUsd: number;
  thresholdBps?: number;
  /** Required for live mode. */
  wallet?: WalletClient<Transport, Chain, Account>;
  live: boolean;
  logPath: string;
  now?: () => number;
  /** e2e/demo only: send even if the pre-flight simulation reverts (mines the revert). */
  sendOptions?: SendOptions;
}

export type TickRecord = {
  ts: string;
  mode: "live" | "dry-run";
  action: "hold" | "skip" | "dry-run" | "sent" | "rejected" | "reverted";
  why?: string;
  refPrice?: number;
  dexPrice?: number;
  gapBps?: number;
  tokenIn?: "WHSK" | "USDT";
  amountIn?: string;
  proposal?: { source: "llm" | "fallback"; note?: string };
  reason?: string;
  reasonHash?: `0x${string}`;
  verdict?: string;
  attested?: boolean;
  totalCostBps?: number | null;
  txHash?: `0x${string}`;
  error?: string;
  event?: { amountIn: string; amountOut: string; impactBps: string; devBps: string };
};

/** Raw token balances (exact); converted to floats only for the arb_sim sizing math. */
async function balances(client: PublicClient, agent: Address): Promise<{ whsk: bigint; usdt: bigint }> {
  const [whsk, usdt] = await Promise.all([
    client.readContract({ address: WHSK, abi: ERC20_ABI, functionName: "balanceOf", args: [agent] }),
    client.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [agent] }),
  ]);
  return { whsk, usdt };
}

/** The reason committed on-chain (reasonHash) and logged: proposer text + the size actually quoted. */
export function finalReason(reason: string, amountIn: bigint, decimals: number, tokenIn: "WHSK" | "USDT"): string {
  return `${reason.trim()} [final size ${formatUnits(amountIn, decimals)} ${tokenIn}]`;
}

/** Floors a float token amount to raw units (never rounds the size up). */
export function toRaw(amount: number, decimals: number): bigint {
  const fixed = amount.toFixed(decimals);
  const raw = parseUnits(fixed, decimals);
  return Number(fixed) > amount ? raw - 1n : raw;
}

export async function tick(deps: AgentDeps): Promise<TickRecord> {
  const now = deps.now ?? Date.now;
  const base = { ts: new Date(now()).toISOString(), mode: deps.live ? "live" : "dry-run" } as const;
  const record = await runTick(deps, base, now()).catch(
    (err: unknown): TickRecord => ({ ...base, action: "skip", why: "error", error: err instanceof Error ? err.message.split("\n")[0] : String(err) }),
  );
  await appendFile(deps.logPath, `${JSON.stringify(record)}\n`);
  return record;
}

async function runTick(deps: AgentDeps, base: Pick<TickRecord, "ts" | "mode">, nowMs: number): Promise<TickRecord> {
  if (deps.live && !deps.wallet) throw new Error("live mode needs a wallet (AGENT_PRIVATE_KEY)");
  const [klines, state, bal, gasPrice] = await Promise.all([
    deps.klines(),
    deps.poolState(),
    balances(deps.client, deps.agent),
    deps.client.getGasPrice(),
  ]);
  const ref = med5(klines, nowMs);
  if (!ref) return { ...base, action: "hold", why: "no-reference" };
  const refPrice = Number(formatUnits(ref.priceE18, 18));
  const d = decide({
    sp: spFromX96(state.sqrtPriceX96),
    L: Number(state.liquidity),
    ref: refPrice,
    whsk: Number(formatUnits(bal.whsk, 18)),
    usdt: Number(formatUnits(bal.usdt, 6)),
    capitalUsd: deps.capitalUsd,
    thresholdBps: deps.thresholdBps ?? THRESHOLD_BPS,
    gasPriceWei: Number(gasPrice),
  });
  const ctx = { ...base, refPrice, dexPrice: d.dexPrice, gapBps: Number(d.gapBps.toFixed(2)) };
  if ("hold" in d) return { ...ctx, action: "hold", why: d.why };

  const tokenIn = d.sell ? "WHSK" : "USDT";
  const decimals = d.sell ? 18 : 6;
  const proposal = await deps.proposer.propose({ decision: d, refPrice, tokenIn });
  // Any proposer (LLM or not) is clamped to the deterministic bounds here.
  const size = Math.min(Math.max(proposal.amountIn, d.minAmountIn), d.maxAmountIn);
  const held = d.sell ? bal.whsk : bal.usdt;
  const raw = toRaw(size, decimals);
  const amountIn = raw > held ? held : raw; // float sizing may round past the exact balance
  if (amountIn <= 0n) return { ...ctx, action: "hold", why: "dust" };
  const reason = finalReason(proposal.reason, amountIn, decimals, tokenIn);
  const reasonHash = reasonHashOf(reason);
  const rec: TickRecord = {
    ...ctx,
    action: "skip",
    tokenIn,
    amountIn: formatUnits(amountIn, decimals),
    proposal: {
      source: proposal.source,
      ...(proposal.note || size !== proposal.amountIn
        ? { note: proposal.note ?? `size ${proposal.amountIn} clamped to ${size}` }
        : {}),
    },
    reason,
    reasonHash,
  };

  const q = await deps.quotes.quote({ agent: deps.agent, executor: deps.router, zeroForOne: d.sell, amountIn });
  Object.assign(rec, { verdict: q.verdict.verdict, attested: q.attested, totalCostBps: q.metrics.totalCostBps });
  // Execute only on an executable DEX verdict the attestor actually signed.
  if (q.verdict.verdict !== "DEX" || !q.verdict.executable || !q.quote || !q.signature) {
    return { ...rec, action: "skip", why: q.verdict.reason };
  }
  const params = { router: deps.router, quote: q.quote, signature: q.signature, amountOutMin: q.metrics.minAmountOut, reasonHash };
  if (!deps.live || !deps.wallet) {
    buildGuardedSwapTxs(params); // validates encodability; nothing is sent in dry-run
    return { ...rec, action: "dry-run" };
  }
  return { ...rec, ...describe(await sendGuardedSwap(deps.client, deps.wallet, params, deps.sendOptions)) };
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** A tick that sent and reverted, was rejected by the pre-flight simulation, or errored (RPC, timeout, pending tx). */
export const isFailure = (r: TickRecord): boolean =>
  r.action === "reverted" || r.action === "rejected" || (r.action === "skip" && r.why === "error");

export interface LoopOptions {
  once: boolean;
  intervalMs: number;
  /** Live mode stops after this many consecutive failures (env AGENT_MAX_CONSECUTIVE_FAILURES). */
  maxConsecutiveFailures: number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (r: TickRecord) => void;
  log?: (line: string) => void;
}

export type LoopExit = { reason: "once" } | { reason: "circuit-breaker"; failures: number; last: TickRecord };

/** Per-minute loop with a circuit breaker for live mode; any non-failure tick resets the streak. */
export async function runLoop(deps: AgentDeps, o: LoopOptions): Promise<LoopExit> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  let failures = 0;
  for (;;) {
    const r = await tick(deps);
    o.onRecord?.(r);
    failures = isFailure(r) ? failures + 1 : 0;
    if (deps.live && failures > 0) {
      o.log?.(`live failure ${failures}/${o.maxConsecutiveFailures}: ${r.action} ${r.error ?? r.why ?? ""}`.trim());
    }
    if (deps.live && failures >= o.maxConsecutiveFailures) {
      o.log?.(`circuit breaker: ${failures} consecutive live failures — stopping the agent (last: ${r.error ?? r.action})`);
      return { reason: "circuit-breaker", failures, last: r };
    }
    if (o.once) return { reason: "once" };
    await sleep(o.intervalMs);
  }
}

function describe(r: SendResult): Partial<TickRecord> {
  if (r.status === "success") {
    return {
      action: "sent",
      txHash: r.hash,
      event: {
        amountIn: r.event.amountIn.toString(),
        amountOut: r.event.amountOut.toString(),
        impactBps: r.event.impactBps.toString(),
        devBps: r.event.devBps.toString(),
      },
    };
  }
  if (r.status === "reverted") return { action: "reverted", txHash: r.hash, error: r.message };
  return { action: "rejected", error: r.message };
}
