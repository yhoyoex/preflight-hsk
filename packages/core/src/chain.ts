// On-chain helpers shared by the MCP server and the agent: ABIs, unsigned tx builders, eth_call checks, error decoding.
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { Quote } from "./sign.ts";
import type { Policy } from "./verdict.ts";

export const WHSK: Address = "0xB210D2120d57b758EE163cFfb43e73728c471Cf1";
export const USDT: Address = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029";
export const SWAP_ROUTER02: Address = "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3";
export const V3_FACTORY: Address = "0x972cA9D1662F5e029cD18327D29026532E84c742";

const QUOTE_TUPLE =
  "(address agent, address executor, address pool, bool zeroForOne, uint256 amountIn, uint32 expectedImpactBps, " +
  "uint160 fairSqrtPriceX96, uint64 issuedAt, uint64 expiry, uint256 nonce)";

/** Custom errors of ExecutionGuard + GuardedRouter (+ GuardConsumer); guard reverts bubble through the router. */
export const PREFLIGHT_ERRORS_ABI = parseAbi([
  "error NotAttestor(address signer)",
  "error WrongExecutor(address expected, address caller)",
  "error QuoteExpired(uint64 expiry, uint256 nowTs)",
  "error QuoteFromFuture(uint64 issuedAt, uint256 nowTs)",
  "error QuoteStale(uint256 age, uint64 maxAge)",
  "error NonceUsed(address agent, uint256 nonce)",
  "error ImpactTooHigh(uint256 impactBps, uint32 maxImpactBps)",
  "error DeviationTooHigh(uint256 devBps, uint32 maxDevBps)",
  "error InvalidPolicy()",
  "error ZeroAddress()",
  "error RenounceDisabled()",
  "error NotAgent(address agent, address caller)",
  "error UnknownPool(address pool)",
  "error ActualImpactTooHigh(uint256 impactBps, uint32 maxImpactBps)",
  "error PostSwapDeviationTooHigh(uint256 devBps, uint32 maxDevBps)",
  "error BelowFairFloor(uint256 amountOut, uint256 floor)",
  "error NoSlippageProtection()",
  "error FactoryMismatch(address routerFactory, address factory)",
  "error QuoteNotForThisAgent(address agent)",
  "error GuardZeroAddress()",
]);

export const GUARD_ABI = [
  ...parseAbi([
    `function verify(${QUOTE_TUPLE} q, bytes sig) returns ((uint32 maxImpactBps, uint32 maxDevBps, uint64 maxAge))`,
    "function policyOf(address agent) view returns ((uint32 maxImpactBps, uint32 maxDevBps, uint64 maxAge))",
    "function isAttestor(address) view returns (bool)",
    "function nonceUsed(address, uint256) view returns (bool)",
  ]),
  ...PREFLIGHT_ERRORS_ABI,
] as const;

export const ROUTER_ABI = [
  ...parseAbi([
    `function guardedSwap(${QUOTE_TUPLE} q, bytes sig, uint256 amountOutMin, bytes32 reasonHash) returns (uint256 amountOut)`,
    "function guard() view returns (address)",
    "event GuardedSwap(address indexed agent, address indexed pool, uint256 amountIn, uint256 amountOut, uint256 impactBps, uint256 devBps, bytes32 reasonHash)",
  ]),
  ...PREFLIGHT_ERRORS_ABI,
] as const;

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export function tokenInOf(zeroForOne: boolean): Address {
  return zeroForOne ? WHSK : USDT;
}

/** reasonHash committed on-chain; the plain-text reason stays off-chain (agent JSONL log). */
export function reasonHashOf(reason: string): Hex {
  return keccak256(stringToHex(reason));
}

export interface UnsignedTx {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  description: string;
}

export interface GuardedSwapParams {
  router: Address;
  quote: Quote;
  signature: Hex;
  /** Caller minimum; the router additionally enforces the fair floor. */
  amountOutMin: bigint;
  reasonHash: Hex;
}

/** approve(tokenIn → router, amountIn) + guardedSwap, both sent by quote.agent. */
export function buildGuardedSwapTxs(p: GuardedSwapParams): { approve: UnsignedTx; swap: UnsignedTx } {
  const tokenIn = tokenInOf(p.quote.zeroForOne);
  return {
    approve: {
      from: p.quote.agent,
      to: tokenIn,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [p.router, p.quote.amountIn] }),
      value: 0n,
      description: `approve ${p.quote.zeroForOne ? "WHSK" : "USDT"} ${p.quote.amountIn} → GuardedRouter`,
    },
    swap: {
      from: p.quote.agent,
      to: p.router,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "guardedSwap",
        args: [p.quote, p.signature, p.amountOutMin, p.reasonHash],
      }),
      value: 0n,
      description: "GuardedRouter.guardedSwap(quote, sig, amountOutMin, reasonHash)",
    },
  };
}

export interface DecodedRevert {
  name: string;
  args: readonly unknown[];
}

function revertData(err: unknown): Hex | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 10 && typeof cur === "object" && cur !== null; i++) {
    const data = (cur as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) return data as Hex;
    if (typeof data === "object" && data !== null) {
      const inner = (data as { data?: unknown }).data;
      if (typeof inner === "string" && inner.startsWith("0x") && inner.length >= 10) return inner as Hex;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Decodes a Preflight custom error from a viem error (simulate/estimate/call); null if it is something else. */
export function decodePreflightError(err: unknown): DecodedRevert | null {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      return { name: reverted.data.errorName, args: reverted.data.args ?? [] };
    }
  }
  const data = revertData(err);
  if (!data) return null;
  try {
    const d = decodeErrorResult({ abi: PREFLIGHT_ERRORS_ABI, data });
    return { name: d.errorName, args: d.args ?? [] };
  } catch {
    return null;
  }
}

export type CheckResult =
  | { ok: true; policy: Policy }
  | { ok: false; error: DecodedRevert | null; message: string };

/**
 * eth_call ExecutionGuard.verify(quote, sig) from quote.executor: the exact on-chain checks (attestor, executor,
 * expiry/age, nonce, impact vs policy, spot deviation) without sending a transaction.
 */
export async function checkQuoteOnChain(
  client: PublicClient,
  guard: Address,
  quote: Quote,
  signature: Hex,
): Promise<CheckResult> {
  try {
    const { result } = await client.simulateContract({
      address: guard,
      abi: GUARD_ABI,
      functionName: "verify",
      args: [quote, signature],
      account: quote.executor,
    });
    return { ok: true, policy: { maxImpactBps: result.maxImpactBps, maxDevBps: result.maxDevBps, maxAge: Number(result.maxAge) } };
  } catch (err) {
    const error = decodePreflightError(err);
    return { ok: false, error, message: error ? `${error.name}(${error.args.map(String).join(", ")})` : shortMessage(err) };
  }
}

export function shortMessage(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

export interface GuardedSwapEvent {
  agent: Address;
  pool: Address;
  amountIn: bigint;
  amountOut: bigint;
  impactBps: bigint;
  devBps: bigint;
  reasonHash: Hex;
}

export type SendResult =
  | { status: "success"; approveHash: Hex | null; hash: Hex; event: GuardedSwapEvent }
  /** Pre-flight simulation reverted; nothing was sent unless `forceSend`. */
  | { status: "rejected"; approveHash: Hex | null; error: DecodedRevert | null; message: string }
  /** Sent anyway (forceSend) and mined as reverted. */
  | { status: "reverted"; approveHash: Hex | null; hash: Hex; error: DecodedRevert | null; message: string };

export interface SendOptions {
  /** Send even when simulation reverts (fixed gas), to get a mined revert (demo/e2e). */
  forceSend?: boolean;
  gas?: bigint;
  /** Max wait per receipt (approve and swap); default DEFAULT_RECEIPT_TIMEOUT_MS. */
  receiptTimeoutMs?: number;
}

export const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;

export class PendingTxError extends Error {
  constructor(
    readonly address: Address,
    readonly latestNonce: number,
    readonly pendingNonce: number,
  ) {
    super(
      `${address} has ${pendingNonce - latestNonce} pending tx (nonce latest=${latestNonce}, pending=${pendingNonce}); ` +
        "not sending until it is mined or replaced",
    );
    this.name = "PendingTxError";
  }
}

/** Refuses to send while the account has unmined txs (a stuck tx would make a new one queue behind it). */
export async function assertNoPendingTx(client: PublicClient, address: Address): Promise<void> {
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address, blockTag: "latest" }),
    client.getTransactionCount({ address, blockTag: "pending" }),
  ]);
  if (pending > latest) throw new PendingTxError(address, latest, pending);
}

async function waitReceipt(client: PublicClient, hash: Hex, what: string, timeoutMs: number) {
  try {
    return await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  } catch (err) {
    throw new Error(`${what} ${hash}: no receipt within ${Math.round(timeoutMs / 1000)} s (${shortMessage(err)})`);
  }
}

/**
 * Sets the allowance of `spender` to `amount`. If the token rejects approve while a non-zero allowance exists
 * (USDT-style), resets it to 0 first (OpenZeppelin forceApprove). HSK USDT accepts non-zero → non-zero (checked on a
 * fork of block 30609500), so the reset path only runs for tokens that need it.
 */
export async function forceApprove(
  client: PublicClient,
  wallet: WalletClient<Transport, Chain, Account>,
  token: Address,
  spender: Address,
  amount: bigint,
  current: bigint,
  timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
): Promise<Hex> {
  const account = wallet.account;
  const send = async (value: bigint) => {
    const hash = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [spender, value] });
    const r = await waitReceipt(client, hash, `approve(${value})`, timeoutMs);
    if (r.status !== "success") throw new Error(`approve(${value}) reverted: ${hash}`);
    return hash;
  };
  try {
    await client.simulateContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [spender, amount], account });
  } catch (err) {
    if (current === 0n) throw err;
    await send(0n);
  }
  return send(amount);
}

/**
 * Decodes why a mined guardedSwap reverted (e.g. it was front-run after passing simulation) by replaying it with
 * eth_call on the state at the end of its block; the reverted tx changed no state, so the same check fails again.
 */
async function replayRevert(
  client: PublicClient,
  from: Address,
  p: GuardedSwapParams,
  blockNumber: bigint,
): Promise<{ error: DecodedRevert | null; message: string }> {
  try {
    await client.simulateContract({
      address: p.router,
      abi: ROUTER_ABI,
      functionName: "guardedSwap",
      args: [p.quote, p.signature, p.amountOutMin, p.reasonHash],
      account: from,
      blockNumber,
    });
  } catch (err) {
    const error = decodePreflightError(err);
    if (error) return { error, message: `${error.name}(${error.args.map(String).join(", ")})` };
  }
  return { error: null, message: "reverted" };
}

/** Approves (if needed) and sends guardedSwap from the agent wallet; simulates first and decodes custom errors. */
export async function sendGuardedSwap(
  client: PublicClient,
  wallet: WalletClient<Transport, Chain, Account>,
  p: GuardedSwapParams,
  opts: SendOptions = {},
): Promise<SendResult> {
  const account = wallet.account;
  if (account.address.toLowerCase() !== p.quote.agent.toLowerCase()) {
    throw new Error(`wallet ${account.address} is not quote.agent ${p.quote.agent}`);
  }
  const timeoutMs = opts.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  await assertNoPendingTx(client, account.address);
  const tokenIn = tokenInOf(p.quote.zeroForOne);
  let approveHash: Hex | null = null;
  const allowance = await client.readContract({
    address: tokenIn,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, p.router],
  });
  if (allowance < p.quote.amountIn) {
    approveHash = await forceApprove(client, wallet, tokenIn, p.router, p.quote.amountIn, allowance, timeoutMs);
  }

  const args = [p.quote, p.signature, p.amountOutMin, p.reasonHash] as const;
  let simError: { error: DecodedRevert | null; message: string } | null = null;
  try {
    await client.simulateContract({ address: p.router, abi: ROUTER_ABI, functionName: "guardedSwap", args, account });
  } catch (err) {
    const error = decodePreflightError(err);
    simError = { error, message: error ? `${error.name}(${error.args.map(String).join(", ")})` : shortMessage(err) };
    if (!opts.forceSend) return { status: "rejected", approveHash, ...simError };
  }

  const hash = await wallet.writeContract({
    address: p.router,
    abi: ROUTER_ABI,
    functionName: "guardedSwap",
    args,
    ...(opts.gas !== undefined || simError ? { gas: opts.gas ?? 1_500_000n } : {}),
  });
  const receipt = await waitReceipt(client, hash, "guardedSwap", timeoutMs);
  if (receipt.status !== "success") {
    return { status: "reverted", approveHash, hash, ...(simError ?? (await replayRevert(client, account.address, p, receipt.blockNumber))) };
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== p.router.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: ROUTER_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === "GuardedSwap") return { status: "success", approveHash, hash, event: ev.args };
    } catch {
      // not a router event
    }
  }
  throw new Error(`guardedSwap ${hash} succeeded without a GuardedSwap event`);
}
