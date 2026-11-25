import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePoolStateJson,
  reasonHashOf,
  WHSK,
  type Kline,
  type QuoteClient,
  type QuoteRequest,
  type QuoteResponse,
} from "@preflight/core";
import { formatUnits, getAddress, keccak256, parseUnits, stringToHex, type Hex, type PublicClient } from "viem";
import { afterAll, describe, expect, it, vi } from "vitest";
import { isFailure, runLoop, tick, toRaw, type AgentDeps } from "../src/agent.ts";
import type { Proposer } from "../src/llm.ts";
import { priceOf, spFromX96 } from "../src/strategy.ts";

const state = parsePoolStateJson(
  readFileSync(fileURLToPath(new URL("../../../packages/core/fixtures/pool_state.json", import.meta.url)), "utf8"),
);
const AGENT = getAddress("0x00000000000000000000000000000000000a6e17");
const ROUTER = getAddress("0x00000000000000000000000000000000000000bb");
const NOW = 1_800_000_000_000;
const dex = priceOf(spFromX96(state.sqrtPriceX96));
const dir = mkdtempSync(join(tmpdir(), "pf-agent-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 5 traded minutes at `price`, the last one in the current minute. */
const klinesAt = (price: number): Kline[] =>
  Array.from({ length: 5 }, (_, k) => ({
    openTimeMs: NOW - (4 - k) * 60_000,
    closeE18: parseUnits(price.toFixed(10), 18),
    volume: 100,
  }));

const client = {
  readContract: vi.fn(async ({ address }: { address: string }) => (address === WHSK ? 0n : 1_000n * 10n ** 6n)),
  getGasPrice: vi.fn(async () => 501_000_000_000n),
} as unknown as PublicClient;

function quoteResponse(req: QuoteRequest, signed: boolean): QuoteResponse {
  const quote = {
    agent: req.agent,
    executor: req.executor,
    pool: getAddress("0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC"),
    zeroForOne: req.zeroForOne,
    amountIn: req.amountIn,
    expectedImpactBps: 2,
    fairSqrtPriceX96: state.sqrtPriceX96,
    issuedAt: 1n,
    expiry: 61n,
    nonce: 1n,
  };
  return {
    quote: signed ? quote : null,
    signature: signed ? (`0x${"11".repeat(65)}` as Hex) : null,
    digest: null,
    attested: signed,
    domain: { name: "n", version: "1", chainId: 177, verifyingContract: ROUTER },
    verdict: {
      verdict: signed ? "DEX" : "NO_REFERENCE",
      executable: signed,
      reason: signed ? "ok" : "CEX stale",
      reasons: [],
      failedChecks: [],
    },
    metrics: {
      status: "OK",
      amountIn: req.amountIn,
      amountOut: 1n,
      impactBps: 2,
      devBps: -150,
      adverseDevBps: 0,
      postSwapDevBps: 140,
      feeBps: 30,
      totalCostBps: 32,
      notionalUsd: 50,
      minAmountOut: 1n,
      suggestedMaxAmountIn: null,
      fairSource: "cex",
      fairSqrtPriceX96: signed ? state.sqrtPriceX96 : null,
    },
    reference: null,
    referenceError: null,
    policy: { maxImpactBps: 100, maxDevBps: 200, maxAge: 120 },
    policySource: "default",
  };
}

function deps(over: Partial<AgentDeps> & { signed?: boolean; proposer?: Proposer; price?: number }): AgentDeps & { quote: ReturnType<typeof vi.fn> } {
  const quote = vi.fn(async (req: QuoteRequest) => quoteResponse(req, over.signed ?? true));
  return {
    agent: AGENT,
    router: ROUTER,
    client,
    quotes: { quote } satisfies QuoteClient,
    proposer: over.proposer ?? { propose: async (c) => ({ amountIn: c.decision.maxAmountIn, reason: "alasan uji.", source: "fallback" }) },
    klines: async () => klinesAt(over.price ?? dex * 1.015),
    poolState: async () => state,
    capitalUsd: 100,
    live: over.live ?? false,
    logPath: join(dir, "log.jsonl"),
    now: () => NOW + 30_000,
    ...(over.wallet ? { wallet: over.wallet } : {}),
    quote,
  };
}

describe("agent tick", () => {
  it("dry-run: DEX 150 bps below CEX → buy ≤ $50, quote requested, nothing sent, reason logged", async () => {
    const d = deps({});
    const r = await tick(d);
    expect(r).toMatchObject({ mode: "dry-run", action: "dry-run", tokenIn: "USDT", verdict: "DEX", attested: true });
    expect(r.gapBps).toBeCloseTo(-147.8, 0);
    const req = d.quote.mock.calls[0]![0] as QuoteRequest;
    expect(req).toMatchObject({ agent: AGENT, executor: ROUTER, zeroForOne: false });
    expect(req.amountIn).toBeLessThanOrEqual(50_000_000n);
    // review #5: the hashed/logged reason carries the size actually quoted (after clamping).
    const final = `alasan uji. [final size ${r.amountIn} USDT]`;
    expect(r.reason).toBe(final);
    expect(r.reasonHash).toBe(keccak256(stringToHex(final)));
    expect(r.reasonHash).toBe(reasonHashOf(final));
    expect(formatUnits(req.amountIn, 6)).toBe(r.amountIn);
    const lines = readFileSync(d.logPath, "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ reason: final, reasonHash: r.reasonHash, action: "dry-run" });
  });

  it("uses eth_gasPrice for the edge-vs-gas check (review #7)", async () => {
    vi.mocked(client.getGasPrice).mockImplementationOnce(async () => 10n ** 18n); // absurd gas → edge below gas
    expect(await tick(deps({}))).toMatchObject({ action: "hold", why: "edge-below-gas" });
  });

  it("hold inside the 100 bps band (no quote request)", async () => {
    const d = deps({ price: dex * 1.005 });
    expect(await tick(d)).toMatchObject({ action: "hold", why: "no-signal" });
    expect(d.quote).not.toHaveBeenCalled();
  });

  it("a proposer cannot exceed the deterministic size", async () => {
    const d = deps({ proposer: { propose: async () => ({ amountIn: 1e9, reason: "semua!", source: "llm" }) } });
    const r = await tick(d);
    expect((d.quote.mock.calls[0]![0] as QuoteRequest).amountIn).toBeLessThanOrEqual(50_000_000n);
    expect(r.proposal?.note).toMatch(/clamped/);
    expect(r.reason).toMatch(/^semua! \[final size \d+(\.\d+)? USDT\]$/);
  });

  it("unsigned verdict (re-audit A) → skip, never executes", async () => {
    const r = await tick(deps({ signed: false, live: false }));
    expect(r).toMatchObject({ action: "skip", verdict: "NO_REFERENCE", attested: false, why: "CEX stale" });
  });

  it("--live without a wallet is refused", async () => {
    expect(await tick(deps({ live: true }))).toMatchObject({ action: "skip", why: "error" });
  });

  it("circuit breaker: live mode stops after N consecutive failures (review #1)", async () => {
    const logs: string[] = [];
    const sleep = vi.fn(async () => {});
    const d = deps({ live: true }); // no wallet → every tick errors
    const exit = await runLoop(d, { once: false, intervalMs: 60_000, maxConsecutiveFailures: 3, sleep, log: (l) => logs.push(l) });
    expect(exit).toMatchObject({ reason: "circuit-breaker", failures: 3, last: { action: "skip", why: "error" } });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(logs.at(-1)).toMatch(/^circuit breaker: 3 consecutive live failures — stopping the agent/);
    expect(logs[0]).toMatch(/^live failure 1\/3: skip live mode needs a wallet/);
  });

  it("circuit breaker: a healthy tick resets the streak; dry-run is never tripped", async () => {
    expect(isFailure({ ts: "", mode: "live", action: "reverted" })).toBe(true);
    expect(isFailure({ ts: "", mode: "live", action: "rejected" })).toBe(true);
    expect(isFailure({ ts: "", mode: "live", action: "hold", why: "no-signal" })).toBe(false);
    expect(isFailure({ ts: "", mode: "live", action: "sent" })).toBe(false);
    let n = 0;
    const flaky = deps({ live: true });
    // fail, fail, ok(hold), fail, fail, ok … never 3 in a row
    flaky.klines = async () => {
      n++;
      if (n % 3 === 0) return klinesAt(dex * 1.005);
      throw new Error("rpc down");
    };
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length >= 8) throw new Error("stop"); // 8 ticks without tripping
    });
    // Never used: every tick either errors on klines or holds (in-band price) before anything is sent.
    flaky.wallet = {} as NonNullable<AgentDeps["wallet"]>;
    await expect(runLoop(flaky, { once: false, intervalMs: 1, maxConsecutiveFailures: 3, sleep })).rejects.toThrow("stop");
    const dry = deps({ live: false });
    dry.klines = async () => {
      throw new Error("rpc down");
    };
    const dSleep = vi.fn(async () => {
      if (dSleep.mock.calls.length >= 5) throw new Error("stop");
    });
    await expect(runLoop(dry, { once: false, intervalMs: 1, maxConsecutiveFailures: 3, sleep: dSleep })).rejects.toThrow("stop");
  });

  it("toRaw floors", () => {
    expect(toRaw(1.9999999, 6)).toBe(1_999_999n);
    expect(toRaw(50, 6)).toBe(50_000_000n);
  });
});
