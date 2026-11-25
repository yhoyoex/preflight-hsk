import { buildLeaderboardResponse, parseQuery } from "@/lib/leaderboard-api";
import { clientIp, leaderboardRateLimiter } from "@/lib/ratelimit";

// Reads the static snapshot (apps/web/data/leaderboard.json, written by `pnpm snapshot`); dynamic only because of
// the query params and the rate limit. CDN caching keys on the full URL, so each query variant is cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;
const CACHE_OK = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

function json(body: unknown, status: number, pretty = false, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body, null, pretty ? 2 : undefined), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? CACHE_OK : "no-store",
      ...CORS,
      ...extra,
    },
  });
}

const error = (status: number, code: string, message: string, extra?: Record<string, string>) =>
  json({ error: { code, message } }, status, false, extra);

export async function GET(request: Request) {
  const rl = await leaderboardRateLimiter().limit(`leaderboard:${clientIp(request)}`);
  if (!rl.ok) {
    return error(429, "rate_limited", `rate limit exceeded, retry in ${rl.retryAfterSec} s`, {
      "retry-after": String(rl.retryAfterSec),
    });
  }
  const url = new URL(request.url);
  const parsed = parseQuery(url.searchParams);
  if (!parsed.ok) return error(400, "invalid_parameter", parsed.message);
  const pretty = parsed.query.pretty === "1" || parsed.query.pretty === "true";
  return json(buildLeaderboardResponse(parsed.query, url), 200, pretty);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
}
