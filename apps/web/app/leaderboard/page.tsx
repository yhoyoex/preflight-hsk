import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { PageHeader, Panel, PanelTitle, Section, Stat, cn, linkClass } from "@/components/ui";
import { fmtBps, fmtDate, fmtInt, fmtUsd } from "@/lib/format";
import { BLOCKSCOUT, leaderboard, shortAddress } from "@/lib/leaderboard";
import { WalletTable } from "./wallet-table";

export const metadata: Metadata = { title: "Execution cost leaderboard · Preflight" };

export default function LeaderboardPage() {
  const { summary: s, histogram, wallets, range, feed } = leaderboard;
  const maxBucket = Math.max(...histogram.map((b) => b.swaps), 1);
  return (
    <div className="space-y-20 sm:space-y-28">
      <div className="space-y-10">
        <PageHeader
          title="Execution cost per wallet"
          lead={
            <>
              Every swap on the Uniswap V3 pool WHSK/USDT 0.3% on HSK Chain from {fmtDate(range.fromIso)} to{" "}
              {fmtDate(range.toIso)}, replayed to measure what each trade actually paid: LP fee, price impact and deviation
              from the CEX price.
            </>
          }
        >
          <p className="text-sm text-muted">
            Blocks {fmtInt(range.fromBlock)}–{fmtInt(range.toBlock)} · static snapshot ·{" "}
            <a href="/api/leaderboard" className={linkClass}>
              JSON
            </a>
          </p>
        </PageHeader>

        <dl aria-label="Summary" className="grid gap-x-8 gap-y-8 rounded-lg bg-surface p-6 sm:grid-cols-2 sm:p-8 lg:grid-cols-4">
          <Stat size="lg" label="Total swaps" value={fmtInt(s.swaps)} hint={`${fmtInt(s.uniqueWallets)} unique wallets`} />
          <Stat size="lg" label="Volume" value={fmtUsd(s.volumeUsd)} hint="USDT side of each swap" />
          <Stat
            size="lg"
            label="Median execution cost"
            value={fmtBps(s.medianCostBps)}
            hint={`mean ${fmtBps(s.meanCostBps)} · volume-weighted ${fmtBps(s.volumeWeightedCostBps)}`}
          />
          <Stat size="lg" label="Paid in fee + impact" value={fmtUsd(s.feeImpactUsd)} hint={`incl. deviation vs CEX: ${fmtUsd(s.totalCostUsd)}`} />
        </dl>
      </div>

      <Section
        id="dist"
        title="Execution cost per swap, distribution"
        lead="Most swaps are small and pay close to the 30 bps LP fee. The tail is where impact and deviation add up."
      >
        <Panel>
          <ul className="space-y-3">
            {histogram.map((b) => {
              const pct = s.swaps === 0 ? 0 : (b.swaps / s.swaps) * 100;
              return (
                <li key={b.fromBps} className="grid grid-cols-[5.5rem_1fr_6.5rem] items-center gap-3 text-sm sm:grid-cols-[7rem_1fr_9rem]">
                  <span className="text-soft">{b.toBps === null ? `≥ ${b.fromBps}` : `${b.fromBps}–${b.toBps}`} bps</span>
                  <div className="h-4 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${b.swaps === 0 ? 0 : Math.max((b.swaps / maxBucket) * 100, 1.5)}%` }}
                    />
                  </div>
                  <span className="text-right text-ink">
                    {fmtInt(b.swaps)} <span className="text-muted">· {pct.toFixed(1)}%</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      </Section>

      <Section
        id="wallets"
        title="Wallets"
        lead={`${fmtInt(wallets.length)} wallets, sorted by total execution cost. Select a column header to sort by it.`}
      >
        <WalletTable wallets={wallets} />
      </Section>

      {feed.router !== null && (
        <Section id="feed" title="Swaps through GuardedRouter">
          <Panel>
            {feed.items.length === 0 ? (
              <p className="text-sm text-soft">No GuardedSwap events yet.</p>
            ) : (
              <ul className="space-y-2 text-sm text-soft">
                {feed.items.slice(0, 20).map((it) => (
                  <li key={it.txHash}>
                    <a href={`${BLOCKSCOUT}/tx/${it.txHash}`} target="_blank" rel="noreferrer" className={`font-mono ${linkClass}`}>
                      {shortAddress(it.txHash)}
                    </a>{" "}
                    agent {shortAddress(it.agent)} · impact {it.impactBps} bps · deviation {it.devBps} bps
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </Section>
      )}

      <Section id="method" title="Methodology">
        <Panel>
          <PanelTitle>How execution cost is measured</PanelTitle>
          <ul className="mt-4 grid gap-5 text-sm leading-relaxed text-soft md:grid-cols-2">
            <li>
              <b className="text-ink">Execution cost</b> = 30 bps LP fee + price impact + pool-vs-CEX price deviation
              against the trade direction. USD cost = volume × bps.
            </li>
            <li>
              <b className="text-ink">Price impact</b> excludes the LP fee: actual output versus output at the spot price
              before the swap. Pre-swap state is replayed with an integer-exact Uniswap V3 simulation (
              {fmtInt(s.impactSources["sim-exact-in"] + s.impactSources["sim-exact-out"])} of {fmtInt(s.swaps)} swaps
              reproduced exactly).
            </li>
            <li>
              <b className="text-ink">CEX reference</b> = med5: median close of the last 5 traded minutes on HashKey Global
              HSKUSDT (≤30 minutes). If the last trade is ≥5 minutes old, the reference is stale and deviation is skipped (
              {fmtInt(s.staleReference)} swaps).
            </li>
            <li>
              <b className="text-ink">Wallet</b> = transaction sender (<code className="font-mono">from</code>), which may
              be a bot or an aggregator. 30-day in-sample data; a static snapshot, not trading advice.
            </li>
          </ul>
        </Panel>
      </Section>

      <Section
        id="api"
        title="API"
        lead="The same snapshot as versioned JSON for agents and scripts: metric definitions, summary percentiles and a paginated wallet list. CORS is open; 30 requests per minute per IP."
      >
        <div className="space-y-6">
          <CodeBlock
            title="curl"
            code={`curl 'https://preflight-hsk.vercel.app/api/leaderboard?sort=volume&order=desc&limit=5&pretty=1'`}
          />
          <div className="overflow-x-auto rounded-lg bg-surface">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">Query parameters of GET /api/leaderboard</caption>
              <thead className="text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Parameter
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Values
                  </th>
                  <th scope="col" className="px-5 py-3 font-medium">
                    Default
                  </th>
                </tr>
              </thead>
              <tbody>
                {API_PARAMS.map((p, i) => (
                  <tr key={p.name} className={cn(i % 2 === 0 && "bg-raised/40")}>
                    <td className="px-5 py-3 font-mono text-ink">{p.name}</td>
                    <td className="px-5 py-3 text-soft">{p.values}</td>
                    <td className="px-5 py-3 font-mono text-soft">{p.default}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted">
            Invalid parameters return 400 with <code className="font-mono">{`{ "error": { "code", "message" } }`}</code>.
          </p>
        </div>
      </Section>
    </div>
  );
}

const API_PARAMS = [
  { name: "sort", values: "volume · swaps · costBps (mean) · costUsd", default: "volume" },
  { name: "order", values: "asc · desc", default: "desc" },
  { name: "limit", values: "1–100", default: "50" },
  { name: "offset", values: "integer ≥ 0", default: "0" },
  { name: "wallet", values: "0x address, any letter case", default: "–" },
  { name: "pretty", values: "1 · true · 0 · false", default: "0" },
] as const;
