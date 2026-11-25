// EIP-712 Quote matching contracts/src/ExecutionGuard.sol (domain "Preflight ExecutionGuard" v1).
import {
  bytesToBigInt,
  hashTypedData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedDataDomain,
} from "viem";

export const GUARD_DOMAIN_NAME = "Preflight ExecutionGuard";
export const GUARD_DOMAIN_VERSION = "1";

/** Must equal ExecutionGuard.QUOTE_TYPEHASH preimage. */
export const QUOTE_TYPE_STRING =
  "Quote(address agent,address executor,address pool,bool zeroForOne,uint256 amountIn," +
  "uint32 expectedImpactBps,uint160 fairSqrtPriceX96,uint64 issuedAt,uint64 expiry,uint256 nonce)";
export const QUOTE_TYPEHASH: Hex = keccak256(stringToHex(QUOTE_TYPE_STRING));

export const QUOTE_TYPES = {
  Quote: [
    { name: "agent", type: "address" },
    { name: "executor", type: "address" },
    { name: "pool", type: "address" },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint256" },
    { name: "expectedImpactBps", type: "uint32" },
    { name: "fairSqrtPriceX96", type: "uint160" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface Quote {
  agent: Address;
  executor: Address;
  pool: Address;
  zeroForOne: boolean;
  amountIn: bigint;
  expectedImpactBps: number;
  fairSqrtPriceX96: bigint;
  issuedAt: bigint;
  expiry: bigint;
  nonce: bigint;
}

export interface GuardDomain {
  chainId: number;
  verifyingContract: Address;
}

export function guardDomain(d: GuardDomain): TypedDataDomain {
  return { name: GUARD_DOMAIN_NAME, version: GUARD_DOMAIN_VERSION, chainId: d.chainId, verifyingContract: d.verifyingContract };
}

/** Random 256-bit nonce (one-time per agent on-chain; random so it is unpredictable and collision-free). */
export function randomNonce(): bigint {
  return bytesToBigInt(crypto.getRandomValues(new Uint8Array(32)));
}

const UINT32_MAX = 2 ** 32 - 1;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT160_MAX = 2n ** 160n - 1n;

export interface BuildQuoteInput {
  agent: Address;
  executor: Address;
  pool: Address;
  zeroForOne: boolean;
  amountIn: bigint;
  /** Integer bps rounded UP (pool.ts impactBpsCeil) so an accepted quote never fails on rounding on-chain. */
  expectedImpactBps: number;
  fairSqrtPriceX96: bigint;
  /** Unix seconds. */
  issuedAt: bigint;
  ttlSeconds: number;
  nonce?: bigint;
}

export function buildQuote(input: BuildQuoteInput): Quote {
  const { expectedImpactBps: impact, ttlSeconds: ttl } = input;
  if (!Number.isInteger(impact) || impact < 0 || impact > UINT32_MAX) {
    throw new RangeError(`expectedImpactBps must be an integer in uint32 range, got ${impact}`);
  }
  if (!Number.isInteger(ttl) || ttl <= 0) throw new RangeError(`ttlSeconds must be a positive integer, got ${ttl}`);
  if (input.amountIn <= 0n) throw new RangeError("amountIn must be positive");
  if (input.fairSqrtPriceX96 <= 0n || input.fairSqrtPriceX96 > UINT160_MAX) {
    throw new RangeError("fairSqrtPriceX96 out of uint160 range");
  }
  const expiry = input.issuedAt + BigInt(ttl);
  if (input.issuedAt < 0n || expiry > UINT64_MAX) throw new RangeError("issuedAt/expiry out of uint64 range");
  return {
    agent: input.agent,
    executor: input.executor,
    pool: input.pool,
    zeroForOne: input.zeroForOne,
    amountIn: input.amountIn,
    expectedImpactBps: impact,
    fairSqrtPriceX96: input.fairSqrtPriceX96,
    issuedAt: input.issuedAt,
    expiry,
    nonce: input.nonce ?? randomNonce(),
  };
}

/** Same value as ExecutionGuard.hashQuote(q). */
export function hashQuote(domain: GuardDomain, quote: Quote): Hex {
  return hashTypedData({ domain: guardDomain(domain), types: QUOTE_TYPES, primaryType: "Quote", message: quote });
}

export function signQuote(account: LocalAccount, domain: GuardDomain, quote: Quote): Promise<Hex> {
  return account.signTypedData({ domain: guardDomain(domain), types: QUOTE_TYPES, primaryType: "Quote", message: quote });
}
