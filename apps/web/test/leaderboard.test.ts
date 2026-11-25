import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/leaderboard/route";
import { leaderboard, shortAddress } from "@/lib/leaderboard";

describe("leaderboard snapshot", () => {
  it("/api/leaderboard serves the snapshot", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof leaderboard;
    expect(body.summary.swaps).toBe(leaderboard.summary.swaps);
    expect(body.wallets.length).toBeGreaterThan(0);
  });

  it("totals reconcile with the research report (2,136 swaps, ≈$40.6k)", () => {
    const { summary, wallets, histogram } = leaderboard;
    expect(summary.swaps).toBe(2136);
    expect(summary.volumeUsd).toBeGreaterThan(40_600);
    expect(summary.volumeUsd).toBeLessThan(40_700);
    expect(wallets.reduce((a, w) => a + w.swaps, 0)).toBe(summary.swaps);
    expect(histogram.reduce((a, b) => a + b.swaps, 0)).toBe(summary.swaps);
  });

  it("uses neutral wording only", () => {
    const page = readFileSync(fileURLToPath(new URL("../app/leaderboard/page.tsx", import.meta.url)), "utf8");
    expect(page).toContain("Execution cost");
    expect(page).not.toMatch(/terburuk|rugi|worst|loss/i);
  });

  it("shortAddress", () => {
    expect(shortAddress("0xec77ef78b577d758ad2ea59bd52c976bbabb4154")).toBe("0xec77…4154");
  });
});
