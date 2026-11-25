import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePoolStateJson, simulateSwap } from "../src/pool.ts";
import { deviationBps, fairFloorOut, DEFAULT_POLICY } from "../src/verdict.ts";

// Review #10: TS simulation vs real SwapRouter02 swaps on an HSK fork at block 30609500.
// Fixture written by contracts/test/GuardedRouter.fork.t.sol::test_fork_exportImpactFixture.
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

interface OnchainSwap {
  zeroForOne: boolean;
  amountIn: string;
  amountOut: string;
  sqrtPriceAfterX96: string;
  impactBps: number;
  postSwapDevBps: number;
  fairFloorOut: string;
}

const onchain = JSON.parse(fixture("onchain_impact.json")) as { block: number; sqrtPriceX96: string; swaps: OnchainSwap[] };
const stateText = fixture("pool_state_30609500.json");
const state = parsePoolStateJson(stateText);

describe("TS simulation vs on-chain (fork @30609500)", () => {
  it("uses the same block and spot", () => {
    expect((JSON.parse(stateText) as { block: number }).block).toBe(onchain.block);
    expect(state.sqrtPriceX96).toBe(BigInt(onchain.sqrtPriceX96));
    expect(onchain.swaps.length).toBeGreaterThanOrEqual(6);
  });

  it.each(onchain.swaps.map((s) => [s.zeroForOne ? "sell WHSK" : "buy WHSK", s.amountIn, s] as const))(
    "%s amountIn=%s: amountOut, price after, impactBps, devBps, fair floor match exactly",
    (_label, _amount, s) => {
      const r = simulateSwap(state, s.zeroForOne, BigInt(s.amountIn));
      expect(r.status).toBe("OK");
      expect(r.amountOut).toBe(BigInt(s.amountOut));
      expect(r.sqrtPriceAfterX96).toBe(BigInt(s.sqrtPriceAfterX96));
      expect(r.impactBpsCeil).toBe(s.impactBps);
      expect(deviationBps(r.sqrtPriceAfterX96, state.sqrtPriceX96)).toBe(s.postSwapDevBps);
      expect(fairFloorOut(s.zeroForOne, state.sqrtPriceX96, BigInt(s.amountIn), state.feePips, DEFAULT_POLICY)).toBe(
        BigInt(s.fairFloorOut),
      );
    },
  );
});
