import Link from "next/link";
import { fmtBps, fmtInt, fmtUsd } from "@/lib/format";
import { BLOCKSCOUT, leaderboard } from "@/lib/leaderboard";

const steps = [
  {
    n: "01",
    title: "Quote",
    body: "Before any transaction, the agent asks POST /api/quote for price impact, LP fee, deviation from the CEX median, and total cost.",
  },
  {
    n: "02",
    title: "Check",
    body: "The attestor signs only executable DEX verdicts backed by a fresh CEX price. Anything else comes back unsigned, with a reason and a size that fits.",
  },
  {
    n: "03",
    title: "Guarded swap",
    body: "GuardedRouter re-checks impact, deviation, fair floor and expiry on-chain. Past the agent's policy, the swap reverts.",
  },
];

const tools = [
  { name: "guard_quote", body: "Cost breakdown, verdict and a signed quote when the swap fits the policy." },
  { name: "guard_check", body: "Dry-run of ExecutionGuard.verify via eth_call, so the agent knows it will pass." },
  { name: "guarded_swap", body: "Calldata for GuardedRouter. Sends only with an agent key and PREFLIGHT_EXECUTE=1." },
];

const contracts = [
  { label: "ExecutionGuard", address: process.env.NEXT_PUBLIC_GUARD_ADDRESS?.trim() },
  { label: "GuardedRouter", address: process.env.NEXT_PUBLIC_ROUTER_ADDRESS?.trim() },
];

export default function Home() {
  const s = leaderboard.summary;
  return (
    <div className="space-y-16">
      <section className="space-y-5 pt-6">
        <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">Execution guard for AI agents</p>
        <h1 className="max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-balance text-zinc-50 sm:text-4xl">
          Preflight tells an AI agent what a swap costs before it is sent, and reverts on-chain past its limit.
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-zinc-400">
          The WHSK/USDT pool on HSKSwap held about $839k TVL (24 Nov 2026). A $50 swap pays roughly the 30 bps fee; a
          $10k swap pays hundreds of bps. Preflight makes that number visible to the agent and enforceable on-chain.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Trust model: the CEX reference price is attested by a single trusted signer; the on-chain guard then bounds
          price impact and deviation from that attested price.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/playground"
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            Try the playground
          </Link>
          <Link
            href="/leaderboard"
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            30-day execution costs
          </Link>
        </div>
      </section>

      <section aria-labelledby="how" className="space-y-5">
        <h2 id="how" className="text-lg font-semibold text-zinc-50">
          How it works
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {steps.map((st) => (
            <li key={st.n} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
              <p className="font-mono text-xs text-emerald-400">{st.n}</p>
              <h3 className="mt-2 text-base font-semibold text-zinc-100">{st.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{st.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="pool" className="rounded-lg border border-zinc-800 p-6">
        <h2 id="pool" className="text-sm font-semibold text-zinc-100">
          WHSK/USDT pool, 30-day snapshot
        </h2>
        <dl className="mt-4 grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat label="Swaps" value={fmtInt(s.swaps)} />
          <Stat label="Volume" value={fmtUsd(s.volumeUsd)} />
          <Stat label="Median execution cost" value={fmtBps(s.medianCostBps)} />
          <Stat label="Paid in fee + impact" value={fmtUsd(s.feeImpactUsd)} />
        </dl>
      </section>

      <section aria-labelledby="agents" className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-4">
          <h2 id="agents" className="text-lg font-semibold text-zinc-50">
            For AI agents
          </h2>
          <p className="text-sm leading-relaxed text-zinc-400">
            Preflight ships as an MCP server, so any MCP-capable agent can price and guard a swap with three tools.
          </p>
          <ul className="space-y-3">
            {tools.map((t) => (
              <li key={t.name} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <code className="font-mono text-sm text-emerald-300">{t.name}</code>
                <p className="mt-1 text-sm text-zinc-400">{t.body}</p>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-zinc-100">Or call the HTTP API</h3>
          <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-300">
            {`curl -X POST /api/quote \\
  -H 'content-type: application/json' \\
  -d '{"agent":"0x…","executor":"0x…",
       "zeroForOne":false,"amountIn":"50"}'`}
          </pre>
          <h3 className="pt-2 text-sm font-semibold text-zinc-100">Mainnet contracts</h3>
          <dl className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {contracts.map((c) => (
              <div key={c.label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <dt className="text-zinc-300">{c.label}</dt>
                <dd className="min-w-0 font-mono text-xs">
                  {c.address ? (
                    <a
                      href={`${BLOCKSCOUT}/address/${c.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-emerald-300 hover:underline focus-visible:outline-2 focus-visible:outline-emerald-400"
                    >
                      {c.address}
                    </a>
                  ) : (
                    <span className="text-zinc-400">deploying soon</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-400">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-zinc-50">{value}</dd>
    </div>
  );
}
