// `--scenario revert`: an honest on-chain revert on a local anvil fork. The agent gets a legitimately signed quote
// for a small buy and broadcasts guardedSwap; a bot sees it in the mempool and front-runs it with a $10k buy at a
// higher tip. Both land in the same block, the bot first: the Guard sees the spot now far above the attested fair
// price and reverts the agent's swap (DeviationTooHigh) — the agent loses only gas instead of buying the top.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuoteService, fetchPoolState, ROUTER_ABI, SWAP_ROUTER02, USDT, WHSK_USDT_POOL } from "@preflight/core";
import { parseAbi, type Hex } from "viem";
import { tick, type TickRecord } from "./agent.ts";
import {
  ANVIL_KEYS,
  approveMax,
  connectFork,
  deployPreflight,
  frontRunBuy,
  fundGas,
  fundUsdt,
  injectedCex,
  mine,
  setAutomine,
  waitPending,
} from "./fork.ts";
import { deterministicProposer } from "./llm.ts";

export interface RevertScenarioResult {
  guard: Hex;
  router: Hex;
  agent: TickRecord;
  botTx: Hex;
  block: bigint;
  /** Transaction order inside the block (bot first). */
  order: Hex[];
  spotBefore: bigint;
  spotAfter: bigint;
}

export async function runRevertScenario(opts: {
  rpc: string;
  botUsdt?: string;
  logPath?: string;
  log?: (line: string) => void;
}): Promise<RevertScenarioResult> {
  const log = opts.log ?? (() => {});
  const f = await connectFork(opts.rpc);
  const { guard, router, attestor } = await deployPreflight(f);
  const agentW = f.wallet(ANVIL_KEYS.agent);
  const botW = f.wallet(ANVIL_KEYS.bot);
  const botUsdt = opts.botUsdt ?? "10000";
  await fundGas(f, agentW.account.address);
  await fundGas(f, botW.account.address);
  await fundUsdt(f, agentW.account.address, "100");
  await fundUsdt(f, botW.account.address, botUsdt);
  await approveMax(f, agentW, USDT, router);
  await approveMax(f, botW, USDT, SWAP_ROUTER02);
  log(`deployed guard ${guard}, router ${router}; agent ${agentW.account.address} funded 100 USDT`);

  // CEX med5 1.5% above the DEX: the agent's strategy buys WHSK; the attestor signs (verdict DEX).
  const { klines, fair } = await injectedCex(f, 1.015);
  const slot0 = parseAbi(["function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)"]);
  const spot = async () => (await f.pub.readContract({ address: WHSK_USDT_POOL, abi: slot0, functionName: "slot0" }))[0];
  const spotBefore = await spot();

  await setAutomine(f, false);
  try {
    const pending = tick({
      agent: agentW.account.address,
      router,
      client: f.pub,
      quotes: createQuoteService({ client: f.pub, attestor, guard, chainId: f.chain.id, fairPrice: async () => fair, ttlSeconds: 60 }),
      proposer: deterministicProposer,
      klines: async () => klines,
      poolState: () => fetchPoolState(f.pub),
      capitalUsd: 100,
      wallet: agentW,
      live: true,
      logPath: opts.logPath ?? join(mkdtempSync(join(tmpdir(), "pf-scenario-")), "reasons.jsonl"),
    });
    const victim = await waitPending(f, agentW.account.address);
    log(`agent guardedSwap in mempool: ${victim.hash} (quote signed, simulation passed)`);
    const botTx = await frontRunBuy(f, botW, botUsdt, victim);
    log(`bot front-runs with ${botUsdt} USDT buy: ${botTx}`);
    await mine(f);
    const agent = await pending;
    const receipt = await f.pub.getTransactionReceipt({ hash: botTx });
    const block = await f.pub.getBlock({ blockNumber: receipt.blockNumber });
    const spotAfter = await spot();
    log(`block ${block.number}: ${block.transactions.join(" → ")}`);
    log(`agent: ${agent.action} ${agent.txHash ?? ""} ${agent.error ?? ""}`);
    const events = await f.pub.getContractEvents({ address: router, abi: ROUTER_ABI, eventName: "GuardedSwap", fromBlock: block.number, toBlock: block.number });
    if (events.length !== 0) throw new Error("unexpected GuardedSwap in the front-run block");
    return { guard, router, agent, botTx, block: block.number, order: [...block.transactions], spotBefore, spotAfter };
  } finally {
    await setAutomine(f, true);
  }
}
