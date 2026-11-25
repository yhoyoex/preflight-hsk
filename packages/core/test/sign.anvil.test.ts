// Proves sign.ts produces signatures ExecutionGuard.verify accepts, against the compiled contract on a local anvil.
// Requires `forge build` (contracts/out) and anvil (ANVIL_BIN, PATH or ~/.foundry/bin); skipped otherwise.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePoolStateJson, simulateSwap } from "../src/pool.ts";
import { buildQuote, hashQuote, QUOTE_TYPEHASH, randomNonce, signQuote, type Quote } from "../src/sign.ts";
import { evaluate } from "../src/verdict.ts";

// Public anvil default dev keys (not secrets): #0 deployer/owner/attestor, #1 executor, #2 rogue.
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as const satisfies readonly Hex[];

const root = fileURLToPath(new URL("../../../", import.meta.url));
const artifact = (file: string, name: string) => join(root, "contracts", "out", file, `${name}.json`);
const anvilBin = [process.env.ANVIL_BIN, join(homedir(), ".foundry", "bin", "anvil")].find(
  (p): p is string => p !== undefined && existsSync(p),
);
const guardArtifact = artifact("ExecutionGuard.sol", "ExecutionGuard");
const poolArtifact = artifact("PreflightBase.sol", "MockPool");
const ready = anvilBin !== undefined && existsSync(guardArtifact) && existsSync(poolArtifact);

function load(path: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

describe.skipIf(!ready)("sign.ts vs ExecutionGuard on anvil", () => {
  const port = 18_545 + Math.floor(Math.random() * 1000);
  const rpc = `http://127.0.0.1:${port}`;
  const [owner, executor, rogue] = ANVIL_KEYS.map((k) => privateKeyToAccount(k)) as [
    ReturnType<typeof privateKeyToAccount>,
    ReturnType<typeof privateKeyToAccount>,
    ReturnType<typeof privateKeyToAccount>,
  ];
  const agent: Address = "0x00000000000000000000000000000000000a6e17";
  const guardC = load(guardArtifact);
  const poolC = load(poolArtifact);
  const state = parsePoolStateJson(readFileSync(join(root, "packages/core/fixtures/pool_state.json"), "utf8"));
  let anvil: ChildProcess | undefined;
  let pub: PublicClient;
  let wallet: WalletClient;
  let guard: Address;
  let pool: Address;

  const deploy = async (c: { abi: Abi; bytecode: Hex }, args: readonly unknown[]) => {
    const hash = await wallet.deployContract({ abi: c.abi, bytecode: c.bytecode, args, account: owner, chain: foundry });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error("deploy failed");
    return r.contractAddress;
  };

  beforeAll(async () => {
    anvil = spawn(anvilBin!, ["--port", String(port), "--silent"], { stdio: "ignore" });
    pub = createPublicClient({ chain: foundry, transport: http(rpc) }) as PublicClient;
    wallet = createWalletClient({ chain: foundry, transport: http(rpc) });
    for (let i = 0; ; i++) {
      try {
        await pub.getChainId();
        break;
      } catch (err) {
        if (i > 100) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    guard = await deploy(guardC, [owner.address]);
    pool = await deploy(poolC, [state.sqrtPriceX96, "0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"]);
    const hash = await wallet.writeContract({
      address: guard,
      abi: guardC.abi,
      functionName: "addAttestor",
      args: [owner.address],
      account: owner,
      chain: foundry,
    });
    await pub.waitForTransactionReceipt({ hash });
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  const domain = () => ({ chainId: foundry.id, verifyingContract: guard });
  const read = (functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address: guard, abi: guardC.abi, functionName, args });

  async function quoteFor(amountIn: bigint): Promise<Quote> {
    const block = await pub.getBlock();
    const v = evaluate({ state, zeroForOne: false, amountIn, fair: null });
    return buildQuote({
      agent,
      executor: executor.address,
      pool,
      zeroForOne: false,
      amountIn,
      expectedImpactBps: v.metrics.impactBps!,
      // Fixture has no CEX reference; the guard only checks signature/policy here, so DEX spot stands in.
      fairSqrtPriceX96: state.sqrtPriceX96,
      issuedAt: block.timestamp,
      ttlSeconds: 60,
    });
  }

  it("QUOTE_TYPEHASH and EIP-712 domain match the contract", async () => {
    expect(await read("QUOTE_TYPEHASH")).toBe(QUOTE_TYPEHASH);
    const d = (await read("eip712Domain")) as readonly [Hex, string, string, bigint, Address, Hex, bigint[]];
    expect(d[1]).toBe("Preflight ExecutionGuard");
    expect(d[2]).toBe("1");
    expect(d[3]).toBe(BigInt(foundry.id));
    expect(d[4].toLowerCase()).toBe(guard.toLowerCase());
  });

  it("hashQuote digest equals ExecutionGuard.hashQuote", async () => {
    const q = await quoteFor(50n * 10n ** 6n);
    expect(await read("hashQuote", [q])).toBe(hashQuote(domain(), q));
  });

  it("a signed quote passes verify() on-chain and consumes the nonce", async () => {
    const q = await quoteFor(50n * 10n ** 6n);
    expect(q.expectedImpactBps).toBe(simulateSwap(state, false, q.amountIn).impactBpsCeil);
    const sig = await signQuote(owner, domain(), q);
    const hash = await wallet.writeContract({
      address: guard,
      abi: guardC.abi,
      functionName: "verify",
      args: [q, sig],
      account: executor,
      chain: foundry,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    const decoded = decodeEventLog({ abi: guardC.abi, ...receipt.logs[0]! });
    const ev = { eventName: decoded.eventName, args: decoded.args as unknown as { digest: Hex; attestor: Address } };
    expect(ev.eventName).toBe("QuoteVerified");
    expect(ev.args.digest).toBe(hashQuote(domain(), q));
    expect(ev.args.attestor).toBe(owner.address);
    expect(await read("nonceUsed", [agent, q.nonce])).toBe(true);
  });

  it("a signature from a non-attestor key is rejected", async () => {
    const q = await quoteFor(50n * 10n ** 6n);
    const sig = await signQuote(rogue, domain(), q);
    await expect(
      pub.simulateContract({ address: guard, abi: guardC.abi, functionName: "verify", args: [q, sig], account: executor }),
    ).rejects.toThrow(/NotAttestor/);
  });

  it("random 256-bit nonces", () => {
    const a = randomNonce();
    expect(a).not.toBe(randomNonce());
    expect(a < 2n ** 256n).toBe(true);
  });
});
