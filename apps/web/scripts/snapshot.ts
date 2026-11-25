// pnpm snapshot → apps/web/data/leaderboard.json (30 days: blocks 29,302,744–30,598,744).
// Reads research/data/ caches when present (read-only) so the RPC is only used for tx senders, which are cached in
// apps/web/data/tx_senders.json. Read-only: eth_getLogs / eth_getTransactionByHash / eth_call, never a tx.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateByWallet,
  costHistogram,
  fetchGuardedSwaps,
  fetchIndexerLogs,
  fetchPoolState,
  fetchTxSenders,
  indexSwaps,
  parsePoolStateJson,
  summarize,
  SWAP_TOPIC,
  WHSK_USDT_POOL,
  type IndexerLog,
  type Kline,
} from "@preflight/core";
import { createPublicClient, getAddress, http, isAddress, parseUnits, type Address, type PublicClient } from "viem";
import type { Leaderboard } from "../lib/leaderboard.ts";

const FROM_BLOCK = 29_302_744n;
const TO_BLOCK = 30_598_744n;
const EXPECTED = { swaps: 2136, volumeUsd: 40_651 }; // research/REPORT.md

const here = dirname(fileURLToPath(import.meta.url));
const research = join(here, "..", "..", "..", "research", "data");
const dataDir = join(here, "..", "data");
const sendersPath = join(dataDir, "tx_senders.json");
const outPath = join(dataDir, "leaderboard.json");

const rpcUrl = process.env.HSK_RPC_URL?.trim() || "https://mainnet.hsk.xyz";
const client = createPublicClient({ transport: http(rpcUrl, { batch: { batchSize: 50 }, timeout: 30_000, retryCount: 0 }) }) as PublicClient;
const log = (msg: string) => console.error(`[snapshot] ${msg}`);
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

async function loadLogs(): Promise<{ logs: IndexerLog[]; source: string }> {
  const p = join(research, "swap_logs.json");
  if (existsSync(p)) return { logs: readJson(p) as IndexerLog[], source: "research/data/swap_logs.json" };
  log("research swap_logs.json missing → eth_getLogs (5,000-block chunks)");
  return { logs: await fetchIndexerLogs(client, WHSK_USDT_POOL, SWAP_TOPIC, FROM_BLOCK, TO_BLOCK), source: `eth_getLogs ${rpcUrl}` };
}

function loadKlines(): { klines: Kline[]; source: string } {
  const p = join(research, "cex_klines.json");
  if (!existsSync(p)) {
    log("research cex_klines.json missing → deviation vs CEX will be null for every swap");
    return { klines: [], source: "none (devBps null)" };
  }
  const rows = (readJson(p) as { rows: [number, number | string, number][] }).rows;
  const klines = rows
    .map(([openTimeMs, close, volume]) => ({ openTimeMs, closeE18: parseUnits(String(close), 18), volume }))
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  return { klines, source: "research/data/cex_klines.json (HashKey Global HSKUSDT 1m)" };
}

async function loadPool() {
  const p = join(research, "pool_state.json");
  if (existsSync(p)) return parsePoolStateJson(readFileSync(p, "utf8"));
  log("research pool_state.json missing → reading tick map at the end block");
  return fetchPoolState(client, { blockNumber: TO_BLOCK });
}

function loadSenders(): Map<string, Address> {
  if (!existsSync(sendersPath)) return new Map();
  const raw = readJson(sendersPath) as Record<string, string>;
  return new Map(Object.entries(raw).filter(([, v]) => isAddress(v)).map(([k, v]) => [k.toLowerCase(), getAddress(v)]));
}

function saveSenders(m: Map<string, Address>) {
  const sorted = Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(sendersPath, `${JSON.stringify(sorted, null, 0)}\n`);
}

async function main() {
  mkdirSync(dataDir, { recursive: true });
  const [{ logs, source: logSource }, pool] = await Promise.all([loadLogs(), loadPool()]);
  const inRange = logs.filter((l) => {
    const b = BigInt(l.blockNumber);
    return b >= FROM_BLOCK && b <= TO_BLOCK;
  });
  const { klines, source: klineSource } = loadKlines();

  const senders = loadSenders();
  const cachedBefore = senders.size;
  await fetchTxSenders(
    client,
    inRange.map((l) => l.transactionHash),
    senders,
    {
      batchSize: 50,
      tries: 8,
      initialDelayMs: 2000,
      onProgress: (done, total) => {
        saveSenders(senders);
        if (done === total || done % 500 === 0) log(`senders ${done}/${total}`);
      },
    },
  );
  saveSenders(senders);
  log(`senders: ${senders.size} cached (${senders.size - cachedBefore} fetched)`);

  const t0 = Date.now();
  const swaps = indexSwaps({ logs: inRange, pool, klines, senders });
  log(`indexed ${swaps.length} swaps in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const summary = summarize(swaps);

  const routerEnv = process.env.ROUTER_ADDRESS?.trim();
  const router = routerEnv && isAddress(routerEnv) ? getAddress(routerEnv) : null;
  const items = router ? await fetchGuardedSwaps(client, router, FROM_BLOCK, await client.getBlockNumber()) : [];

  const diffSwaps = summary.swaps - EXPECTED.swaps;
  const out: Leaderboard = {
    generatedAt: new Date().toISOString(),
    range: {
      fromBlock: Number(FROM_BLOCK),
      toBlock: Number(TO_BLOCK),
      fromIso: new Date((summary.firstSwapAt ?? 0) * 1000).toISOString(),
      toIso: new Date((summary.lastSwapAt ?? 0) * 1000).toISOString(),
    },
    sources: { logs: logSource, klines: klineSource, senders: "eth_getTransactionByHash (cache apps/web/data/tx_senders.json)" },
    reconciliation: {
      expectedSwaps: EXPECTED.swaps,
      expectedVolumeUsd: EXPECTED.volumeUsd,
      swaps: summary.swaps,
      volumeUsd: summary.volumeUsd,
      note:
        diffSwaps === 0
          ? "Jumlah swap dan volume cocok dengan research/REPORT.md."
          : `Selisih ${diffSwaps} swap vs research/REPORT.md (log duplikat dibuang / di luar rentang blok).`,
    },
    summary,
    histogram: costHistogram(swaps),
    wallets: aggregateByWallet(swaps),
    feed: { router, items },
  };
  writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);
  log(
    `wrote ${outPath}: swaps=${summary.swaps} wallets=${summary.uniqueWallets} volume=$${summary.volumeUsd.toFixed(0)} ` +
      `medianCost=${summary.medianCostBps}bps feeImpact=$${summary.feeImpactUsd.toFixed(2)} total=$${summary.totalCostUsd.toFixed(2)}`,
  );
}

main().catch((err: unknown) => {
  console.error("[snapshot] failed:", err instanceof Error ? err.message.split("\n")[0] : String(err));
  process.exit(1);
});
