// CLI: pnpm --filter @preflight/agent start [--dry-run | --live] [--once] [--interval <sec>]
//      pnpm --filter @preflight/agent start --scenario revert [--rpc http://127.0.0.1:8545]   (anvil fork only)
// Dry-run is the default; --live needs AGENT_PRIVATE_KEY. Reasons are appended to AGENT_LOG (JSONL).
import { fetchKlines, fetchPoolState, HSK_CHAIN_ID, httpQuoteClient, shortMessage } from "@preflight/core";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_MAX_CONSECUTIVE_FAILURES, runLoop, type AgentDeps } from "./agent.ts";
import { proposerFromEnv } from "./llm.ts";
import { runRevertScenario } from "./scenario.ts";

function requireAddress(name: string): Address {
  const v = process.env[name]?.trim();
  if (!v || !isAddress(v)) throw new Error(`${name} is missing or not an address`);
  return getAddress(v);
}

export function depsFromEnv(live: boolean): AgentDeps {
  const rpcUrl = process.env.HSK_RPC_URL?.trim() || "https://mainnet.hsk.xyz";
  const chain = defineChain({
    id: Number(process.env.HSK_CHAIN_ID ?? HSK_CHAIN_ID),
    name: "HashKey Chain",
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) }) as PublicClient;
  const key = process.env.AGENT_PRIVATE_KEY?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY is not a 32-byte 0x-hex key");
  if (live && !key) throw new Error("--live requires AGENT_PRIVATE_KEY");
  const account = key ? privateKeyToAccount(key as `0x${string}`) : undefined;
  const capital = Number(process.env.AGENT_CAPITAL_USD ?? 100);
  if (!Number.isFinite(capital) || capital <= 0) throw new Error("AGENT_CAPITAL_USD must be a positive number");
  return {
    agent: account?.address ?? requireAddress("AGENT_ADDRESS"),
    router: requireAddress("ROUTER_ADDRESS"),
    client,
    quotes: httpQuoteClient(process.env.PREFLIGHT_API_URL?.trim() || "http://localhost:3000"),
    proposer: proposerFromEnv(),
    klines: () => fetchKlines(),
    poolState: () => fetchPoolState(client, { tries: 3, initialDelayMs: 300 }),
    capitalUsd: capital,
    wallet: live && account ? createWalletClient({ account, chain, transport: http(rpcUrl) }) : undefined,
    live,
    logPath: process.env.AGENT_LOG?.trim() || "agent-reasons.jsonl",
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      interval: { type: "string", default: "60" },
      scenario: { type: "string" },
      rpc: { type: "string" },
    },
  });
  if (values.scenario !== undefined) {
    if (values.scenario !== "revert") throw new Error(`unknown --scenario ${values.scenario} (available: revert)`);
    // Local anvil fork only (connectFork refuses other nodes); uses public anvil dev keys, never AGENT_PRIVATE_KEY.
    const rpc = values.rpc ?? process.env.ANVIL_RPC_URL?.trim() ?? "http://127.0.0.1:8545";
    const r = await runRevertScenario({ rpc, log: (l) => console.error(`[scenario] ${l}`) });
    console.log(
      JSON.stringify({
        scenario: "revert",
        block: r.block.toString(),
        order: r.order,
        botTx: r.botTx,
        agentTx: r.agent.txHash,
        agentAction: r.agent.action,
        error: r.agent.error,
        spotMoveBps: Number(((r.spotAfter * r.spotAfter - r.spotBefore * r.spotBefore) * 10_000n) / (r.spotBefore * r.spotBefore)),
      }),
    );
    return;
  }
  if (values.live && values["dry-run"]) throw new Error("choose either --live or --dry-run");
  const intervalMs = Number(values.interval) * 1000;
  if (!Number.isFinite(intervalMs) || intervalMs < 5_000) throw new Error("--interval must be >= 5 seconds");
  const maxFailures = Number(process.env.AGENT_MAX_CONSECUTIVE_FAILURES ?? DEFAULT_MAX_CONSECUTIVE_FAILURES);
  if (!Number.isInteger(maxFailures) || maxFailures < 1) throw new Error("AGENT_MAX_CONSECUTIVE_FAILURES must be an integer >= 1");
  const deps = depsFromEnv(values.live);
  console.error(
    `preflight agent ${deps.agent} mode=${deps.live ? "live" : "dry-run"} capital=$${deps.capitalUsd} ` +
      `maxConsecutiveFailures=${maxFailures} log=${deps.logPath}`,
  );
  const exit = await runLoop(deps, {
    once: values.once,
    intervalMs,
    maxConsecutiveFailures: maxFailures,
    onRecord: (r) => console.log(JSON.stringify(r)),
    log: (l) => console.error(`[agent] ${l}`),
  });
  if (exit.reason === "circuit-breaker") process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("agent failed:", shortMessage(err));
    process.exit(1);
  });
}
