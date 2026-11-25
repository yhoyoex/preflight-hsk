import { describe, expect, it, vi } from "vitest";

const createQuote = vi.fn();
vi.mock("@/lib/quote", () => ({ createQuote }));

const { POST } = await import("../app/api/quote/route");

const AGENT = "0x00000000000000000000000000000000000a6E17";
const body = { agent: AGENT, executor: AGENT, zeroForOne: false, amountIn: "50" };
const req = (ip: string, b: unknown = body) =>
  new Request("http://localhost/api/quote", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(b),
  });

describe("POST /api/quote", () => {
  it("B: 30 requests per minute per IP, then 429 with Retry-After", async () => {
    createQuote.mockResolvedValue({ verdict: { verdict: "DEX" }, signature: null });
    for (let i = 0; i < 30; i++) expect((await POST(req("1.1.1.1"))).status).toBe(200);
    const res = await POST(req("1.1.1.1"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await POST(req("2.2.2.2"))).status).toBe(200);
  });

  it("C: RPC failures return a generic message and the log has no URL", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = new Error("HTTP request failed.\n\nURL: https://rpc.example/v1/SECRETKEY\nRequest body: {}");
    e.name = "HttpRequestError";
    createQuote.mockImplementation(async () => {
      throw new Error(`fetch failed https://rpc.example/v1/SECRETKEY`, { cause: e });
    });
    const res = await POST(req("3.3.3.3"));
    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: "upstream failure while quoting, retry later" });
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).not.toContain("rpc.example");
    expect(logged).not.toContain("SECRETKEY");
    log.mockRestore();
  });

  it("A: passes through an unsigned verdict (signature: null)", async () => {
    createQuote.mockResolvedValue({ quote: null, signature: null, attested: false, verdict: { verdict: "NO_REFERENCE" } });
    const res = await POST(req("4.4.4.4"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ quote: null, signature: null, attested: false });
  });
});
