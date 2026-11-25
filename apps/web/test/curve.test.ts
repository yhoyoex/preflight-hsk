import { describe, expect, it, vi } from "vitest";

const costCurve = vi.fn();
vi.mock("@/lib/curve", () => ({ costCurve }));

const { POST } = await import("../app/api/curve/route");

const req = (ip: string, b: unknown = { zeroForOne: false }) =>
  new Request("http://localhost/api/curve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(b),
  });

describe("POST /api/curve", () => {
  it("returns the curve and serializes bigints", async () => {
    costCurve.mockResolvedValue({ zeroForOne: false, points: [{ usd: 50, amountIn: 50_000_000n }] });
    const res = await POST(req("5.5.5.5"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ points: [{ usd: 50, amountIn: "50000000" }] });
  });

  it("rejects bodies other than { zeroForOne }", async () => {
    expect((await POST(req("6.6.6.6", { zeroForOne: false, amountIn: "1" }))).status).toBe(400);
  });

  it("is rate limited (30/min per IP) and hides upstream errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    costCurve.mockRejectedValue(new Error("fetch failed https://rpc.example/SECRET"));
    const first = await POST(req("7.7.7.7"));
    expect(first.status).toBe(502);
    expect(JSON.stringify(await first.json())).not.toContain("rpc.example");
    for (let i = 0; i < 29; i++) await POST(req("7.7.7.7"));
    const res = await POST(req("7.7.7.7"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    log.mockRestore();
  });

  it("uses its own rate-limit key, so curves do not spend the quote budget", async () => {
    const { quoteRateLimiter } = await import("@/lib/ratelimit");
    for (let i = 0; i < 30; i++) expect((await quoteRateLimiter().limit("8.8.8.8")).ok).toBe(true);
    costCurve.mockResolvedValue({ zeroForOne: true, points: [] });
    expect((await POST(req("8.8.8.8", { zeroForOne: true }))).status).toBe(200);
  });
});
