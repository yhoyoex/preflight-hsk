// Per-IP rate limit for /api/quote (and, as a separate instance, /api/leaderboard). In-memory token bucket by default; Upstash Redis (REST) when
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set (shared across Vercel instances).

export interface LimitResult {
  ok: boolean;
  /** Seconds until a request is allowed again (only meaningful when !ok). */
  retryAfterSec: number;
}

export interface RateLimiter {
  limit(key: string): Promise<LimitResult>;
}

export const MAX_KEYS = 10_000;
export const DEFAULT_GLOBAL_PER_MINUTE = 300;

export interface MemoryRateLimiter extends RateLimiter {
  /** Gives back one token taken by `limit(key)` (used when a later check denies the request). */
  refund(key: string): void;
}

/**
 * Token bucket: `capacity` tokens, refilled continuously at capacity per `windowMs`, at most `maxKeys` buckets.
 * A full map only evicts its least-recently-used bucket when that bucket has been idle for a whole window (it would
 * be full again, so eviction loses nothing). Otherwise new keys are denied: flooding with fresh keys cannot push out
 * a key that is currently limited, which would hand it a fresh bucket.
 */
export function memoryRateLimiter(
  capacity: number,
  windowMs = 60_000,
  now: () => number = Date.now,
  maxKeys = MAX_KEYS,
): MemoryRateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const ratePerMs = capacity / windowMs;
  return {
    async limit(key) {
      const t = now();
      const prev = buckets.get(key);
      if (!prev && buckets.size >= maxKeys) {
        const [oldest, b] = buckets.entries().next().value ?? [];
        if (oldest === undefined || b === undefined || t - b.at < windowMs) {
          return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (b ? t - b.at : 0)) / 1000)) };
        }
        buckets.delete(oldest);
      }
      const tokens = prev ? Math.min(capacity, prev.tokens + (t - prev.at) * ratePerMs) : capacity;
      buckets.delete(key); // re-insert keeps Map order = LRU
      if (tokens < 1) {
        buckets.set(key, { tokens, at: t });
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / ratePerMs / 1000)) };
      }
      buckets.set(key, { tokens: tokens - 1, at: t });
      return { ok: true, retryAfterSec: 0 };
    },
    refund(key) {
      const b = buckets.get(key);
      if (b) b.tokens = Math.min(capacity, b.tokens + 1);
    },
  };
}

/**
 * In-memory limiter with a global ceiling: the shared bucket is checked first, so a key flood beyond
 * `globalPerWindow` is denied before it touches the per-key map. A request denied per key gets its global token
 * back, so one client hammering its own limit cannot drain the global budget for everyone else.
 */
export function cappedMemoryRateLimiter(
  perKey: number,
  globalPerWindow: number,
  windowMs = 60_000,
  now: () => number = Date.now,
  maxKeys = MAX_KEYS,
): RateLimiter {
  const global = memoryRateLimiter(globalPerWindow, windowMs, now, 1);
  const keyed = memoryRateLimiter(perKey, windowMs, now, maxKeys);
  return {
    async limit(key) {
      const g = await global.limit("global");
      if (!g.ok) return g;
      const k = await keyed.limit(key);
      if (!k.ok) global.refund("global");
      return k;
    },
  };
}

/** Fixed window counter via the Upstash REST pipeline (SET NX PX + INCR + PTTL); falls back on error. */
export function upstashRateLimiter(opts: {
  url: string;
  token: string;
  limit: number;
  windowMs?: number;
  fallback: RateLimiter;
  fetchFn?: typeof fetch;
}): RateLimiter {
  const windowMs = opts.windowMs ?? 60_000;
  const fetchFn = opts.fetchFn ?? fetch;
  const endpoint = `${opts.url.replace(/\/+$/, "")}/pipeline`;
  return {
    async limit(key) {
      const k = `preflight:rl:${key}`;
      try {
        const res = await fetchFn(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
          body: JSON.stringify([
            ["SET", k, "0", "PX", String(windowMs), "NX"],
            ["INCR", k],
            ["PTTL", k],
          ]),
          signal: AbortSignal.timeout(2_000),
        });
        if (!res.ok) throw new Error(`upstash HTTP ${res.status}`);
        const out = (await res.json()) as Array<{ result?: unknown; error?: string }>;
        const count = Number(out[1]?.result);
        const pttl = Number(out[2]?.result);
        if (!Number.isFinite(count)) throw new Error("upstash: unexpected response");
        if (count <= opts.limit) return { ok: true, retryAfterSec: 0 };
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((pttl > 0 ? pttl : windowMs) / 1000)) };
      } catch (err) {
        console.error("rate limit store unavailable, using in-memory limiter:", err instanceof Error ? err.name : "error");
        return opts.fallback.limit(key);
      }
    },
  };
}

let limiter: RateLimiter | undefined;

export function quoteRateLimiter(): RateLimiter {
  if (limiter) return limiter;
  const perMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 30);
  const capacity = Number.isInteger(perMinute) && perMinute > 0 ? perMinute : 30;
  const globalMinute = Number(process.env.RATE_LIMIT_GLOBAL_PER_MINUTE ?? DEFAULT_GLOBAL_PER_MINUTE);
  const globalCap = Number.isInteger(globalMinute) && globalMinute > 0 ? globalMinute : DEFAULT_GLOBAL_PER_MINUTE;
  // Also the Upstash fallback, so an outage of the shared store keeps the per-instance global ceiling.
  const memory = cappedMemoryRateLimiter(capacity, globalCap);
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  limiter = url && token ? upstashRateLimiter({ url, token, limit: capacity, fallback: memory }) : memory;
  return limiter;
}

let leaderboardLimiter: RateLimiter | undefined;

/**
 * Separate limiter for GET /api/leaderboard (same per-IP limit, own global bucket, own key map), so leaderboard
 * scraping can never use up the global budget or key slots of /api/quote. Upstash keys are already disjoint
 * (`leaderboard:<ip>` vs `<ip>`).
 */
export function leaderboardRateLimiter(): RateLimiter {
  if (leaderboardLimiter) return leaderboardLimiter;
  const perMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 30);
  const capacity = Number.isInteger(perMinute) && perMinute > 0 ? perMinute : 30;
  const memory = cappedMemoryRateLimiter(capacity, DEFAULT_GLOBAL_PER_MINUTE);
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  leaderboardLimiter = url && token ? upstashRateLimiter({ url, token, limit: capacity, fallback: memory }) : memory;
  return leaderboardLimiter;
}

/**
 * Client IP for rate limiting. Deploy assumption: Vercel. There `x-vercel-forwarded-for` and `x-real-ip` are set by
 * the platform edge and overwrite anything the client sent, so they are trusted first. Behind another proxy, the
 * LAST X-Forwarded-For hop is the address seen by the nearest (trusted) proxy; earlier hops are client-controlled
 * and are never used (a spoofed first hop must not change the key).
 */
export function clientIp(request: Request): string {
  const lastHop = (v: string | null) => v?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return (
    lastHop(request.headers.get("x-vercel-forwarded-for")) ||
    request.headers.get("x-real-ip")?.trim() ||
    lastHop(request.headers.get("x-forwarded-for")) ||
    "unknown"
  );
}
