import { getAddress, isAddress, type Address, type Hex } from "viem";
import { HSK_CHAIN_ID } from "@preflight/core";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ServerConfig {
  attestorKey: Hex;
  guardAddress: Address;
  rpcUrl: string;
  chainId: number;
  quoteTtlSeconds: number;
}

let cached: ServerConfig | undefined;

/** Reads and validates server env once. Error messages name the variable, never its value. */
export function serverConfig(): ServerConfig {
  if (cached) return cached;
  const key = process.env.ATTESTOR_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new ConfigError("ATTESTOR_PRIVATE_KEY is missing or not a 32-byte 0x-hex key");
  }
  const guard = process.env.GUARD_ADDRESS?.trim();
  if (!guard || !isAddress(guard)) throw new ConfigError("GUARD_ADDRESS is missing or not an address");
  const chainId = Number(process.env.HSK_CHAIN_ID ?? HSK_CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new ConfigError("HSK_CHAIN_ID must be a positive integer");
  const ttl = Number(process.env.QUOTE_TTL_SECONDS ?? 60);
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 3600) {
    throw new ConfigError("QUOTE_TTL_SECONDS must be an integer in 1..3600");
  }
  cached = {
    attestorKey: key as Hex,
    guardAddress: getAddress(guard),
    rpcUrl: process.env.HSK_RPC_URL?.trim() || "https://mainnet.hsk.xyz",
    chainId,
    quoteTtlSeconds: ttl,
  };
  return cached;
}
