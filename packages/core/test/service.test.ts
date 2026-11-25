// Re-audit A: the attestor only signs executable DEX verdicts that have a fresh CEX fair price.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, recoverTypedDataAddress, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { parseQuoteResponse, toJson } from "../src/api.ts";
import { sqrtX96ToPriceE18, type FairPrice } from "../src/cex.ts";
import { parsePoolStateJson } from "../src/pool.ts";
import { createQuoteService } from "../src/service.ts";
import { guardDomain, QUOTE_TYPES } from "../src/sign.ts";

const state = parsePoolStateJson(
  readFileSync(fileURLToPath(new URL("../fixtures/pool_state.json", import.meta.url)), "utf8"),
);
// Public anvil dev key #0 (not a secret).
const attestor = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const guard: Address = getAddress("0x00000000000000000000000000000000000000aa");
const agent: Address = getAddress("0x00000000000000000000000000000000000a6e17");
const executor: Address = getAddress("0x00000000000000000000000000000000000e7ec0");

const fairAtSpot: FairPrice = {
  sqrtPriceX96: state.sqrtPriceX96,
  priceE18: sqrtX96ToPriceE18(state.sqrtPriceX96),
  lastTradeMs: 0,
  samples: 5,
  source: "test",
};

function service(fair: () => Promise<FairPrice | null>) {
  const client = {
    getCode: vi.fn(async () => "0x"),
    getBlock: vi.fn(async () => ({ timestamp: 1_800_000_000n })),
    readContract: vi.fn(),
  } as unknown as PublicClient;
  return createQuoteService({
    client,
    attestor,
    guard,
    chainId: 177,
    fairPrice: fair,
    ttlSeconds: 60,
    loadPoolState: async () => state,
  });
}

const req = (usdt: number) => ({ agent, executor, zeroForOne: false, amountIn: BigInt(usdt) * 10n ** 6n });

describe("createQuoteService", () => {
  it("signs an executable DEX verdict with a CEX reference; signature recovers to the attestor", async () => {
    const r = await service(async () => fairAtSpot).quote(req(50));
    expect(r.verdict.verdict).toBe("DEX");
    expect(r.attested).toBe(true);
    expect(r.quote!.fairSqrtPriceX96).toBe(fairAtSpot.sqrtPriceX96);
    expect(r.quote!.issuedAt).toBe(1_800_000_000n);
    const signer = await recoverTypedDataAddress({
      domain: guardDomain({ chainId: 177, verifyingContract: guard }),
      types: QUOTE_TYPES,
      primaryType: "Quote",
      message: r.quote!,
      signature: r.signature!,
    });
    expect(signer).toBe(attestor.address);
    // Wire round-trip used by MCP/agent.
    expect(parseQuoteResponse(JSON.parse(toJson(r)))).toEqual(r);
  });

  it("stale CEX → NO_REFERENCE, no signature, DEX spot not reported as fair", async () => {
    const r = await service(async () => null).quote(req(50));
    expect(r.verdict.verdict).toBe("NO_REFERENCE");
    expect(r.quote).toBeNull();
    expect(r.signature).toBeNull();
    expect(r.digest).toBeNull();
    expect(r.attested).toBe(false);
    expect(r.metrics.fairSqrtPriceX96).toBeNull();
    expect(r.metrics.impactBps).toBe(2);
  });

  it("CEX error → no signature and no raw upstream message", async () => {
    const r = await service(async () => {
      throw new Error("connect ECONNREFUSED https://secret-rpc.example/key");
    }).quote(req(50));
    expect(r.signature).toBeNull();
    expect(r.referenceError).toBe("CEX reference unavailable");
  });

  it("oversized → CEX verdict, not signed", async () => {
    const r = await service(async () => fairAtSpot).quote(req(20_000));
    expect(r.verdict.verdict).toBe("CEX");
    expect(r.signature).toBeNull();
    expect(r.metrics.suggestedMaxAmountIn).not.toBeNull();
  });

  it("parseQuoteResponse rejects a signature without a quote", () => {
    const r = { quote: null, signature: "0x12" };
    expect(() => parseQuoteResponse(r)).toThrow();
  });
});
