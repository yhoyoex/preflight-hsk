// Preflight MCP server (stdio). Logs go to stderr only: stdout carries JSON-RPC.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HSK_CHAIN_ID, httpQuoteClient, shortMessage } from "@preflight/core";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_MAX_USD,
  guardCheck,
  guardCheckInput,
  guardedSwap,
  guardedSwapInput,
  guardQuote,
  guardQuoteInput,
  type ToolDeps,
  type ToolResult,
} from "./tools.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

function envAddress(name: string): `0x${string}` {
  const v = process.env[name]?.trim();
  if (!v) return ZERO;
  if (!isAddress(v)) throw new Error(`${name} is not an address`);
  return getAddress(v);
}

export function depsFromEnv(): ToolDeps {
  const rpcUrl = process.env.HSK_RPC_URL?.trim() || "https://mainnet.hsk.xyz";
  const chainId = Number(process.env.HSK_CHAIN_ID ?? HSK_CHAIN_ID);
  const chain = defineChain({
    id: chainId,
    name: "HashKey Chain",
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) }) as PublicClient;
  const key = process.env.AGENT_PRIVATE_KEY?.trim();
  const execute = process.env.PREFLIGHT_EXECUTE === "1";
  let wallet: ToolDeps["wallet"];
  if (key && execute) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY is not a 32-byte 0x-hex key");
    wallet = createWalletClient({ account: privateKeyToAccount(key as `0x${string}`), chain, transport: http(rpcUrl) });
  }
  const maxUsd = Number(process.env.PREFLIGHT_MAX_USD ?? DEFAULT_MAX_USD);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("PREFLIGHT_MAX_USD must be a positive number");
  return {
    maxUsd,
    quotes: httpQuoteClient(process.env.PREFLIGHT_API_URL?.trim() || "http://localhost:3000"),
    client,
    guard: envAddress("GUARD_ADDRESS"),
    router: envAddress("ROUTER_ADDRESS"),
    wallet,
  };
}

async function safe(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return { content: [{ type: "text", text: `error: ${shortMessage(err)}` }], isError: true };
  }
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "preflight", version: "0.1.0" });
  server.registerTool(
    "guard_quote",
    {
      title: "Preflight quote",
      description:
        "Simulate a WHSK/USDT swap on HashKey Chain: price impact, CEX deviation, total cost and a verdict " +
        "(DEX, CEX, TUNDA, KECILKAN, NO_REFERENCE, OUT_OF_RANGE). Returns a signed quote only for executable DEX verdicts.",
      inputSchema: guardQuoteInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => safe(() => guardQuote(deps, a)),
  );
  server.registerTool(
    "guard_check",
    {
      title: "Check quote on-chain",
      description:
        "eth_call ExecutionGuard.verify(quote, signature) from quote.executor against the agent's on-chain policy. " +
        "No transaction is sent; returns pass/fail with the decoded custom error.",
      inputSchema: guardCheckInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => safe(() => guardCheck(deps, a)),
  );
  server.registerTool(
    "guarded_swap",
    {
      title: "Guarded swap",
      description:
        "Quote + build unsigned approve and GuardedRouter.guardedSwap txs (reasonHash = keccak256(reason)). " +
        "Sends them only when the server runs with AGENT_PRIVATE_KEY and PREFLIGHT_EXECUTE=1; the contract reverts if limits are exceeded.",
      inputSchema: guardedSwapInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (a) => safe(() => guardedSwap(deps, a)),
  );
  return server;
}

export async function main(): Promise<void> {
  try {
    const deps = depsFromEnv();
    await createServer(deps).connect(new StdioServerTransport());
    console.error(`preflight-mcp ready (execute: ${deps.wallet ? "on" : "off"}, max notional $${deps.maxUsd})`);
  } catch (err) {
    console.error("preflight-mcp failed:", shortMessage(err));
    process.exit(1);
  }
}
