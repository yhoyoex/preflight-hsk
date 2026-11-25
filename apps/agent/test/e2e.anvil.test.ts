// E2E on an anvil fork of HashKey Chain mainnet (block 30609500): deploy ExecutionGuard + GuardedRouter locally,
// run the agent live (1 successful guardedSwap), then an oversized swap that the Guard reverts with a custom error.
// Opt-in (network + anvil): PREFLIGHT_E2E=1 pnpm --filter @preflight/agent test:e2e
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildQuote,
  createQuoteService,
  ERC20_ABI,
  fetchPoolState,
  forceApprove,
  med5,
  priceE18ToSqrtX96,
  ROUTER_ABI,
  sendGuardedSwap,
  signQuote,
  simulateSwap,
  SWAP_ROUTER02,
  USDT,
  V3_FACTORY,
  WHSK_USDT_POOL,
  type FairPrice,
  type Kline,
  type QuoteRequest,
} from "@preflight/core";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tick } from "../src/agent.ts";
import { deterministicProposer } from "../src/llm.ts";
import { runRevertScenario } from "../src/scenario.ts";
import { priceOf, spFromX96 } from "../src/strategy.ts";

const FORK_URL = process.env.HSK_FORK_URL ?? "https://mainnet.hsk.xyz";
const FORK_BLOCK = "30609500";
/** Local blocks only (the upstream RPC rejects large eth_getLogs ranges). */
const FORK_FROM = BigInt(FORK_BLOCK) + 1n;
// Public anvil dev keys (not secrets): #0 deployer/owner/attestor, #1 agent.
const OWNER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AGENT_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifact = (name: string) => join(root, "contracts", "out", `${name}.sol`, `${name}.json`);
const anvilBin = [process.env.ANVIL_BIN, join(homedir(), ".foundry", "bin", "anvil")].find(
  (p): p is string => p !== undefined && existsSync(p),
);
const ready =
  process.env.PREFLIGHT_E2E === "1" &&
  anvilBin !== undefined &&
  existsSync(artifact("ExecutionGuard")) &&
  existsSync(artifact("GuardedRouter"));

const load = (name: string) => {
  const j = JSON.parse(readFileSync(artifact(name), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
};

describe.skipIf(!ready)("e2e: agent --live on anvil fork 30609500", () => {
  const port = 19_545 + Math.floor(Math.random() * 1000);
  const rpc = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: 177,
    name: "HSK fork",
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const owner = privateKeyToAccount(OWNER_KEY);
  const agentAcc = privateKeyToAccount(AGENT_KEY);
  const dir = mkdtempSync(join(tmpdir(), "pf-e2e-"));
  let anvil: ChildProcess | undefined;
  let pub: PublicClient;
  let guard: Address;
  let router: Address;
  let klines: Kline[];
  let fair: FairPrice;

  beforeAll(async () => {
    // anvil 1.10's first upstream request sometimes times out before its retry succeeds (~45 s), hence the long wait.
    anvil = spawn(
      anvilBin!,
      ["--fork-url", FORK_URL, "--fork-block-number", FORK_BLOCK, "--port", String(port), "--timeout", "60000", "--retries", "5", "--silent"],
      { stdio: "ignore" },
    );
    pub = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000, retryCount: 0 }) }) as PublicClient;
    for (let i = 0; ; i++) {
      try {
        await pub.getChainId();
        break;
      } catch (err) {
        if (i > 1_500 || anvil.exitCode !== null) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const ownerW = createWalletClient({ account: owner, chain, transport: http(rpc) });
    const deploy = async (name: string, args: readonly unknown[]) => {
      const c = load(name);
      const hash = await ownerW.deployContract({ abi: c.abi, bytecode: c.bytecode, args });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
      return r.contractAddress;
    };
    guard = await deploy("ExecutionGuard", [owner.address]);
    router = await deploy("GuardedRouter", [guard, SWAP_ROUTER02, V3_FACTORY]);
    const add = await ownerW.writeContract({
      address: guard,
      abi: parseAbi(["function addAttestor(address)"]),
      functionName: "addAttestor",
      args: [owner.address],
    });
    await pub.waitForTransactionReceipt({ hash: add });

    // Fund the agent with USDT from the pool (impersonated; V3 pricing uses internal state, not balances).
    await pub.request({ method: "anvil_impersonateAccount" as never, params: [WHSK_USDT_POOL] as never });
    await pub.request({ method: "anvil_setBalance" as never, params: [WHSK_USDT_POOL, "0xDE0B6B3A7640000"] as never });
    const poolW = createWalletClient({ account: WHSK_USDT_POOL, chain, transport: http(rpc) });
    const fund = await poolW.writeContract({
      address: USDT,
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [agentAcc.address, parseUnits("20100", 6)],
    });
    await pub.waitForTransactionReceipt({ hash: fund });

    // Injected CEX: med5 = DEX spot × 1.015 (DEX 150 bps cheap → agent buys WHSK with USDT).
    const state = await fetchPoolState(pub);
    const cexPrice = priceOf(spFromX96(state.sqrtPriceX96)) * 1.015;
    const now = Date.now();
    klines = Array.from({ length: 5 }, (_, k) => ({
      openTimeMs: now - (4 - k) * 60_000,
      closeE18: parseUnits(cexPrice.toFixed(12), 18),
      volume: 100,
    }));
    const ref = med5(klines, now)!;
    fair = { ...ref, sqrtPriceX96: priceE18ToSqrtX96(ref.priceE18), source: "e2e injected med5" };
  }, 300_000);

  afterAll(() => {
    anvil?.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  const service = () =>
    createQuoteService({ client: pub, attestor: owner, guard, chainId: 177, fairPrice: async () => fair, ttlSeconds: 60 });

  it("1 successful guardedSwap; GuardedSwap event read back", async () => {
    const logPath = join(dir, "reasons.jsonl");
    const r = await tick({
      agent: agentAcc.address,
      router,
      client: pub,
      quotes: service(),
      proposer: deterministicProposer,
      klines: async () => klines,
      poolState: () => fetchPoolState(pub),
      capitalUsd: 100,
      wallet: createWalletClient({ account: agentAcc, chain, transport: http(rpc) }),
      live: true,
      logPath,
    });
    console.log(`[e2e] success: action=${r.action} tx=${r.txHash} amountIn=${r.amountIn} USDT verdict=${r.verdict}`);
    expect(r).toMatchObject({ mode: "live", action: "sent", tokenIn: "USDT", verdict: "DEX", attested: true });
    expect(Number(r.amountIn)).toBeGreaterThan(40);
    expect(Number(r.amountIn)).toBeLessThanOrEqual(50);

    const events = await pub.getContractEvents({ address: router, abi: ROUTER_ABI, eventName: "GuardedSwap", fromBlock: FORK_FROM });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.transactionHash).toBe(r.txHash);
    expect(ev.args.agent).toBe(agentAcc.address);
    expect(ev.args.reasonHash).toBe(r.reasonHash);
    expect(ev.args.amountOut).toBeGreaterThan(0n);
    console.log(`[e2e] GuardedSwap: amountOut=${ev.args.amountOut} impactBps=${ev.args.impactBps} devBps=${ev.args.devBps}`);
    expect(JSON.parse(readFileSync(logPath, "utf8").trim()).reasonHash).toBe(ev.args.reasonHash);
  }, 120_000);

  it("oversized: attestor refuses to sign; a forced signed quote reverts on-chain with ImpactTooHigh", async () => {
    const req: QuoteRequest = { agent: agentAcc.address, executor: router, zeroForOne: false, amountIn: parseUnits("20000", 6) };
    const off = await service().quote(req);
    expect(off.verdict.verdict).toBe("CEX");
    expect(off.signature).toBeNull();

    // Bypass the off-chain check (as a buggy/compromised attestor would): the on-chain Guard still refuses.
    const state = await fetchPoolState(pub);
    const sim = simulateSwap(state, false, req.amountIn);
    const block = await pub.getBlock();
    const quote = buildQuote({
      ...req,
      pool: WHSK_USDT_POOL,
      expectedImpactBps: sim.impactBpsCeil,
      fairSqrtPriceX96: fair.sqrtPriceX96,
      issuedAt: block.timestamp,
      ttlSeconds: 60,
    });
    const signature = await signQuote(owner, { chainId: 177, verifyingContract: guard }, quote);
    const wallet = createWalletClient({ account: agentAcc, chain, transport: http(rpc) });
    const res = await sendGuardedSwap(
      pub,
      wallet,
      { router, quote, signature, amountOutMin: 1n, reasonHash: `0x${"00".repeat(32)}` },
      { forceSend: true },
    );
    console.log(`[e2e] revert: status=${res.status} ${"hash" in res ? `tx=${res.hash}` : ""} error=${"message" in res ? res.message : ""}`);
    expect(res.status).toBe("reverted");
    if (res.status !== "reverted") return;
    expect(res.error?.name).toBe("ImpactTooHigh");
    const receipt = await pub.getTransactionReceipt({ hash: res.hash });
    expect(receipt.status).toBe("reverted");
    const events = await pub.getContractEvents({ address: router, abi: ROUTER_ABI, eventName: "GuardedSwap", fromBlock: FORK_FROM });
    expect(events).toHaveLength(1); // still only the successful swap
  }, 120_000);

  it("HSK USDT accepts approve non-zero → non-zero, so forceApprove sends a single tx (review #6)", async () => {
    const wallet = createWalletClient({ account: agentAcc, chain, transport: http(rpc) });
    const allowance = () =>
      pub.readContract({ address: USDT, abi: ERC20_ABI, functionName: "allowance", args: [agentAcc.address, router] });
    await forceApprove(pub, wallet, USDT, router, 3n, await allowance());
    expect(await allowance()).toBe(3n);
    const before = await pub.getTransactionCount({ address: agentAcc.address });
    await forceApprove(pub, wallet, USDT, router, 7n, 3n);
    expect(await allowance()).toBe(7n);
    expect(await pub.getTransactionCount({ address: agentAcc.address })).toBe(before + 1); // no reset-to-0 tx
  }, 60_000);

  it("--scenario revert: honest quote, front-run in the same block → Guard reverts DeviationTooHigh", async () => {
    const r = await runRevertScenario({ rpc, logPath: join(dir, "scenario.jsonl") });
    console.log(`[e2e] scenario: block=${r.block} bot=${r.botTx} agent=${r.agent.txHash} ${r.agent.error}`);
    expect(r.agent).toMatchObject({ action: "reverted", verdict: "DEX", attested: true });
    expect(r.agent.error).toMatch(/^DeviationTooHigh\(\d+, 200\)$/);
    expect(r.order).toEqual([r.botTx, r.agent.txHash]); // same block, bot first
    const receipt = await pub.getTransactionReceipt({ hash: r.agent.txHash! });
    expect(receipt.status).toBe("reverted");
    expect(r.spotAfter).toBeGreaterThan(r.spotBefore);
  }, 180_000);
});
