import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GUARD_ABI,
  PREFLIGHT_ERRORS_ABI,
  ROUTER_ABI,
  toJson,
  type QuoteClient,
  type QuoteRequest,
  type QuoteResponse,
} from "@preflight/core";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.ts";
import { guardCheck, guardedSwap, guardQuote, type ToolDeps } from "../src/tools.ts";

const AGENT = getAddress("0x00000000000000000000000000000000000a6e17");
const GUARD = getAddress("0x00000000000000000000000000000000000000aa");
const ROUTER = getAddress("0x00000000000000000000000000000000000000bb");
const SIG = `0x${"11".repeat(65)}` as Hex;

const quote = {
  agent: AGENT,
  executor: ROUTER,
  pool: getAddress("0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC"),
  zeroForOne: false,
  amountIn: 50_000_000n,
  expectedImpactBps: 2,
  fairSqrtPriceX96: 22523105442617287490681n,
  issuedAt: 1_800_000_000n,
  expiry: 1_800_000_060n,
  nonce: 7n,
};

function response(signed: boolean, verdict: "DEX" | "CEX" | "NO_REFERENCE" = "DEX"): QuoteResponse {
  return {
    quote: signed ? quote : null,
    signature: signed ? SIG : null,
    digest: signed ? (`0x${"22".repeat(32)}` as Hex) : null,
    attested: signed,
    domain: { name: "Preflight ExecutionGuard", version: "1", chainId: 177, verifyingContract: GUARD },
    verdict: { verdict, executable: verdict === "DEX", reason: "r", reasons: ["r"], failedChecks: [] },
    metrics: {
      status: "OK",
      amountIn: 50_000_000n,
      amountOut: 600n * 10n ** 18n,
      impactBps: 2,
      devBps: 0,
      adverseDevBps: 0,
      postSwapDevBps: 2,
      feeBps: 30,
      totalCostBps: 32,
      notionalUsd: 50,
      minAmountOut: 590n * 10n ** 18n,
      suggestedMaxAmountIn: null,
      fairSource: "cex",
      fairSqrtPriceX96: signed ? quote.fairSqrtPriceX96 : null,
    },
    reference: null,
    referenceError: null,
    policy: { maxImpactBps: 100, maxDevBps: 200, maxAge: 120 },
    policySource: "default",
  };
}

const quoteClient = (r: QuoteResponse) => {
  const fn = vi.fn(async (_req: QuoteRequest) => r);
  return { client: { quote: fn } satisfies QuoteClient, fn };
};

/** Mock JSON-RPC: eth_call to ExecutionGuard.verify returns `verify()` (a policy or a revert). */
function mockRpc(verify: () => Hex | { revert: Hex }) {
  const calls: { method: string; params: unknown }[] = [];
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      if (method === "eth_chainId") return "0xb1";
      if (method === "eth_call") {
        const [tx] = params as [{ to: Address; data: Hex; from?: Address }];
        expect(tx.to.toLowerCase()).toBe(GUARD.toLowerCase());
        expect(decodeFunctionData({ abi: GUARD_ABI, data: tx.data }).functionName).toBe("verify");
        expect(tx.from?.toLowerCase()).toBe(ROUTER.toLowerCase()); // called as quote.executor
        const out = verify();
        if (typeof out === "string") return out;
        throw Object.assign(new Error("execution reverted"), { code: 3, data: out.revert });
      }
      throw new Error(`unexpected RPC ${method}`);
    },
  });
  return { client: createPublicClient({ transport }) as PublicClient, calls };
}

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe("guard_quote", () => {
  it("returns verdict + metrics and defaults executor to the GuardedRouter", async () => {
    const q = quoteClient(response(true));
    const deps: ToolDeps = { quotes: q.client, client: mockRpc(() => "0x").client, guard: GUARD, router: ROUTER, maxUsd: 100 };
    const out = parse(await guardQuote(deps, { agent: AGENT, tokenIn: "USDT", amountIn: "50" }));
    expect(q.fn).toHaveBeenCalledWith({ agent: AGENT, executor: ROUTER, zeroForOne: false, amountIn: 50_000_000n });
    expect(out.verdict).toBe("DEX");
    expect((out.metrics as Record<string, unknown>).impactBps).toBe(2);
    expect(out.signature).toBe(SIG);
  });

  it("unsigned verdict (re-audit A) → quote/signature null", async () => {
    const q = quoteClient(response(false, "NO_REFERENCE"));
    const deps: ToolDeps = { quotes: q.client, client: mockRpc(() => "0x").client, guard: GUARD, router: ROUTER, maxUsd: 100 };
    const out = parse(await guardQuote(deps, { agent: AGENT, tokenIn: "WHSK", amountIn: "600" }));
    expect(q.fn.mock.calls[0]![0].zeroForOne).toBe(true);
    expect(q.fn.mock.calls[0]![0].amountIn).toBe(600n * 10n ** 18n);
    expect(out).toMatchObject({ verdict: "NO_REFERENCE", attested: false, quote: null, signature: null });
  });
});

describe("guard_check (eth_call ExecutionGuard.verify, no tx)", () => {
  it("pass → policy", async () => {
    const policy = encodeFunctionResult({
      abi: GUARD_ABI,
      functionName: "verify",
      result: { maxImpactBps: 100, maxDevBps: 200, maxAge: 120n },
    });
    const rpc = mockRpc(() => policy);
    const deps: ToolDeps = { quotes: quoteClient(response(true)).client, client: rpc.client, guard: GUARD, router: ROUTER, maxUsd: 100 };
    const out = parse(await guardCheck(deps, { quote, signature: SIG }));
    expect(out).toMatchObject({ pass: true, policy: { maxImpactBps: 100, maxDevBps: 200, maxAge: 120 } });
    expect(rpc.calls.some((c) => c.method === "eth_sendRawTransaction" || c.method === "eth_sendTransaction")).toBe(false);
  });

  it("revert → decoded custom error", async () => {
    const data = encodeErrorResult({ abi: PREFLIGHT_ERRORS_ABI, errorName: "ImpactTooHigh", args: [454n, 100] });
    const deps: ToolDeps = {
      quotes: quoteClient(response(true)).client,
      client: mockRpc(() => ({ revert: data })).client,
      guard: GUARD,
      router: ROUTER,
      maxUsd: 100,
    };
    const out = parse(await guardCheck(deps, { quote, signature: SIG }));
    expect(out.pass).toBe(false);
    expect(out.error).toEqual({ name: "ImpactTooHigh", args: ["454", 100] });
    expect(out.message).toBe("ImpactTooHigh(454, 100)");
  });
});

describe("guarded_swap", () => {
  it("builds unsigned approve + guardedSwap with reasonHash when execution is disabled", async () => {
    const deps: ToolDeps = { quotes: quoteClient(response(true)).client, client: mockRpc(() => "0x").client, guard: GUARD, router: ROUTER, maxUsd: 100 };
    const reason = "CEX 1.2% above DEX; buy small.";
    const out = parse(await guardedSwap(deps, { agent: AGENT, tokenIn: "USDT", amountIn: "50", reason }));
    expect(out.sent).toBe(false);
    const txs = out.unsignedTxs as { to: string; data: Hex; from: string }[];
    expect(txs).toHaveLength(2);
    expect(txs[0]!.to).toBe("0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029"); // USDT approve
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: txs[1]!.data });
    expect(call.functionName).toBe("guardedSwap");
    expect(call.args[2]).toBe(590n * 10n ** 18n); // default amountOutMin = fair floor
    expect(call.args[3]).toBe(keccak256(stringToHex(reason)));
    expect(txs[1]!.to).toBe(ROUTER);
  });

  it("refuses a notional above PREFLIGHT_MAX_USD (review #2)", async () => {
    const r = response(true);
    const deps: ToolDeps = { quotes: quoteClient({ ...r, metrics: { ...r.metrics, notionalUsd: 100.01 } }).client, client: mockRpc(() => "0x").client, guard: GUARD, router: ROUTER, maxUsd: 100 };
    const out = await guardedSwap(deps, { agent: AGENT, tokenIn: "USDT", amountIn: "100.01", reason: "x" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toBe("notional ~$100.01 exceeds PREFLIGHT_MAX_USD $100; nothing built or sent");
    const atLimit = await guardedSwap({ ...deps, maxUsd: 100.01 }, { agent: AGENT, tokenIn: "USDT", amountIn: "100.01", reason: "x" });
    expect(atLimit.isError).toBeFalsy();
  });

  it("rejects amountOutMin below the quote's fair floor; accepts >= floor (review #2)", async () => {
    const deps: ToolDeps = { quotes: quoteClient(response(true)).client, client: mockRpc(() => "0x").client, guard: GUARD, router: ROUTER, maxUsd: 100 };
    const floor = 590n * 10n ** 18n;
    const low = await guardedSwap(deps, { agent: AGENT, tokenIn: "USDT", amountIn: "50", reason: "x", amountOutMin: String(floor - 1n) });
    expect(low.isError).toBe(true);
    expect(low.content[0]!.text).toMatch(/below the quote's fair floor 590000000000000000000/);
    const high = parse(await guardedSwap(deps, { agent: AGENT, tokenIn: "USDT", amountIn: "50", reason: "x", amountOutMin: String(floor + 5n) }));
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: (high.unsignedTxs as { data: Hex }[])[1]!.data });
    expect(call.args[2]).toBe(floor + 5n);
  });

  it("does not build txs when the attestor refused to sign", async () => {
    const deps: ToolDeps = { quotes: quoteClient(response(false, "CEX")).client, client: mockRpc(() => "0x").client, guard: GUARD, router: ROUTER, maxUsd: 100 };
    const out = parse(await guardedSwap(deps, { agent: AGENT, tokenIn: "USDT", amountIn: "20000", reason: "x" }));
    expect(out).toMatchObject({ verdict: "CEX", sent: false });
    expect(out.unsignedTxs).toBeUndefined();
  });
});

describe("MCP protocol", () => {
  it("tools/list returns the 3 tools; invalid input is rejected by zod", async () => {
    const deps: ToolDeps = { quotes: quoteClient(response(true)).client, client: mockRpc(() => "0x").client, guard: GUARD, router: ROUTER, maxUsd: 100 };
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createServer(deps);
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["guard_check", "guard_quote", "guarded_swap"]);
    const bad = await client.callTool({ name: "guard_quote", arguments: { agent: "0x123", tokenIn: "USDT", amountIn: "50" } });
    expect(bad.isError).toBe(true);
    const good = await client.callTool({ name: "guard_quote", arguments: { agent: AGENT, tokenIn: "USDT", amountIn: "50" } });
    expect(good.isError).toBeFalsy();
    expect(JSON.parse((good.content as { text: string }[])[0]!.text).verdict).toBe("DEX");
    await client.close();
  });

  it("serialises bigints as strings", () => {
    expect(toJson({ a: 1n })).toBe('{"a":"1"}');
  });
});
