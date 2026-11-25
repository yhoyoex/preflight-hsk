import { describe, expect, it } from "vitest";
import { GET, OPTIONS } from "@/app/api/leaderboard/route";
import { leaderboard } from "@/lib/leaderboard";
import { buildLeaderboardResponse } from "@/lib/leaderboard-api";

// The rate limiter is a shared singleton (30/min per IP): every request uses its own IP.
let ip = 0;
const get = (query = "") =>
  GET(new Request(`http://localhost/api/leaderboard${query}`, { headers: { "x-forwarded-for": `10.9.0.${++ip}` } }));

interface Row {
  rank: number;
  address: string | null;
  explorerUrl: string | null;
  swaps: number;
  volumeUsd: number;
  meanCostBps: number | null;
  totalCostUsd: number;
  firstSeen: string;
  lastSeen: string;
}
interface Body {
  apiVersion: string;
  meta: { chainId: number; pool: { address: string; token0: { symbol: string; decimals: number } }; source: { kind: string } };
  summary: {
    swaps: number;
    uniqueWallets: number;
    volumeUsd: number;
    costBps: { median: number; p75: number; p90: number; volumeWeighted: number };
    costBreakdownBps: { fee: number; impact: number; cexGap: number };
    distribution: { label: string; swaps: number }[];
  };
  pagination: { total: number; limit: number; offset: number; next: string | null };
  data: Row[];
  links: { self: string; docs: string; page: string };
}
const body = async (q = "") => {
  const res = await get(q);
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};

describe("GET /api/leaderboard", () => {
  it("returns the versioned envelope", async () => {
    const b = await body();
    expect(b.apiVersion).toBe("1");
    expect(b.meta).toMatchObject({ chainId: 177, source: { kind: "snapshot" } });
    expect(b.meta.pool.address).toBe("0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC");
    expect(b.meta.pool.token0).toMatchObject({ symbol: "WHSK", decimals: 18 });
    expect(b.summary).toMatchObject({ swaps: 2136, uniqueWallets: leaderboard.summary.uniqueWallets });
    expect(b.summary.volumeUsd).toBeCloseTo(40_651.23, 1);
    expect(b.summary.distribution.map((d) => d.label)).toEqual(["<35", "35-50", "50-100", ">=100"]);
    expect(b.summary.distribution.reduce((a, d) => a + d.swaps, 0)).toBe(2136);
    const { fee, impact, cexGap } = b.summary.costBreakdownBps;
    expect(fee + impact + cexGap).toBeCloseTo(b.summary.costBps.volumeWeighted, 2);
    expect(b.summary.costBps.p90).toBeGreaterThanOrEqual(b.summary.costBps.p75);
    expect(b.pagination).toMatchObject({ total: leaderboard.wallets.length, limit: 50, offset: 0 });
    expect(b.data[0]!.rank).toBe(1);
    expect(b.data[0]!.explorerUrl).toBe(`https://hsk.blockscout.com/address/${b.data[0]!.address}`);
    expect(Date.parse(b.data[0]!.firstSeen)).toBeLessThanOrEqual(Date.parse(b.data[0]!.lastSeen));
    expect(b.links).toMatchObject({ self: "http://localhost/api/leaderboard", page: "http://localhost/leaderboard" });
    expect(b.links.docs).toMatch(/#leaderboard-api$/);
  });

  it("sorts, orders and paginates", async () => {
    const desc = await body("?sort=swaps&order=desc&limit=100");
    const swaps = desc.data.map((r) => r.swaps);
    expect(swaps).toEqual([...swaps].sort((a, b) => b - a));
    const asc = await body("?sort=costUsd&order=asc&limit=100");
    const cost = asc.data.map((r) => r.totalCostUsd);
    expect(cost).toEqual([...cost].sort((a, b) => a - b));
    const bps = (await body("?sort=costBps&limit=100")).data.map((r) => r.meanCostBps ?? 0);
    expect(bps).toEqual([...bps].sort((a, b) => b - a));

    const all = (await body("?limit=100")).data;
    const page = await body("?limit=5&offset=5");
    expect(page.data.map((r) => r.address)).toEqual(all.slice(5, 10).map((r) => r.address));
    expect(page.data.map((r) => r.rank)).toEqual([6, 7, 8, 9, 10]);
    expect(page.pagination.next).toBe("http://localhost/api/leaderboard?limit=5&offset=10");
    const last = await body(`?limit=5&offset=${all.length - 1}`);
    expect(last.data).toHaveLength(1);
    expect(last.pagination.next).toBeNull();
  });

  it("puts null metric values last for both orders", () => {
    const base = leaderboard.wallets[0]!;
    const w = (wallet: `0x${string}`, meanCostBps: number | null) => ({ ...base, wallet, meanCostBps });
    const lb = {
      ...leaderboard,
      wallets: [w("0x00000000000000000000000000000000000000a1", null), w("0x00000000000000000000000000000000000000a2", 40), w("0x00000000000000000000000000000000000000a3", 31)],
    };
    const order = (o: "asc" | "desc") =>
      buildLeaderboardResponse({ sort: "costBps", order: o, limit: 10, offset: 0 }, new URL("http://localhost/api/leaderboard"), lb).data.map(
        (r) => r.meanCostBps,
      );
    expect(order("desc")).toEqual([40, 31, null]);
    expect(order("asc")).toEqual([31, 40, null]);
  });

  it("filters by wallet, checksum-insensitive, keeping the global rank", async () => {
    const all = (await body("?limit=100")).data;
    const target = all[2]!;
    const b = await body(`?wallet=${target.address!.toLowerCase()}`);
    expect(b.data).toEqual([target]);
    expect(b.pagination.total).toBe(1);
    const none = await body("?wallet=0x0000000000000000000000000000000000000001");
    expect(none.data).toEqual([]);
  });

  it("rejects invalid params with 400 { error: { code, message } }", async () => {
    for (const q of ["?wallet=0xbad", "?sort=loss", "?order=up", "?limit=0", "?limit=101", "?offset=-1", "?limit=abc", "?pretty=yes"]) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const e = (await res.json()) as { error: { code: string; message: string } };
      expect(e.error.code).toBe("invalid_parameter");
      expect(e.error.message.length).toBeGreaterThan(0);
    }
    const e = (await (await get("?wallet=0xbad")).json()) as { error: { message: string } };
    expect(e.error.message).toMatch(/^wallet:/);
  });

  it("sets JSON, CORS and cache headers; ?pretty=1 indents", async () => {
    const res = await get("?limit=1&pretty=1");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toMatch(/^public, .*s-maxage=\d+.*stale-while-revalidate=\d+/);
    expect(await res.text()).toMatch(/^\{\n {2}"apiVersion": "1"/);
    expect(await (await get("?limit=1")).text()).not.toContain("\n");
  });

  it("rate limits per IP with key leaderboard:<ip> (429, same error format)", async () => {
    const req = () => GET(new Request("http://localhost/api/leaderboard?limit=1", { headers: { "x-forwarded-for": "10.9.9.9" } }));
    for (let i = 0; i < 30; i++) expect((await req()).status).toBe(200);
    const res = await req();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });
});

describe("OPTIONS /api/leaderboard", () => {
  it("answers the CORS preflight", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });
});
