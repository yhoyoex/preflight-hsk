// Wire format of POST /api/quote (bigints as decimal strings) + a typed HTTP client for MCP/agent.
import { formatUnits, getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import type { QuoteRequest, QuoteResponse } from "./service.ts";

/** JSON.stringify with bigint → decimal string. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

const big = z.union([z.string().regex(/^-?\d+$/), z.number().int()]).transform((v) => BigInt(v));
const addr = z
  .string()
  .refine((s) => isAddress(s), "invalid address")
  .transform((s): Address => getAddress(s));
const hex = z.string().refine((s) => isHex(s), "invalid hex").transform((s) => s as Hex);
const bps = z.number().int().nullable();

/** Signed Quote as JSON (bigints as decimal strings); parses into the `Quote` struct. */
export const QuoteWireSchema = z.object({
  agent: addr,
  executor: addr,
  pool: addr,
  zeroForOne: z.boolean(),
  amountIn: big,
  expectedImpactBps: z.number().int().nonnegative(),
  fairSqrtPriceX96: big,
  issuedAt: big,
  expiry: big,
  nonce: big,
});

const PolicySchema = z.object({
  maxImpactBps: z.number().int(),
  maxDevBps: z.number().int(),
  maxAge: z.number().int(),
});

export const QuoteResponseSchema = z.object({
  quote: QuoteWireSchema.nullable(),
  signature: hex.nullable(),
  digest: hex.nullable(),
  attested: z.boolean(),
  domain: z.object({ name: z.string(), version: z.string(), chainId: z.number().int(), verifyingContract: addr }),
  verdict: z.object({
    verdict: z.enum(["DEX", "CEX", "TUNDA", "KECILKAN", "NO_REFERENCE", "OUT_OF_RANGE"]),
    executable: z.boolean(),
    reason: z.string(),
    reasons: z.array(z.string()),
    failedChecks: z.array(z.enum(["STATUS", "IMPACT", "POST_SWAP_DEV", "FAIR_FLOOR"])),
  }),
  metrics: z.object({
    status: z.enum(["OK", "OUT_OF_RANGE", "PRICE_LIMIT"]),
    amountIn: big,
    amountOut: big,
    impactBps: bps,
    devBps: bps,
    adverseDevBps: bps,
    postSwapDevBps: bps,
    feeBps: z.number(),
    totalCostBps: z.number().nullable(),
    notionalUsd: z.number(),
    minAmountOut: big,
    suggestedMaxAmountIn: big.nullable(),
    fairSource: z.enum(["cex", "dex-spot"]),
    fairSqrtPriceX96: big.nullable(),
  }),
  reference: z
    .object({ priceE18: big, lastTradeMs: z.number(), samples: z.number().int(), source: z.string() })
    .nullable(),
  referenceError: z.string().nullable(),
  policy: PolicySchema,
  policySource: z.enum(["guard", "default"]),
});

export function parseQuoteResponse(json: unknown): QuoteResponse {
  const r = QuoteResponseSchema.parse(json);
  // A signature without its quote (or vice versa) is unusable.
  if ((r.quote === null) !== (r.signature === null)) throw new Error("quote response: quote/signature mismatch");
  return r;
}

export class QuoteApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "QuoteApiError";
  }
}

export interface QuoteClient {
  quote(req: QuoteRequest): Promise<QuoteResponse>;
}

/** Client for a Preflight web deployment (`baseUrl` like http://localhost:3000). */
export function httpQuoteClient(baseUrl: string, fetchFn: typeof fetch = fetch, timeoutMs = 20_000): QuoteClient {
  const url = new URL("/api/quote", baseUrl).toString();
  return {
    async quote(req) {
      const body = {
        agent: req.agent,
        executor: req.executor,
        zeroForOne: req.zeroForOne,
        amountIn: formatUnits(req.amountIn, req.zeroForOne ? 18 : 6),
      };
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = json && typeof json === "object" && "error" in json ? String(json.error) : res.statusText;
        throw new QuoteApiError(res.status, `POST /api/quote → ${res.status}: ${msg}`);
      }
      return parseQuoteResponse(json);
    },
  };
}
