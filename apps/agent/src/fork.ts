// Local anvil-fork harness for demos and e2e: deploys Preflight from contracts/out, funds accounts from the pool,
// and controls mining. Refuses to run against anything that is not anvil, so it can never touch mainnet.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ERC20_ABI,
  fetchPoolState,
  med5,
  priceE18ToSqrtX96,
  SWAP_ROUTER02,
  USDT,
  V3_FACTORY,
  WHSK,
  WHSK_USDT_POOL,
  type FairPrice,
  type Kline,
} from "@preflight/core";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { priceOf, spFromX96 } from "./strategy.ts";

/** Public anvil dev keys (not secrets): #0 deployer/owner/attestor, #1 agent, #2 front-running bot. */
export const ANVIL_KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  agent: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bot: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const satisfies Record<string, Hex>;

export type Wallet = WalletClient<Transport, Chain, Account>;

const artifactPath = (name: string) =>
  fileURLToPath(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url));

export const artifactsBuilt = () => existsSync(artifactPath("ExecutionGuard")) && existsSync(artifactPath("GuardedRouter"));

function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  if (!existsSync(artifactPath(name))) throw new Error(`${name} artifact missing; run \`forge build\` in contracts/`);
  const j = JSON.parse(readFileSync(artifactPath(name), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export interface Fork {
  rpc: string;
  chain: Chain;
  pub: PublicClient;
  wallet: (key: Hex) => Wallet;
}

/** Connects to a local anvil fork of HashKey Chain; throws for any other node (e.g. a real RPC). */
export async function connectFork(rpc: string): Promise<Fork> {
  const probe = createPublicClient({ transport: http(rpc, { timeout: 60_000, retryCount: 0 }) });
  const client = await probe.request({ method: "web3_clientVersion" as never }).catch(() => "");
  if (typeof client !== "string" || !client.toLowerCase().startsWith("anvil")) {
    throw new Error(`refusing to run: ${rpc} is not an anvil node`);
  }
  const chain = defineChain({
    id: await probe.getChainId(),
    name: "HSK fork",
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 60_000 }), pollingInterval: 200 }) as PublicClient;
  if ((await pub.getCode({ address: WHSK_USDT_POOL })) === undefined) {
    throw new Error("WHSK/USDT pool not found: start anvil with --fork-url https://mainnet.hsk.xyz");
  }
  return {
    rpc,
    chain,
    pub,
    wallet: (key) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpc), pollingInterval: 200 }),
  };
}

async function mined(f: Fork, hash: Hex): Promise<void> {
  const r = await f.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`setup tx reverted: ${hash}`);
}

/** Deploys ExecutionGuard + GuardedRouter (owner = attestor = anvil #0). */
export async function deployPreflight(f: Fork): Promise<{ guard: Address; router: Address; attestor: PrivateKeyAccount }> {
  const owner = f.wallet(ANVIL_KEYS.owner);
  const deploy = async (name: string, args: readonly unknown[]) => {
    const c = loadArtifact(name);
    const hash = await owner.deployContract({ abi: c.abi, bytecode: c.bytecode, args });
    const r = await f.pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
    return r.contractAddress;
  };
  const guard = await deploy("ExecutionGuard", [owner.account.address]);
  const router = await deploy("GuardedRouter", [guard, SWAP_ROUTER02, V3_FACTORY]);
  await mined(
    f,
    await owner.writeContract({
      address: guard,
      abi: parseAbi(["function addAttestor(address)"]),
      functionName: "addAttestor",
      args: [owner.account.address],
    }),
  );
  return { guard, router, attestor: privateKeyToAccount(ANVIL_KEYS.owner) };
}

/** Gives `to` native HSK for gas (anvil_setBalance). */
export const fundGas = (f: Fork, to: Address) =>
  f.pub.request({ method: "anvil_setBalance" as never, params: [to, "0x3635C9ADC5DEA00000"] as never }); // 1000 HSK

/** Sends USDT from the pool (impersonated; V3 prices come from pool state, not token balances). */
export async function fundUsdt(f: Fork, to: Address, usdt: string): Promise<void> {
  await f.pub.request({ method: "anvil_impersonateAccount" as never, params: [WHSK_USDT_POOL] as never });
  await f.pub.request({ method: "anvil_setBalance" as never, params: [WHSK_USDT_POOL, "0xDE0B6B3A7640000"] as never });
  const pool = createWalletClient({ account: WHSK_USDT_POOL, chain: f.chain, transport: http(f.rpc) });
  await mined(
    f,
    await pool.writeContract({
      address: USDT,
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [to, parseUnits(usdt, 6)],
    }),
  );
  await f.pub.request({ method: "anvil_stopImpersonatingAccount" as never, params: [WHSK_USDT_POOL] as never });
}

export async function approveMax(f: Fork, w: Wallet, token: Address, spender: Address): Promise<void> {
  await mined(f, await w.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [spender, maxUint256] }));
}

/** CEX klines whose med5 is `premium` × the current DEX spot (premium 1.015 → DEX 150 bps cheap). */
export async function injectedCex(f: Fork, premium: number, nowMs = Date.now()): Promise<{ klines: Kline[]; fair: FairPrice }> {
  const state = await fetchPoolState(f.pub);
  const cexPrice = priceOf(spFromX96(state.sqrtPriceX96)) * premium;
  const klines = Array.from({ length: 5 }, (_, k) => ({
    openTimeMs: nowMs - (4 - k) * 60_000,
    closeE18: parseUnits(cexPrice.toFixed(12), 18),
    volume: 100,
  }));
  const ref = med5(klines, nowMs);
  if (!ref) throw new Error("injected klines produced no med5 reference");
  return { klines, fair: { ...ref, sqrtPriceX96: priceE18ToSqrtX96(ref.priceE18), source: "injected med5 (demo)" } };
}

export const setAutomine = (f: Fork, on: boolean) => f.pub.request({ method: "evm_setAutomine" as never, params: [on] as never });
export const mine = (f: Fork) => f.pub.request({ method: "evm_mine" as never, params: [] as never });

interface PendingTx {
  hash: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  gasPrice?: Hex;
}

/** Waits until `from` has a transaction in anvil's mempool (automine off) and returns it. */
export async function waitPending(f: Fork, from: Address, timeoutMs = 60_000): Promise<PendingTx> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pool = (await f.pub.request({ method: "txpool_content" as never })) as { pending: Record<string, Record<string, PendingTx>> };
    const entry = Object.entries(pool.pending).find(([addr]) => addr.toLowerCase() === from.toLowerCase());
    const tx = entry ? Object.values(entry[1])[0] : undefined;
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no pending tx from ${from} within ${timeoutMs} ms`);
}

const SWAP_ROUTER02_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);

/** Bot buys WHSK with `usdt` through SwapRouter02, tipping more than `victim` so it is ordered first. */
export async function frontRunBuy(f: Fork, bot: Wallet, usdt: string, victim: PendingTx): Promise<Hex> {
  const tip = BigInt(victim.maxPriorityFeePerGas ?? victim.gasPrice ?? "0x0");
  const maxFee = BigInt(victim.maxFeePerGas ?? victim.gasPrice ?? "0x0");
  const bump = 10n ** 9n; // +1 gwei
  return bot.writeContract({
    address: SWAP_ROUTER02,
    abi: SWAP_ROUTER02_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDT,
        tokenOut: WHSK,
        fee: 3000,
        recipient: bot.account.address,
        amountIn: parseUnits(usdt, 6),
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
    maxPriorityFeePerGas: tip * 2n + bump,
    maxFeePerGas: maxFee * 2n + bump,
    gas: 400_000n,
  });
}
