import { createPublicClient, http, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { fetchPoolState, fetchSwapLogs, simulateSwap } from "../src/pool.ts";

// Network test, opt-in: HSK_LIVE=1 pnpm --filter @preflight/core test
const rpc = process.env.HSK_RPC_URL ?? "https://mainnet.hsk.xyz";

describe.skipIf(!process.env.HSK_LIVE)("live HSK mainnet", () => {
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient;

  it("fetches the pool state and simulates against it", { timeout: 120_000 }, async () => {
    const state = await fetchPoolState(client);
    expect(state.tickSpacing).toBe(60);
    expect(state.feePips).toBe(3000);
    expect(state.ticks.size).toBeGreaterThan(0);
    const r = simulateSwap(state, false, 50n * 10n ** 6n);
    expect(r.status).toBe("OK");
    expect(r.amountOut).toBeGreaterThan(0n);
  });

  it("fetches swap logs in chunks", { timeout: 120_000 }, async () => {
    const latest = await client.getBlockNumber();
    const logs = await fetchSwapLogs(client, latest - 12_000n, latest);
    expect(Array.isArray(logs)).toBe(true);
  });
});
