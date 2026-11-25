// HSK testnet (chain 133) backup demo. HSKSwap is not deployed on testnet, so this deploys a TEST Uniswap V3 pool
// (official v3-core UniswapV3Factory + swap-router-contracts SwapRouter02 bytecode, two worthless test tokens),
// then ExecutionGuard + GuardedRouter, and runs one guarded swap that succeeds and one that reverts after a
// front-run. Quotes are built and signed with the same @preflight/core code the web/API uses; the fair price is
// the pool spot at quote time (no CEX on testnet).
//
// Usage (from apps/agent, after `forge build` in contracts/ and `npm pack @uniswap/v3-core@1.0.1
// @uniswap/swap-router-contracts@1.3.1` unpacked somewhere):
//   DEPLOYER_PRIVATE_KEY=0x.. ATTESTOR_PRIVATE_KEY=0x.. UNISWAP_V3_FACTORY_JSON=.. SWAP_ROUTER02_JSON=.. \
//   pnpm exec tsx scripts/testnet-demo.ts
// Progress is saved to STATE_FILE (default ./.testnet-demo.json) so a failed run resumes instead of redeploying.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildQuote,
  decodePreflightError,
  ERC20_ABI,
  fetchPoolState,
  reasonHashOf,
  ROUTER_ABI,
  signQuote,
  simulateSwap,
} from "@preflight/core";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.HSK_TESTNET_RPC_URL ?? "https://testnet.hsk.xyz";
const CHAIN_ID = 133;
const STATE_FILE = process.env.STATE_FILE ?? ".testnet-demo.json";
const FEE = 3000;
const FULL_RANGE = 887220; // max tick for spacing 60
const LIQUIDITY = parseEther("10000"); // ~10k of each token at price 1
const SWAP_IN = parseEther("10");
const FRONT_RUN_IN = parseEther("250");

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const chain = defineChain({
  id: CHAIN_ID,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const deployer = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex);
const attestor = privateKeyToAccount(env("ATTESTOR_PRIVATE_KEY") as Hex);
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC, { timeout: 60_000 }) });

type State = Record<string, string>;
const state: State = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : {};
const save = () => writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

function hardhatArtifact(path: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: Hex };
  return { abi: j.abi, bytecode: j.bytecode };
}

function forgeArtifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const p = fileURLToPath(new URL(`../../../contracts/out/${file}/${name}.json`, import.meta.url));
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function confirm(hash: Hex, label: string): Promise<void> {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}: ${hash}`);
}

async function deploy(key: string, art: { abi: Abi; bytecode: Hex }, args: readonly unknown[]): Promise<Address> {
  if (state[key]) return state[key] as Address;
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${key} failed: ${hash}`);
  state[key] = r.contractAddress;
  state[`${key}Tx`] = hash;
  save();
  console.log(`${key}: ${r.contractAddress} (tx ${hash})`);
  return r.contractAddress;
}

async function step(key: string, send: () => Promise<Hex>): Promise<void> {
  if (state[key]) return;
  const hash = await send();
  await confirm(hash, key);
  state[key] = hash;
  save();
}

const FACTORY_ABI = parseAbi([
  "function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)",
  "function getPool(address, address, uint24) view returns (address)",
]);
const POOL_ABI = parseAbi([
  "function initialize(uint160 sqrtPriceX96)",
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
const GUARD_ABI_ADMIN = parseAbi(["function addAttestor(address)", "function isAttestor(address) view returns (bool)"]);
const HELPER_ABI = parseAbi(["function addLiquidity(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity)"]);
const SWAP_ROUTER02_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)",
]);

async function signedQuote(guard: Address, router: Address, pool: Address, zeroForOne: boolean) {
  // Pin reads to a fresh block: viem caches getBlockNumber, which can predate txs mined seconds ago.
  const block = await pub.getBlock();
  const poolState = await fetchPoolState(pub, { pool, blockNumber: block.number });
  const sim = simulateSwap(poolState, zeroForOne, SWAP_IN);
  if (sim.status !== "OK") throw new Error(`simulation ${sim.status}`);
  const quote = buildQuote({
    agent: deployer.address,
    executor: router,
    pool,
    zeroForOne,
    amountIn: SWAP_IN,
    expectedImpactBps: sim.impactBpsCeil,
    fairSqrtPriceX96: poolState.sqrtPriceX96, // testnet: no CEX reference, fair = pool spot at quote time
    issuedAt: block.timestamp,
    ttlSeconds: 120,
  });
  const signature = await signQuote(attestor, { chainId: CHAIN_ID, verifyingContract: guard }, quote);
  return { quote, signature, sim };
}

async function main(): Promise<void> {
  if ((await pub.getChainId()) !== CHAIN_ID) throw new Error(`refusing to run: ${RPC} is not chain ${CHAIN_ID}`);
  console.log(`deployer ${deployer.address}, attestor ${attestor.address}`);

  const tok = forgeArtifact("TestnetKit.sol", "TestToken");
  const supply = parseEther("1000000");
  const tA = await deploy("tokenWHSK", tok, ["Preflight Test WHSK", "tWHSK", supply, deployer.address]);
  const tB = await deploy("tokenUSDT", tok, ["Preflight Test USDT", "tUSDT", supply, deployer.address]);

  const factory = await deploy("uniV3Factory", hardhatArtifact(env("UNISWAP_V3_FACTORY_JSON")), []);
  const zero = "0x0000000000000000000000000000000000000000";
  const swapRouter = await deploy("swapRouter02", hardhatArtifact(env("SWAP_ROUTER02_JSON")), [zero, factory, zero, zero]);

  await step("createPoolTx", () =>
    wallet.writeContract({ address: factory, abi: FACTORY_ABI, functionName: "createPool", args: [tA, tB, FEE] }),
  );
  const pool = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "getPool", args: [tA, tB, FEE] });
  state.pool = pool;
  save();
  await step("initializeTx", () =>
    wallet.writeContract({ address: pool, abi: POOL_ABI, functionName: "initialize", args: [1n << 96n] }),
  );

  const helper = await deploy("liquidityHelper", forgeArtifact("TestnetKit.sol", "V3LiquidityHelper"), []);
  await step("approveHelperWHSK", () =>
    wallet.writeContract({ address: tA, abi: ERC20_ABI, functionName: "approve", args: [helper, supply] }),
  );
  await step("approveHelperUSDT", () =>
    wallet.writeContract({ address: tB, abi: ERC20_ABI, functionName: "approve", args: [helper, supply] }),
  );
  await step("addLiquidityTx", () =>
    wallet.writeContract({
      address: helper,
      abi: HELPER_ABI,
      functionName: "addLiquidity",
      args: [pool, -FULL_RANGE, FULL_RANGE, LIQUIDITY],
    }),
  );

  const guard = await deploy("executionGuard", forgeArtifact("ExecutionGuard.sol", "ExecutionGuard"), [deployer.address]);
  await step("addAttestorTx", () =>
    wallet.writeContract({ address: guard, abi: GUARD_ABI_ADMIN, functionName: "addAttestor", args: [attestor.address] }),
  );
  const router = await deploy("guardedRouter", forgeArtifact("GuardedRouter.sol", "GuardedRouter"), [
    guard,
    swapRouter,
    factory,
  ]);

  // Agent buys tWHSK with tUSDT, like a USDT -> WHSK order on mainnet.
  const token0 = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" });
  const tokenIn = tB;
  const zeroForOne = token0.toLowerCase() === tokenIn.toLowerCase();
  await step("approveGuardedRouter", () =>
    wallet.writeContract({ address: tokenIn, abi: ERC20_ABI, functionName: "approve", args: [router, supply] }),
  );

  // 1) Successful guarded swap.
  if (!state.successTx) {
    const { quote, signature, sim } = await signedQuote(guard, router, pool, zeroForOne);
    console.log(`success quote: expectedImpactBps=${quote.expectedImpactBps} simOut=${sim.amountOut}`);
    const reasonHash = reasonHashOf("testnet demo: small order, quoted impact within policy");
    await step("successTx", () =>
      wallet.writeContract({
        address: router,
        abi: ROUTER_ABI,
        functionName: "guardedSwap",
        args: [quote, signature, 0n, reasonHash],
      }),
    );
  }

  // 2) Quote signed, then a front-run moves the pool past maxDevBps before the agent's tx lands.
  if (!state.revertTx) {
    const { quote, signature } = await signedQuote(guard, router, pool, zeroForOne);
    await step("approveSwapRouter02", () =>
      wallet.writeContract({ address: tokenIn, abi: ERC20_ABI, functionName: "approve", args: [swapRouter, supply] }),
    );
    const tokenOut = tokenIn === tA ? tB : tA;
    await step("frontRunTx", () =>
      wallet.writeContract({
        address: swapRouter,
        abi: SWAP_ROUTER02_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            fee: FEE,
            recipient: deployer.address,
            amountIn: FRONT_RUN_IN,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    );
    const reasonHash = reasonHashOf("testnet demo: quote signed before a front-run");
    const args = [quote, signature, 0n, reasonHash] as const;
    try {
      await pub.simulateContract({ address: router, abi: ROUTER_ABI, functionName: "guardedSwap", args, account: deployer });
      throw new Error("expected guardedSwap to revert after the front-run, but simulation passed");
    } catch (err) {
      const decoded = decodePreflightError(err);
      if (!decoded) throw err;
      state.revertError = `${decoded.name}(${decoded.args.map(String).join(", ")})`;
      console.log(`expected revert: ${state.revertError}`);
    }
    // Explicit gas skips estimation so the failing tx is actually mined and visible on the explorer.
    const hash = await wallet.writeContract({
      address: router,
      abi: ROUTER_ABI,
      functionName: "guardedSwap",
      args,
      gas: 400_000n,
    });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "reverted") throw new Error(`expected a reverted tx, got ${r.status}: ${hash}`);
    state.revertTx = hash;
    save();
    console.log(`revertTx (reverted as expected): ${hash}`);
  }

  const balance = await pub.getBalance({ address: deployer.address });
  console.log(`done. deployer balance ${balance} wei`);
  console.log(JSON.stringify(state, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
