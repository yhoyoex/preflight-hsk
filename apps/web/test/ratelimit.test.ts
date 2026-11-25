import { describe, expect, it, vi } from "vitest";
import { cappedMemoryRateLimiter, clientIp, memoryRateLimiter, upstashRateLimiter } from "../lib/ratelimit";

describe("memoryRateLimiter", () => {
  it("allows `capacity` per window per key, then refills", async () => {
    let t = 0;
    const rl = memoryRateLimiter(30, 60_000, () => t);
    for (let i = 0; i < 30; i++) expect((await rl.limit("a")).ok).toBe(true);
    const denied = await rl.limit("a");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBe(2); // 1 token per 2 s
    expect((await rl.limit("b")).ok).toBe(true); // other IP unaffected
    t += 2_000;
    expect((await rl.limit("a")).ok).toBe(true);
    expect((await rl.limit("a")).ok).toBe(false);
  });
});

describe("upstashRateLimiter", () => {
  const reply = (count: number, pttl: number) =>
    new Response(JSON.stringify([{ result: null }, { result: count }, { result: pttl }]), { status: 200 });

  it("uses the INCR count from the REST pipeline", async () => {
    const fetchFn = vi.fn(async () => reply(31, 12_345));
    const fallback = { limit: vi.fn() };
    const rl = upstashRateLimiter({ url: "https://x.upstash.io/", token: "t", limit: 30, fallback, fetchFn });
    expect(await rl.limit("1.2.3.4")).toEqual({ ok: false, retryAfterSec: 13 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.upstash.io/pipeline");
    expect(JSON.parse(String(init.body))[1]).toEqual(["INCR", "preflight:rl:1.2.3.4"]);
    expect(fallback.limit).not.toHaveBeenCalled();
  });

  it("falls back to the in-memory limiter when Upstash fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fallback = memoryRateLimiter(1);
    const rl = upstashRateLimiter({
      url: "https://x.upstash.io",
      token: "t",
      limit: 30,
      fallback,
      fetchFn: async () => new Response("down", { status: 503 }),
    });
    expect((await rl.limit("k")).ok).toBe(true);
    expect((await rl.limit("k")).ok).toBe(false);
    err.mockRestore();
  });
});

describe("clientIp", () => {
  const ip = (headers: Record<string, string>) => clientIp(new Request("http://l", { headers }));

  it("prefers platform headers: x-vercel-forwarded-for, then x-real-ip", () => {
    expect(ip({ "x-vercel-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" })).toBe("1.1.1.1");
    expect(ip({ "x-real-ip": "8.8.8.8", "x-forwarded-for": "3.3.3.3" })).toBe("8.8.8.8");
    expect(ip({})).toBe("unknown");
  });

  it("a spoofed first X-Forwarded-For hop does not change the key (last hop = trusted proxy)", () => {
    expect(ip({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })).toBe("10.0.0.1");
    for (const fake of ["1.2.3.4", "5.6.7.8", "evil"]) {
      expect(ip({ "x-forwarded-for": `${fake}, 10.0.0.1` })).toBe("10.0.0.1");
      expect(ip({ "x-real-ip": "8.8.8.8", "x-forwarded-for": `${fake}, 10.0.0.1` })).toBe("8.8.8.8");
    }
  });
});

describe("cappedMemoryRateLimiter (no Upstash)", () => {
  it("global bucket denies after the ceiling, across fresh keys", async () => {
    let t = 0;
    const rl = cappedMemoryRateLimiter(30, 300, 60_000, () => t);
    for (let i = 0; i < 300; i++) expect((await rl.limit(`ip-${i}`)).ok).toBe(true);
    const denied = await rl.limit("brand-new");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    t += 1_000; // refills 5 tokens per second
    expect((await rl.limit("brand-new")).ok).toBe(true);
  });

  it("per-key denials refund the global token", async () => {
    const rl = cappedMemoryRateLimiter(2, 5, 60_000, () => 0);
    expect((await rl.limit("a")).ok).toBe(true);
    expect((await rl.limit("a")).ok).toBe(true);
    for (let i = 0; i < 10; i++) expect((await rl.limit("a")).ok).toBe(false);
    for (const k of ["b", "c", "d"]) expect((await rl.limit(k)).ok).toBe(true);
  });

  it("a full key map does not evict a recently limited key (flood cannot reset it)", async () => {
    let t = 0;
    const rl = memoryRateLimiter(1, 60_000, () => t, 3);
    expect((await rl.limit("victim")).ok).toBe(true);
    expect((await rl.limit("victim")).ok).toBe(false);
    expect((await rl.limit("x1")).ok).toBe(true);
    expect((await rl.limit("x2")).ok).toBe(true);
    expect((await rl.limit("x3")).ok).toBe(false); // map full, nobody idle → new key denied
    expect((await rl.limit("victim")).ok).toBe(false); // still limited
    t += 60_000; // oldest bucket idle a whole window → evictable
    expect((await rl.limit("x3")).ok).toBe(true);
  });
});
