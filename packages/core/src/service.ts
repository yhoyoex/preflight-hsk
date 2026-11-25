// Attestor quote service shared by apps/web (/api/quote), the MCP server and the agent (local mode).
import { parseAbi, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import type { FairPrice } from "./cex.ts";
import { fetchPoolState, WHSK_USDT_POOL, type PoolState } from "./pool.ts";
import { buildQuote, GUARD_DOMAIN_NAME, GUARD_DOMAIN_VERSION, hashQuote, signQuote, type Quote } from "./sign.ts";
import { attestableFair, DEFAULT_POLICY, evaluate, type Policy, type RouterCheck, type VerdictKind, type VerdictMetrics } from "./verdict.ts";

const POLICY_ABI = parseAbi([
  "function policyOf(address agent) view returns ((uint32 maxImpactBps, uint32 maxDevBps, uint64 maxAge))",
]);

export interface QuoteRequest {
  agent: Address;
  executor: Address;
  zeroForOne: boolean;
  amountIn: bigint;
}

export interface QuoteResponse {
  /** null unless the verdict is an executable DEX verdict with a fresh CEX reference (re-audit A). */
  quote: Quote | null;
  signature: Hex | null;
  digest: Hex | null;
  attested: boolean;
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  verdict: {
    verdict: VerdictKind;
    executable: boolean;
    reason: string;
    reasons: string[];
    failedChecks: RouterCheck[];
  };
  metrics: VerdictMetrics;
  reference: { priceE18: bigint; lastTradeMs: number; samples: number; source: string } | null;
  referenceError: string | null;
  policy: Policy;
  policySource: "guard" | "default";
}

export interface QuoteServiceDeps {
  client: PublicClient;
  attestor: LocalAccount;
  guard: Address;
  chainId: number;
  fairPrice: () => Promise<FairPrice | null>;
  ttlSeconds: number;
  pool?: Address;
  poolStateTtlMs?: number;
  /** Defaults to fetchPoolState with 3 tries. */
  loadPoolState?: () => Promise<PoolState>;
  now?: () => number;
}

export function createQuoteService(deps: QuoteServiceDeps) {
  const pool = deps.pool ?? WHSK_USDT_POOL;
  const ttl = deps.poolStateTtlMs ?? 5_000;
  const now = deps.now ?? Date.now;
  const load = deps.loadPoolState ?? (() => fetchPoolState(deps.client, { pool, tries: 3, initialDelayMs: 300 }));
  let poolCache: { at: number; state: Promise<PoolState> } | undefined;

  function poolState(): Promise<PoolState> {
    const t = now();
    if (!poolCache || t - poolCache.at >= ttl) {
      const entry = { at: t, state: load() };
      poolCache = entry;
      entry.state.catch(() => {
        if (poolCache === entry) poolCache = undefined;
      });
    }
    return poolCache.state;
  }

  async function policyFor(agent: Address): Promise<{ policy: Policy; source: "guard" | "default" }> {
    const code = await deps.client.getCode({ address: deps.guard });
    if (!code || code === "0x") return { policy: { ...DEFAULT_POLICY }, source: "default" };
    const p = await deps.client.readContract({
      address: deps.guard,
      abi: POLICY_ABI,
      functionName: "policyOf",
      args: [agent],
    });
    return { policy: { maxImpactBps: p.maxImpactBps, maxDevBps: p.maxDevBps, maxAge: Number(p.maxAge) }, source: "guard" };
  }

  async function fairOrNull(): Promise<{ fair: FairPrice | null; error: string | null }> {
    try {
      const fair = await deps.fairPrice();
      return { fair, error: fair ? null : "CEX reference stale (no trade within 5 minutes)" };
    } catch {
      // Raw upstream errors are not echoed to callers.
      return { fair: null, error: "CEX reference unavailable" };
    }
  }

  async function quote(req: QuoteRequest): Promise<QuoteResponse> {
    const [state, { fair, error }, { policy, source }, block] = await Promise.all([
      poolState(),
      fairOrNull(),
      policyFor(req.agent),
      deps.client.getBlock(),
    ]);
    const v = evaluate({ state, zeroForOne: req.zeroForOne, amountIn: req.amountIn, fair, policy });
    const domain = { chainId: deps.chainId, verifyingContract: deps.guard };

    let q: Quote | null = null;
    let signature: Hex | null = null;
    let digest: Hex | null = null;
    const fairSqrt = attestableFair(v);
    if (fairSqrt !== null && v.metrics.impactBps !== null) {
      q = buildQuote({
        agent: req.agent,
        executor: req.executor,
        pool,
        zeroForOne: req.zeroForOne,
        amountIn: req.amountIn,
        expectedImpactBps: v.metrics.impactBps,
        fairSqrtPriceX96: fairSqrt,
        // Chain time, so the quote is neither "from the future" nor stale on the target chain (incl. forks).
        issuedAt: block.timestamp,
        ttlSeconds: Math.min(deps.ttlSeconds, policy.maxAge),
      });
      signature = await signQuote(deps.attestor, domain, q);
      digest = hashQuote(domain, q);
    }

    return {
      quote: q,
      signature,
      digest,
      attested: signature !== null,
      domain: { name: GUARD_DOMAIN_NAME, version: GUARD_DOMAIN_VERSION, ...domain },
      verdict: {
        verdict: v.verdict,
        executable: v.executable,
        reason: v.reason,
        reasons: v.reasons,
        failedChecks: v.failedChecks,
      },
      metrics: v.metrics,
      reference: fair
        ? { priceE18: fair.priceE18, lastTradeMs: fair.lastTradeMs, samples: fair.samples, source: fair.source }
        : null,
      referenceError: error,
      policy,
      policySource: source,
    };
  }

  return { quote };
}

export type QuoteService = ReturnType<typeof createQuoteService>;
