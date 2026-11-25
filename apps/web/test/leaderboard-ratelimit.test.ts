import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/leaderboard/route";
import { DEFAULT_GLOBAL_PER_MINUTE, leaderboardRateLimiter, quoteRateLimiter } from "@/lib/ratelimit";

describe("leaderboard rate limiter", () => {
  it("is a separate instance from the quote limiter", () => {
    expect(leaderboardRateLimiter()).not.toBe(quoteRateLimiter());
  });

  it("draining the leaderboard global bucket leaves /api/quote capacity untouched", async () => {
    // Exhaust the leaderboard global ceiling with distinct IPs (as a scraper rotating addresses would).
    for (let i = 0; i < DEFAULT_GLOBAL_PER_MINUTE; i++) {
      expect((await leaderboardRateLimiter().limit(`leaderboard:10.50.${i >> 8}.${i & 255}`)).ok).toBe(true);
    }
    const blocked = await GET(new Request("http://localhost/api/leaderboard?limit=1", { headers: { "x-forwarded-for": "10.60.0.1" } }));
    expect(blocked.status).toBe(429);

    // The quote limiter still grants its full global budget.
    for (let i = 0; i < DEFAULT_GLOBAL_PER_MINUTE; i++) {
      expect((await quoteRateLimiter().limit(`10.70.${i >> 8}.${i & 255}`)).ok).toBe(true);
    }
    expect((await quoteRateLimiter().limit("10.80.0.1")).ok).toBe(false);
  });
});
