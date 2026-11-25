import type { VerdictKind } from "@preflight/core";
import Link from "next/link";
import { AddressChip } from "@/components/address-chip";
import { CodeBlock } from "@/components/code-block";
import { ButtonLink, cn, ExternalLink, linkClass, Panel, Section, Stat, VerdictBadge } from "@/components/ui";
import { GITHUB_URL, mainnetContracts, mainnetUrl, testnet, testnetUrl } from "@/lib/deployments";
import { fmtBps, fmtInt, fmtUsd } from "@/lib/format";
import { leaderboard } from "@/lib/leaderboard";
import { TONE_CLASSES, VERDICT_COPY } from "@/lib/verdict-copy";

/** Research figures from README.md "The problem" (Uniswap V3 simulation on the WHSK/USDT pool, Nov 2026). */
const ORDER_COSTS = [
  { size: "$50", feeBps: 30, impactBps: 0, note: "≈ the 30 bps LP fee" },
  { size: "$4.24k", feeBps: 30, impactBps: 100, note: "impact reaches 100 bps" },
  { size: "$10k", feeBps: 30, impactBps: 233, note: "≈233 bps impact on top of the fee" },
];

const VERDICT_ROWS: { kind: VerdictKind; signed: string }[] = [
  { kind: "DEX", signed: "Yes, with a fresh CEX price" },
  { kind: "CEX", signed: "No" },
  { kind: "TUNDA", signed: "No" },
  { kind: "KECILKAN", signed: "No, returns the size that fits" },
  { kind: "NO_REFERENCE", signed: "No" },
  { kind: "OUT_OF_RANGE", signed: "No" },
];

const tools = [
  { name: "guard_quote", body: "Cost breakdown, verdict and a signed quote when the swap fits the policy." },
  { name: "guard_check", body: "Dry-run of ExecutionGuard.verify via eth_call, so the agent knows it will pass." },
  { name: "guarded_swap", body: "Calldata for GuardedRouter. Sends only with an agent key and PREFLIGHT_EXECUTE=1." },
];

const limitations = [
  {
    title: "Single trusted attestor",
    body: "The guard cannot detect a wrong or malicious attestor. Short expiry, nonces and a per-agent on-chain policy limit the damage, and a stale CEX price is refused rather than replaced by the DEX spot.",
  },
  {
    title: "Thin CEX reference",
    body: "61% of CEX minutes have no volume and the 0.0001 tick is ≈12 bps, so the fair price is a median of 5 traded minutes and stale data is refused.",
  },
  {
    title: "In-sample research",
    body: "The backtests cover one 30-day window. The demo agent shows guarded execution; it is not a return claim.",
  },
  {
    title: "One pool",
    body: "Only WHSK/USDT 0.3% on HSKSwap is supported today.",
  },
];

export default function Home() {
  const s = leaderboard.summary;
  const guard = mainnetContracts[0]?.address ?? "0xYourGuardAddress";
  const router = mainnetContracts[1]?.address ?? "0xYourRouterAddress";

  return (
    <div className="space-y-28 sm:space-y-36">
      <Hero />

      <Section
        id="problem"
        title="The pool looks deep. It trades thin."
        lead="An AI agent that can call swap() cannot see what the swap will cost. On HSK Chain the main WHSK/USDT pool shows a large TVL, but very little trades through it, and its price drifts from the CEX with nobody pulling it back."
      >
        <dl className="grid gap-x-8 gap-y-10 rounded-lg bg-surface p-6 sm:grid-cols-2 sm:p-8 lg:grid-cols-5">
          <Stat size="lg" label="TVL" value="$839k" hint="HSKSwap WHSK/USDT, 24 Nov 2026" />
          <Stat size="lg" label="Swaps in 30 days" value={fmtInt(s.swaps)} hint={`≈${fmtUsd(Math.round(s.volumeUsd))} volume`} />
          <Stat size="lg" label="Largest swap" value="$502" hint="in the same 30 days" />
          <Stat size="lg" label="Median |DEX − CEX|" value="40 bps" hint="vs HashKey Global HSKUSDT" />
          <Stat size="lg" label="No half recovery in 24 h" value="72%" hint="18 of 25 price-moving swaps" />
        </dl>
        <p className="mt-6 max-w-3xl text-base leading-relaxed text-soft">
          An agent that sizes trades from TVL, or splits an order and waits for the price to come back, overpays without
          noticing. Across all {fmtInt(s.swaps)} swaps the median execution cost was {fmtBps(s.medianCostBps)}.{" "}
          <Link href="/leaderboard" className={linkClass}>
            See execution cost per wallet
          </Link>
          .
        </p>
      </Section>

      <HowItWorks />

      <Evidence />

      <Section
        id="agents"
        title="For AI agents"
        lead="Preflight ships as an MCP server, so any MCP-capable agent can price and guard a swap with three tools. The same quote is available over HTTP."
      >
        <div className="grid gap-8 lg:grid-cols-[1fr_1.25fr]">
          <dl className="space-y-3">
            {tools.map((t) => (
              <div key={t.name} className="rounded-lg bg-surface p-5">
                <dt>
                  <code className="font-mono text-base text-accent-strong">{t.name}</code>
                </dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-soft">{t.body}</dd>
              </div>
            ))}
            <p className="pt-2 text-sm leading-relaxed text-muted">
              guarded_swap refuses notional above PREFLIGHT_MAX_USD (default $100) and an amountOutMin below the quote&apos;s
              fair floor.
            </p>
          </dl>
          <div className="min-w-0 space-y-4">
            <CodeBlock
              title="Add the MCP server (Claude Code)"
              code={`claude mcp add preflight \\
  -e PREFLIGHT_API_URL=https://preflight-hsk.vercel.app \\
  -e GUARD_ADDRESS=${guard} \\
  -e ROUTER_ADDRESS=${router} \\
  -- node /ABS/PATH/preflight/packages/mcp/bin/preflight-mcp.mjs`}
            />
            <CodeBlock
              title="Or call the HTTP API"
              code={`curl -X POST https://preflight-hsk.vercel.app/api/quote \\
  -H 'content-type: application/json' \\
  -d '{"agent":"0x…","executor":"0x…","zeroForOne":false,"amountIn":"50"}'`}
            />
          </div>
        </div>
      </Section>

      <Section
        id="trust"
        title="Trust model and limitations"
        lead={
          <>
            Trust model: the CEX reference price is attested by a single trusted signer; the on-chain guard then bounds
            price impact and deviation from that attested price.
          </>
        }
      >
        <ul className="grid gap-4 sm:grid-cols-2">
          {limitations.map((l) => (
            <li key={l.title} className="rounded-lg bg-surface p-5 sm:p-6">
              <h3 className="text-base font-semibold text-ink">{l.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-soft">{l.body}</p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Hero() {
  const max = Math.max(...ORDER_COSTS.map((o) => o.feeBps + o.impactBps));
  return (
    <section aria-labelledby="hero" className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
      <div className="space-y-6">
        <h1 id="hero" className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance text-ink sm:text-6xl">
          Know the cost before the swap
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-soft sm:text-xl">
          Preflight tells an AI agent what a swap costs before it is sent, and reverts on-chain past its limit.
        </p>
        <p className="max-w-xl text-base leading-relaxed text-muted">
          Built for HSKSwap on HSK Chain. A $50 swap pays roughly the 30 bps fee; a $10k swap pays hundreds of bps.
          Preflight makes that number visible to the agent and enforceable on-chain.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <ButtonLink href="/playground">Try the playground</ButtonLink>
          <ButtonLink href={GITHUB_URL} variant="secondary" external>
            View source on GitHub<span className="sr-only"> (opens in a new tab)</span>
          </ButtonLink>
        </div>
      </div>

      <figure className="rounded-lg bg-surface p-5 sm:p-7">
        <figcaption className="space-y-1">
          <p className="text-base font-semibold text-ink">What a market order costs on WHSK/USDT</p>
          <p className="text-sm text-muted">LP fee plus price impact, in bps. Deviation from the CEX price comes on top.</p>
        </figcaption>
        <ul className="mt-6 space-y-5">
          {ORDER_COSTS.map((o) => {
            const total = o.feeBps + o.impactBps;
            return (
              <li key={o.size}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-2xl font-semibold tracking-tight text-ink">{o.size}</span>
                  <span className="text-base font-semibold text-ink">≈{total} bps</span>
                </div>
                <div className="mt-2 flex h-3 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                  <span className="h-full bg-sky-400" style={{ width: `${(o.feeBps / max) * 100}%` }} />
                  {o.impactBps > 0 && <span className="h-full bg-amber-400" style={{ width: `${(o.impactBps / max) * 100}%` }} />}
                </div>
                <p className="mt-1.5 text-sm text-muted">{o.note}</p>
              </li>
            );
          })}
        </ul>
        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-soft" aria-hidden="true">
          <span className="inline-flex items-center gap-2">
            <span className="size-2.5 rounded-full bg-sky-400" /> LP fee
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="size-2.5 rounded-full bg-amber-400" /> Price impact
          </span>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Exact Uniswap V3 simulation on the pool state of the research snapshot (Nov 2026). Run any size live in the{" "}
          <Link href="/playground" className={linkClass}>
            playground
          </Link>
          .
        </p>
      </figure>
    </section>
  );
}

function HowItWorks() {
  const offChain = [
    {
      title: "The agent asks for a quote",
      body: (
        <>
          <code className="font-mono text-accent-strong">POST /api/quote</code> or the MCP tool guard_quote, with the
          direction and the amount.
        </>
      ),
    },
    {
      title: "The attestor prices it",
      body: "Exact Uniswap V3 math on the live pool, plus the CEX median as the fair price: LP fee, impact, deviation, total in bps and USD.",
    },
    {
      title: "Only a DEX verdict is signed",
      body: "An EIP-712 Quote with a short expiry. Every other verdict comes back unsigned, with a reason and the largest size that fits.",
    },
  ];
  return (
    <Section
      id="how"
      title="How it works: quote, sign, guardedSwap"
      lead="The cost is computed before the transaction exists, and checked again after the swap executes. If the price moved in between, the agent pays gas, not slippage."
    >
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel as="section" labelledBy="offchain">
          <h3 id="offchain" className="text-lg font-semibold text-ink">
            Off-chain: the quote
          </h3>
          <ol className="mt-5 grid gap-4 md:grid-cols-3">
            {offChain.map((st, i) => (
              <li key={st.title} className="relative rounded-md bg-raised p-4">
                <p className="text-base font-semibold text-ink">{st.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-soft">{st.body}</p>
                {i < offChain.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 -right-3.5 z-10 hidden size-6 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-sm font-bold text-on-accent md:flex"
                  >
                    →
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Panel>
        <Panel as="section" labelledBy="onchain" className="bg-accent/10">
          <h3 id="onchain" className="text-lg font-semibold text-ink">
            On-chain: the guard
          </h3>
          <p className="mt-5 font-mono text-sm text-accent-strong">GuardedRouter.guardedSwap</p>
          <p className="mt-2 text-sm leading-relaxed text-soft">
            ExecutionGuard.verify checks the signature, expiry and nonce. After the swap the router re-checks impact,
            post-swap deviation and the fair floor against the agent&apos;s on-chain policy.
          </p>
          <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md bg-ground/60 p-3">
              <dt className="font-semibold text-emerald-300">Within policy</dt>
              <dd className="mt-1 text-soft">The swap settles.</dd>
            </div>
            <div className="rounded-md bg-ground/60 p-3">
              <dt className="font-semibold text-rose-300">Past the limit</dt>
              <dd className="mt-1 text-soft">Reverts with a decoded error.</dd>
            </div>
          </dl>
        </Panel>
      </div>

      <section aria-labelledby="verdicts-mobile" className="mt-10 rounded-lg bg-surface p-5 sm:hidden">
        <h3 id="verdicts-mobile" className="text-base font-semibold text-ink">
          Six verdicts
        </h3>
        <ul className="mt-4 space-y-4">
          {VERDICT_ROWS.map((v) => (
            <li key={v.kind} className="space-y-1.5">
              <VerdictBadge kind={v.kind} />
              <p className="text-sm leading-relaxed text-soft">{VERDICT_COPY[v.kind].summary}</p>
              <p className="text-sm text-muted">Signed: {v.signed}</p>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-10 hidden overflow-x-auto rounded-lg bg-surface sm:block">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <caption className="px-5 pt-5 text-left text-base font-semibold text-ink sm:px-6">Six verdicts</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="px-5 py-3 font-medium sm:px-6">
                Verdict
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Meaning
              </th>
              <th scope="col" className="px-5 py-3 font-medium sm:px-6">
                Signed
              </th>
            </tr>
          </thead>
          <tbody>
            {VERDICT_ROWS.map((v, i) => (
              <tr key={v.kind} className={cn(i % 2 === 0 && "bg-raised/50")}>
                <td className="px-5 py-3 sm:px-6">
                  <VerdictBadge kind={v.kind} />
                </td>
                <td className="px-5 py-3 text-soft">{VERDICT_COPY[v.kind].summary}</td>
                <td className="px-5 py-3 text-soft sm:px-6">{v.signed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

type ChipTone = "ok" | "neutral" | "fail";

const NEUTRAL_CHIP = { chip: "bg-raised text-soft", dot: "bg-muted" };

function StatusChip({ tone: t, children }: { tone: ChipTone; children: string }) {
  const tone = t === "neutral" ? NEUTRAL_CHIP : TONE_CLASSES[t === "ok" ? "go" : "stop"];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", tone.chip)}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />
      {children}
    </span>
  );
}

function Evidence() {
  const steps = [
    {
      tx: testnet.txs.success,
      tone: "ok" as ChipTone,
      status: "Success",
      title: "Guarded swap within policy",
      body: "10 tUSDT → 9.96 tWHSK, equal to the off-chain simulation. GuardedSwap event: impact 10 bps, deviation 19 bps.",
    },
    {
      tx: testnet.txs.frontRun,
      tone: "neutral" as ChipTone,
      status: "Front-run (attacker tx)",
      title: "Front-run after the next quote is signed",
      body: "250 tUSDT sent straight to SwapRouter02 moves the pool away from the quoted fair price.",
    },
    {
      tx: testnet.txs.revert,
      tone: "fail" as ChipTone,
      status: "Reverted",
      title: "Same quote, now past the limit",
      body: "ExecutionGuard.verify reverts with DeviationTooHigh(480, 200): 480 bps observed, 200 bps allowed.",
    },
  ];
  return (
    <Section
      id="evidence"
      title="Proof on-chain"
      lead="Testnet (test pool, not HSKSwap). HSKSwap is not deployed on HSK Chain Testnet, so this run uses its own Uniswap V3 pool with two worthless test tokens. It shows the guard mechanics on a live chain, not HSKSwap liquidity or prices."
    >
      <ol className="grid gap-4 lg:grid-cols-3">
        {steps.map((st) => (
          <li key={st.tx} className={cn("flex flex-col rounded-lg p-5 sm:p-6", st.tone === "fail" ? "bg-rose-400/10" : "bg-surface")}>
            <StatusChip tone={st.tone}>{st.status}</StatusChip>
            <h3 className="mt-3 text-lg font-semibold text-ink">{st.title}</h3>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-soft">{st.body}</p>
            <AddressChip className="mt-4" kind="transaction" value={st.tx} href={testnetUrl("tx", st.tx)} />
          </li>
        ))}
      </ol>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Panel as="section" labelledBy="testnet-contracts">
          <h3 id="testnet-contracts" className="text-base font-semibold text-ink">
            Testnet contracts · chain {testnet.chainId}, deployed {testnet.deployedOn}
          </h3>
          <dl className="mt-4 space-y-3">
            {testnet.contracts.map((c) => (
              <div key={c.address} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <dt className="text-sm text-soft">
                  {c.label} <span className="text-muted">· {c.note}</span>
                </dt>
                <dd>
                  <AddressChip value={c.address} href={testnetUrl("address", c.address)} />
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel as="section" labelledBy="mainnet-contracts">
          <h3 id="mainnet-contracts" className="text-base font-semibold text-ink">
            Mainnet contracts · HSK Chain 177
          </h3>
          <dl className="mt-4 space-y-3">
            {mainnetContracts.map((c) => (
              <div key={c.label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <dt className="text-sm text-soft">{c.label}</dt>
                <dd>
                  {c.address ? (
                    <AddressChip value={c.address} href={mainnetUrl("address", c.address)} />
                  ) : (
                    <span className="rounded-full bg-raised px-2.5 py-0.5 text-xs font-medium text-soft">Coming soon</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-muted">
            {mainnetContracts.every((c) => c.address) ? "Explorer: " : "Addresses will be listed on "}
            <ExternalLink href="https://hsk.blockscout.com">hsk.blockscout.com</ExternalLink>
            {mainnetContracts.every((c) => c.address) ? "." : " once deployed."}
          </p>
        </Panel>
      </div>
    </Section>
  );
}
