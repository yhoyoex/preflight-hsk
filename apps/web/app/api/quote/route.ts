import { getAddress, isAddress, parseUnits } from "viem";
import { z } from "zod";
import { ConfigError } from "@/lib/config";
import { createQuote } from "@/lib/quote";
import { clientIp, quoteRateLimiter } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WHSK = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1";
const USDT = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029";

const address = z
  .string()
  .refine((s) => isAddress(s), "invalid address")
  .transform((s) => getAddress(s));

const Body = z
  .strictObject({
    agent: address,
    executor: address,
    zeroForOne: z.boolean().optional(),
    tokenIn: address.optional(),
    /** Human units of tokenIn, e.g. "50" USDT or "600.5" WHSK. */
    amountIn: z.string().regex(/^\d{1,15}(\.\d{1,18})?$/, "decimal string, e.g. \"50\" or \"0.5\""),
  })
  .refine((b) => (b.zeroForOne === undefined) !== (b.tokenIn === undefined), {
    message: "provide exactly one of zeroForOne or tokenIn",
  })
  .refine((b) => b.tokenIn === undefined || b.tokenIn === WHSK || b.tokenIn === USDT, {
    message: "tokenIn must be WHSK or USDT",
    path: ["tokenIn"],
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Drops URLs (the RPC URL may embed an API key) and keeps the first line only. */
function redact(message: string): string {
  return (message.split("\n")[0] ?? "").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
}

export async function POST(request: Request) {
  const rl = await quoteRateLimiter().limit(clientIp(request));
  if (!rl.ok) {
    const res = json({ error: "rate limit exceeded, retry later" }, 429);
    res.headers.set("retry-after", String(rl.retryAfterSec));
    return res;
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: "invalid request", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
  }
  const b = parsed.data;
  const zeroForOne = b.zeroForOne ?? b.tokenIn === WHSK; // WHSK is token0
  const decimals = zeroForOne ? 18 : 6;
  const fraction = b.amountIn.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    return json({ error: "invalid request", issues: [{ path: ["amountIn"], message: `at most ${decimals} decimals` }] }, 400);
  }
  const amountIn = parseUnits(b.amountIn, decimals);
  if (amountIn === 0n) {
    return json({ error: "invalid request", issues: [{ path: ["amountIn"], message: "must be > 0" }] }, 400);
  }

  try {
    return json(await createQuote({ agent: b.agent, executor: b.executor, zeroForOne, amountIn }));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("quote failed: config:", err.message);
      return json({ error: "server misconfigured" }, 500);
    }
    // Server-side log without URLs; the client only gets a generic message (re-audit C).
    console.error("quote failed:", err instanceof Error ? `${err.name}: ${redact(err.message)}` : "unknown error");
    return json({ error: "upstream failure while quoting, retry later" }, 502);
  }
}
