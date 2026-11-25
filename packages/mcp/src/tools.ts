// Tool handlers for the Preflight MCP server. Pure functions over injected deps so they can be tested with a mock RPC.
import {
  buildGuardedSwapTxs,
  checkQuoteOnChain,
  QuoteWireSchema,
  reasonHashOf,
  sendGuardedSwap,
  toJson,
  USDT,
  WHSK,
  type QuoteClient,
  type QuoteResponse,
} from "@preflight/core";
import {
  getAddress,
  isAddress,
  isHex,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { z } from "zod";

export interface ToolDeps {
  quotes: QuoteClient;
  client: PublicClient;
  guard: Address;
  /** GuardedRouter; default executor of quotes. */
  router: Address;
  /** Present only when AGENT_PRIVATE_KEY is set AND PREFLIGHT_EXECUTE=1. */
  wallet?: WalletClient<Transport, Chain, Account>;
  /** guarded_swap refuses quotes whose metrics.notionalUsd exceeds this (env PREFLIGHT_MAX_USD). */
  maxUsd: number;
}

export const DEFAULT_MAX_USD = 100;

const address = z
  .string()
  .refine((s) => isAddress(s), "invalid address")
  .transform((s): Address => getAddress(s));
const token = z.enum(["WHSK", "USDT"]);
const amount = z.string().regex(/^\d{1,15}(\.\d{1,18})?$/, 'decimal string in tokenIn units, e.g. "50"');

export const guardQuoteInput = {
  agent: address.describe("Agent wallet that will call guardedSwap (quote.agent)"),
  tokenIn: token.describe("Token sold: WHSK (→ USDT) or USDT (→ WHSK)"),
  amountIn: amount.describe('Amount of tokenIn in human units, e.g. "50"'),
  executor: address.optional().describe("Contract that calls ExecutionGuard.verify; default: GuardedRouter"),
};

export const guardCheckInput = {
  quote: QuoteWireSchema.describe("Signed quote from guard_quote (bigints as decimal strings)"),
  signature: z
    .string()
    .refine((s) => isHex(s) && s.length === 132, "65-byte 0x signature")
    .transform((s) => s as Hex),
};

export const guardedSwapInput = {
  agent: address.describe("Agent wallet (sender of approve + guardedSwap)"),
  tokenIn: token,
  amountIn: amount,
  reason: z.string().min(1).max(500).describe("Why this trade; only keccak256(reason) goes on-chain"),
  amountOutMin: z
    .string()
    .regex(/^\d{1,78}$/)
    .optional()
    .describe("Raw tokenOut units; default: the router's fair floor for this quote"),
};

type Infer<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: toJson(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

function amountRaw(tokenIn: "WHSK" | "USDT", amountIn: string): bigint {
  const raw = parseUnits(amountIn, tokenIn === "WHSK" ? 18 : 6);
  if (raw === 0n) throw new RangeError("amountIn must be > 0");
  return raw;
}

function summary(r: QuoteResponse) {
  return {
    verdict: r.verdict.verdict,
    executable: r.verdict.executable,
    attested: r.attested,
    reason: r.verdict.reason,
    reasons: r.verdict.reasons,
    metrics: r.metrics,
    reference: r.reference,
    referenceError: r.referenceError,
    policy: r.policy,
    policySource: r.policySource,
  };
}

export async function guardQuote(deps: ToolDeps, a: Infer<typeof guardQuoteInput>): Promise<ToolResult> {
  const r = await deps.quotes.quote({
    agent: a.agent,
    executor: a.executor ?? deps.router,
    zeroForOne: a.tokenIn === "WHSK",
    amountIn: amountRaw(a.tokenIn, a.amountIn),
  });
  // quote/signature are null unless the attestor signed (executable DEX verdict with a fresh CEX reference).
  return ok({ ...summary(r), quote: r.quote, signature: r.signature, digest: r.digest });
}

export async function guardCheck(deps: ToolDeps, a: Infer<typeof guardCheckInput>): Promise<ToolResult> {
  const res = await checkQuoteOnChain(deps.client, deps.guard, a.quote, a.signature);
  return ok(
    res.ok
      ? { pass: true, policy: res.policy, note: "eth_call ExecutionGuard.verify from quote.executor succeeded (no tx sent)" }
      : { pass: false, error: res.error, message: res.message },
  );
}

export async function guardedSwap(deps: ToolDeps, a: Infer<typeof guardedSwapInput>): Promise<ToolResult> {
  const r = await deps.quotes.quote({
    agent: a.agent,
    executor: deps.router,
    zeroForOne: a.tokenIn === "WHSK",
    amountIn: amountRaw(a.tokenIn, a.amountIn),
  });
  if (!r.quote || !r.signature) {
    return ok({ ...summary(r), sent: false, note: "Attestor did not sign: verdict is not an executable DEX verdict" });
  }
  if (!(r.metrics.notionalUsd <= deps.maxUsd)) {
    return fail(
      `notional ~$${r.metrics.notionalUsd.toFixed(2)} exceeds PREFLIGHT_MAX_USD $${deps.maxUsd}; nothing built or sent`,
    );
  }
  const floor = r.metrics.minAmountOut;
  const amountOutMin = a.amountOutMin !== undefined ? BigInt(a.amountOutMin) : floor;
  if (amountOutMin <= 0n) return fail("amountOutMin must be > 0");
  if (amountOutMin < floor) {
    return fail(`amountOutMin ${amountOutMin} is below the quote's fair floor ${floor}; use >= ${floor} or omit it`);
  }
  const params = {
    router: deps.router,
    quote: r.quote,
    signature: r.signature,
    amountOutMin,
    reasonHash: reasonHashOf(a.reason),
  };
  const txs = buildGuardedSwapTxs(params);
  const base = { ...summary(r), quote: r.quote, signature: r.signature, reasonHash: params.reasonHash, unsignedTxs: [txs.approve, txs.swap] };

  if (!deps.wallet) {
    return ok({ ...base, sent: false, note: "Unsigned txs only (set AGENT_PRIVATE_KEY and PREFLIGHT_EXECUTE=1 to send)" });
  }
  if (deps.wallet.account.address !== a.agent) {
    return fail(`agent ${a.agent} does not match the configured AGENT_PRIVATE_KEY account ${deps.wallet.account.address}`);
  }
  const sent = await sendGuardedSwap(deps.client, deps.wallet, params);
  return ok({ ...base, sent: sent.status !== "rejected", result: sent });
}

export const TOKENS = { WHSK, USDT } as const;
