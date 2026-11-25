import type { Metadata } from "next";
import { fmtBps, fmtDate, fmtInt, fmtUsd } from "@/lib/format";
import { BLOCKSCOUT, leaderboard, shortAddress } from "@/lib/leaderboard";

export const metadata: Metadata = { title: "Execution cost leaderboard · Preflight" };

const linkClass = "text-emerald-300 hover:underline focus-visible:outline-2 focus-visible:outline-emerald-400";

export default function LeaderboardPage() {
  const { summary: s, histogram, wallets, range, feed } = leaderboard;
  const maxBucket = Math.max(...histogram.map((b) => b.swaps), 1);
  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Execution cost per wallet</h1>
        <p className="text-sm text-zinc-400">
          Uniswap V3 pool WHSK/USDT 0.3% on HSK Chain · {fmtDate(range.fromIso)} – {fmtDate(range.toIso)} · blocks{" "}
          {fmtInt(range.fromBlock)}–{fmtInt(range.toBlock)}
        </p>
      </header>

      <section aria-label="Summary" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card label="Total swaps" value={fmtInt(s.swaps)} hint={`${fmtInt(s.uniqueWallets)} unique wallets`} />
        <Card label="Volume" value={fmtUsd(s.volumeUsd)} hint="USDT side of each swap" />
        <Card
          label="Mean execution cost"
          value={fmtBps(s.meanCostBps)}
          hint={`median ${fmtBps(s.medianCostBps)} · volume-weighted ${fmtBps(s.volumeWeightedCostBps)}`}
        />
        <Card
          label="Paid in fee + impact"
          value={fmtUsd(s.feeImpactUsd)}
          hint={`incl. deviation vs CEX: ${fmtUsd(s.totalCostUsd)}`}
        />
      </section>

      <section aria-labelledby="dist" className="rounded-lg border border-zinc-800 p-5">
        <h2 id="dist" className="text-sm font-semibold text-zinc-100">
          Execution cost per swap, distribution
        </h2>
        <ul className="mt-4 space-y-2">
          {histogram.map((b) => (
            <li key={b.fromBps} className="grid grid-cols-[6.5rem_1fr_5.5rem] items-center gap-3 text-xs">
              <span className="text-zinc-400">
                {b.toBps === null ? `≥ ${b.fromBps}` : `${b.fromBps}–${b.toBps}`} bps
              </span>
              <div className="h-3 rounded-sm bg-zinc-900" aria-hidden="true">
                <div
                  className="h-3 rounded-sm bg-emerald-500/80"
                  style={{ width: `${b.swaps === 0 ? 0 : Math.max((b.swaps / maxBucket) * 100, 1)}%` }}
                />
              </div>
              <span className="text-right text-zinc-300">{fmtInt(b.swaps)} swaps</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Execution cost per wallet, sorted as in the snapshot</caption>
          <thead className="bg-zinc-900/70 text-xs uppercase tracking-wide text-zinc-400">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Wallet</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Swaps</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Volume</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Mean cost</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Median cost</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Total execution cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/80">
            {wallets.map((w) => (
              <tr key={w.wallet} className="hover:bg-zinc-900/40">
                <td className="px-4 py-2.5 font-mono text-xs">
                  {w.wallet === "unknown" ? (
                    <span className="text-zinc-400">unknown</span>
                  ) : (
                    <a
                      href={`${BLOCKSCOUT}/address/${w.wallet}`}
                      target="_blank"
                      rel="noreferrer"
                      className={linkClass}
                      title={w.wallet}
                    >
                      {shortAddress(w.wallet)}
                    </a>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">{fmtInt(w.swaps)}</td>
                <td className="px-4 py-2.5 text-right">{fmtUsd(w.volumeUsd)}</td>
                <td className="px-4 py-2.5 text-right">{fmtBps(w.meanCostBps)}</td>
                <td className="px-4 py-2.5 text-right">{fmtBps(w.medianCostBps)}</td>
                <td className="px-4 py-2.5 text-right">{fmtUsd(w.totalCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {feed.router !== null && (
        <section aria-labelledby="feed" className="rounded-lg border border-zinc-800 p-5">
          <h2 id="feed" className="text-sm font-semibold text-zinc-100">
            Swaps through GuardedRouter
          </h2>
          {feed.items.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-400">No GuardedSwap events yet.</p>
          ) : (
            <ul className="mt-3 space-y-1 font-mono text-xs text-zinc-400">
              {feed.items.slice(0, 20).map((it) => (
                <li key={it.txHash}>
                  <a href={`${BLOCKSCOUT}/tx/${it.txHash}`} target="_blank" rel="noreferrer" className={linkClass}>
                    {shortAddress(it.txHash)}
                  </a>{" "}
                  agent {shortAddress(it.agent)} · impact {it.impactBps} bps · deviation {it.devBps} bps
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section
        aria-labelledby="method"
        className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-5 text-sm leading-relaxed text-zinc-400"
      >
        <h2 id="method" className="font-semibold text-zinc-100">
          Methodology
        </h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <b className="text-zinc-300">Execution cost</b> = 30 bps LP fee + price impact + pool-vs-CEX price deviation
            against the trade direction. USD cost = volume × bps.
          </li>
          <li>
            <b className="text-zinc-300">Price impact</b> excludes the LP fee: actual output versus output at the spot
            price before the swap. Pre-swap state is replayed with an integer-exact Uniswap V3 simulation (
            {fmtInt(s.impactSources["sim-exact-in"] + s.impactSources["sim-exact-out"])} of {fmtInt(s.swaps)} swaps
            reproduced exactly).
          </li>
          <li>
            <b className="text-zinc-300">CEX reference</b> = med5: median close of the last 5 traded minutes on HashKey
            Global HSKUSDT (≤30 minutes). If the last trade is ≥5 minutes old, the reference is stale and deviation is
            skipped ({fmtInt(s.staleReference)} swaps).
          </li>
          <li>
            Wallet = transaction sender (<code>from</code>), which may be a bot or an aggregator. 30-day in-sample data;
            a static snapshot, not trading advice.
          </li>
        </ul>
      </section>
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-zinc-50">{value}</p>
      <p className="mt-1 text-xs text-zinc-400">{hint}</p>
    </div>
  );
}
