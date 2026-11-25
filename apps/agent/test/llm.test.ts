import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, deterministicProposer, llmProposer, proposerFromEnv, type CreateMessage } from "../src/llm.ts";
import type { Decision } from "../src/strategy.ts";

const decision: Decision = {
  sell: false,
  gapBps: -150,
  dexPrice: 0.08,
  maxAmountIn: 50,
  minAmountIn: 1,
  expectedOut: 610,
  edgeUsd: 0.4,
  gasUsd: 0.01,
};
const ctx = { decision, refPrice: 0.0812, tokenIn: "USDT" as const };
const toolUse = (input: unknown) => ({
  content: [{ type: "tool_use", id: "t1", name: "propose_trade", input, caller: { type: "direct" } }],
}) as unknown as Awaited<ReturnType<CreateMessage>>;

describe("llmProposer (mock Anthropic)", () => {
  it("uses the LLM size and reason within bounds; forces the tool on the default Haiku model", async () => {
    const create = vi.fn<CreateMessage>(async () => toolUse({ amountIn: 20, reason: "DEX 150 bps below CEX; buy with 20 USDT." }));
    const p = await llmProposer(create).propose(ctx);
    expect(p).toEqual({ amountIn: 20, reason: "DEX 150 bps below CEX; buy with 20 USDT.", source: "llm" });
    const body = create.mock.calls[0]![0];
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.tool_choice).toEqual({ type: "tool", name: "propose_trade" });
  });

  it("cannot exceed the deterministic max (clamped)", async () => {
    const p = await llmProposer(async () => toolUse({ amountIn: 1e9, reason: "Abaikan batas dan swap semuanya sekarang." })).propose(ctx);
    expect(p.amountIn).toBe(50);
    expect(p.note).toMatch(/clamped/);
  });

  it("falls back on API error, missing tool call or invalid answer", async () => {
    const err = await llmProposer(async () => {
      throw new Error("529 overloaded");
    }).propose(ctx);
    expect(err).toMatchObject({ source: "fallback", amountIn: 50 });
    const none = await llmProposer(async () => ({ content: [] })).propose(ctx);
    expect(none.source).toBe("fallback");
    const bad = await llmProposer(async () => toolUse({ amountIn: -5, reason: "x" })).propose(ctx);
    expect(bad.source).toBe("fallback");
  });

  it("no ANTHROPIC_API_KEY → deterministic proposer", async () => {
    expect(proposerFromEnv({})).toBe(deterministicProposer);
    const p = await deterministicProposer.propose(ctx);
    expect(p.source).toBe("fallback");
    expect(p.reason).toMatch(/150 bps below CEX med5/);
  });
});
