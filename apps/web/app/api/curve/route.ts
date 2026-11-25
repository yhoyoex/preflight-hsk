import { z } from "zod";
import { costCurve } from "@/lib/curve";
import { clientIp, quoteRateLimiter } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.strictObject({ zeroForOne: z.boolean() });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Unsigned cost-vs-size curve. Same limiter and limit as /api/quote (30/min per IP by default), but its own
 * key, so loading the curve does not spend the caller's quote budget.
 */
export async function POST(request: Request) {
  const rl = await quoteRateLimiter().limit(`curve:${clientIp(request)}`);
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
  if (!parsed.success) return json({ error: "invalid request" }, 400);
  try {
    return json(await costCurve(parsed.data.zeroForOne));
  } catch (err) {
    console.error("curve failed:", err instanceof Error ? err.name : "unknown error");
    return json({ error: "upstream failure while simulating, retry later" }, 502);
  }
}
