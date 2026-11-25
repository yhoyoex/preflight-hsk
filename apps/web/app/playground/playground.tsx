"use client";

import type { RouterCheck, VerdictKind } from "@preflight/core";
import { useId, useState, type FormEvent } from "react";
import { formatUnits, isAddress } from "viem";
import { CopyButton } from "@/components/copy-button";
import { buttonClass, cn, Panel, PanelTitle } from "@/components/ui";
import { fmtAmount, fmtBps, fmtUsd } from "@/lib/format";
import { CHECK_COPY, TONE_CLASSES, VERDICT_COPY } from "@/lib/verdict-copy";
import { CostCurve, type CurveData } from "./cost-curve";

const EXAMPLE_ADDRESS = "0x00000000000000000000000000000000000a6E17";
const PRESETS = ["50", "1000", "5000", "20000"] as const;

type Direction = "usdt" | "whsk";
const DIRECTIONS: Record<Direction, { label: string; tokenIn: string; tokenOut: string; zeroForOne: boolean; decimalsIn: number; decimalsOut: number }> = {
  usdt: { label: "USDT → WHSK", tokenIn: "USDT", tokenOut: "WHSK", zeroForOne: false, decimalsIn: 6, decimalsOut: 18 },
  whsk: { label: "WHSK → USDT", tokenIn: "WHSK", tokenOut: "USDT", zeroForOne: true, decimalsIn: 18, decimalsOut: 6 },
};

/** Subset of the /api/quote response the UI reads (bigints arrive as strings). */
interface QuoteResult {
  attested: boolean;
  signature: string | null;
  verdict: { verdict: VerdictKind; executable: boolean; failedChecks: RouterCheck[] };
  metrics: {
    amountOut: string;
    impactBps: number | null;
    devBps: number | null;
    adverseDevBps: number | null;
    feeBps: number;
    totalCostBps: number | null;
    notionalUsd: number;
    suggestedMaxAmountIn: string | null;
    fairSource: "cex" | "dex-spot";
  };
  referenceError: string | null;
  policy: { maxImpactBps: number; maxDevBps: number; maxAge: number };
  policySource: "guard" | "default";
  quote: { deadline?: string } | null;
}

interface Submitted {
  direction: Direction;
  amount: string;
  result: QuoteResult;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Network error. Check your connection and try again.");
  }
  if (res.ok) return (await res.json()) as T;
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    throw new Error(
      `Too many requests. The API allows 30 quotes per minute per IP${Number.isFinite(wait) && wait > 0 ? `; try again in ${wait} s` : ""}.`,
    );
  }
  if (res.status === 400) throw new Error("The request was rejected. Check the amount and addresses.");
  if (res.status === 500) throw new Error("The quote service is not configured on this server yet.");
  throw new Error("Could not reach HSK Chain or the CEX price feed. Try again in a moment.");
}

const isValidAmount = (v: string) => /^\d{1,15}(\.\d{1,6})?$/.test(v) && Number(v) > 0;

const fieldClass =
  "w-full rounded-md bg-ground px-3 py-2.5 text-ink ring-1 ring-edge transition-shadow placeholder:text-muted/70 hover:ring-muted/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none aria-invalid:ring-rose-400";

export function Playground() {
  const ids = { form: useId(), amount: useId(), agent: useId(), executor: useId(), amountHint: useId() };
  const [direction, setDirection] = useState<Direction>("usdt");
  const [amount, setAmount] = useState("1000");
  const [agent, setAgent] = useState("");
  const [executor, setExecutor] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [curves, setCurves] = useState<Partial<Record<Direction, CurveData>>>({});
  const [curveError, setCurveError] = useState<string | null>(null);

  const amountValid = isValidAmount(amount);
  const agentValid = agent === "" || isAddress(agent);
  const executorValid = executor === "" || isAddress(executor);
  const canRun = !loading && amountValid && agentValid && executorValid;

  async function run(runDirection: Direction, runAmount: string) {
    if (loading || !isValidAmount(runAmount) || !agentValid || !executorValid) return;
    const dir = DIRECTIONS[runDirection];
    setLoading(true);
    setError(null);
    const quoteReq = postJson<QuoteResult>("/api/quote", {
      agent: agent || EXAMPLE_ADDRESS,
      executor: executor || agent || EXAMPLE_ADDRESS,
      zeroForOne: dir.zeroForOne,
      amountIn: runAmount,
    });
    // The curve only depends on direction; fetch it once per direction.
    const curveReq = curves[runDirection] ? null : postJson<CurveData>("/api/curve", { zeroForOne: dir.zeroForOne });
    const [q, c] = await Promise.allSettled([quoteReq, curveReq]);
    if (q.status === "fulfilled") setSubmitted({ direction: runDirection, amount: runAmount, result: q.value });
    else setError((q.reason as Error).message);
    if (c.status === "fulfilled" && c.value) {
      const data = c.value;
      setCurves((prev) => ({ ...prev, [runDirection]: data }));
      setCurveError(null);
    } else if (c.status === "rejected") setCurveError((c.reason as Error).message);
    setLoading(false);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(direction, amount);
  }

  function quickRun(p: string) {
    setDirection("usdt");
    setAmount(p);
    void run("usdt", p);
  }

  const dir = DIRECTIONS[direction];
  const curve = submitted ? curves[submitted.direction] : undefined;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[22rem_minmax(0,1fr)] lg:gap-8">
      <form
        id={ids.form}
        onSubmit={onSubmit}
        noValidate
        aria-label="Swap to check"
        className="space-y-6 rounded-lg bg-surface p-5 sm:p-6 lg:sticky lg:top-24"
      >
        <fieldset className="space-y-2.5">
          <legend className="mb-2.5 text-sm font-semibold text-ink">Direction</legend>
          <div className="grid grid-cols-2 gap-1 rounded-md bg-ground p-1">
            {(Object.keys(DIRECTIONS) as Direction[]).map((d) => (
              <label
                key={d}
                className="flex min-h-10 cursor-pointer items-center justify-center rounded-[5px] px-3 text-sm font-medium text-muted transition-colors hover:text-ink has-checked:bg-raised has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-accent-strong"
              >
                <input
                  type="radio"
                  name="direction"
                  value={d}
                  checked={direction === d}
                  onChange={() => setDirection(d)}
                  className="sr-only"
                />
                {DIRECTIONS[d].label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-2.5">
          <label htmlFor={ids.amount} className="block text-sm font-semibold text-ink">
            Amount in
          </label>
          <div className="relative">
            <input
              id={ids.amount}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/,/g, "").trim())}
              aria-invalid={!amountValid}
              aria-describedby={ids.amountHint}
              className={cn(fieldClass, "pr-16 text-lg font-semibold")}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm font-medium text-muted">
              {dir.tokenIn}
            </span>
          </div>
          <p id={ids.amountHint} className={cn("text-sm", amountValid ? "text-muted" : "text-rose-300")}>
            {amountValid ? "Positive number, up to 6 decimals." : "Enter a positive number with up to 6 decimals."}
          </p>
          <div role="group" aria-label="Preset amounts" className="grid grid-cols-4 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(p)}
                aria-pressed={amount === p}
                className="min-h-9 rounded-md bg-raised text-sm text-soft transition-colors hover:bg-edge hover:text-ink aria-pressed:bg-accent/15 aria-pressed:text-accent-strong"
              >
                {fmtAmount(Number(p))}
              </button>
            ))}
          </div>
        </div>

        <details className="group rounded-md bg-ground/60 px-3 py-2">
          <summary className="flex min-h-9 cursor-pointer items-center justify-between rounded-sm text-sm text-soft hover:text-ink">
            Agent and executor (optional)
            <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none">
              ▾
            </span>
          </summary>
          <div className="space-y-3 pt-2 pb-1">
            <AddressField id={ids.agent} label="Agent address" value={agent} onChange={setAgent} valid={agentValid} />
            <AddressField id={ids.executor} label="Executor address" value={executor} onChange={setExecutor} valid={executorValid} />
            <p className="text-xs text-muted">Empty fields use the example address {EXAMPLE_ADDRESS.slice(0, 10)}….</p>
          </div>
        </details>

        <button type="submit" disabled={!canRun} className={buttonClass("primary", "w-full disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted")}>
          {loading && <Spinner />}
          {loading ? "Checking…" : "Run preflight"}
        </button>
        <p className="text-xs leading-relaxed text-muted">
          Reads the live pool and the CEX reference. Nothing is sent on-chain. Rate limit: 30 quotes per minute per IP.
        </p>
      </form>

      <section aria-label="Result" aria-live="polite" aria-busy={loading} className="min-w-0 space-y-6">
        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-rose-400/10 p-4 sm:p-5">
            <p className="text-sm text-rose-100">{error}</p>
            <button type="submit" form={ids.form} disabled={!canRun} className={buttonClass("secondary", "min-h-9 px-4")}>
              Try again
            </button>
          </div>
        )}
        {!submitted && loading && <ResultSkeleton />}
        {!submitted && !loading && !error && <EmptyState onPick={quickRun} />}
        {submitted && (
          <div className={cn("space-y-6 transition-opacity motion-reduce:transition-none", loading && "opacity-60")}>
            <Result s={submitted} />
            <Panel as="section" labelledBy="curve-title">
              <PanelTitle id="curve-title">Cost vs order size · {DIRECTIONS[submitted.direction].label}</PanelTitle>
              <div className="mt-4">
                {curve ? (
                  <CostCurve data={curve} highlightUsd={submitted.result.metrics.notionalUsd} />
                ) : curveError ? (
                  <p className="text-sm text-rose-200">{curveError}</p>
                ) : (
                  <div className="h-56 animate-pulse rounded-md bg-raised motion-reduce:animate-none" aria-label="Loading curve" />
                )}
              </div>
            </Panel>
          </div>
        )}
      </section>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}

function EmptyState({ onPick }: { onPick: (amount: string) => void }) {
  return (
    <div className="rounded-lg bg-surface p-6 sm:p-8">
      <h2 className="text-xl font-semibold text-ink">Pick a size and run a preflight check</h2>
      <p className="mt-2 max-w-xl text-base leading-relaxed text-soft">
        You get the verdict the on-chain guard enforces, the cost split into fee, impact and deviation, the largest size
        that fits the policy, and a cost curve across order sizes.
      </p>
      <p className="mt-6 text-sm text-muted">Start with a common case:</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => onPick("50")} className={buttonClass("secondary")}>
          50 USDT, a typical swap
        </button>
        <button type="button" onClick={() => onPick("20000")} className={buttonClass("secondary")}>
          20,000 USDT, a large order
        </button>
      </div>
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="space-y-6 motion-safe:animate-pulse" aria-label="Reading the pool and the CEX reference">
      <div className="h-44 rounded-lg bg-surface" />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-40 rounded-lg bg-surface" />
        <div className="h-40 rounded-lg bg-surface" />
      </div>
      <p className="text-sm text-muted">Reading the pool and the CEX reference…</p>
    </div>
  );
}

function AddressField(props: { id: string; label: string; value: string; onChange: (v: string) => void; valid: boolean }) {
  const errId = `${props.id}-err`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={props.id} className="block text-sm text-soft">
        {props.label}
      </label>
      <input
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value.trim())}
        placeholder={EXAMPLE_ADDRESS}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={!props.valid}
        aria-describedby={props.valid ? undefined : errId}
        className={cn(fieldClass, "font-mono text-xs")}
      />
      {!props.valid && (
        <p id={errId} className="text-xs text-rose-300">
          Not a valid 0x address.
        </p>
      )}
    </div>
  );
}

const SEGMENTS = [
  { key: "fee", label: "LP fee", color: "bg-sky-400" },
  { key: "impact", label: "Price impact", color: "bg-amber-400" },
  { key: "dev", label: "Deviation vs CEX median", color: "bg-rose-400" },
] as const;

function Result({ s }: { s: Submitted }) {
  const { result: r } = s;
  const dir = DIRECTIONS[s.direction];
  const m = r.metrics;
  const copy = VERDICT_COPY[r.verdict.verdict];
  const tone = TONE_CLASSES[copy.tone];
  const totalUsd = m.totalCostBps === null ? null : (m.notionalUsd * m.totalCostBps) / 10_000;
  const out = Number(formatUnits(BigInt(m.amountOut), dir.decimalsOut));
  const suggested = m.suggestedMaxAmountIn === null ? null : Number(formatUnits(BigInt(m.suggestedMaxAmountIn), dir.decimalsIn));
  const partial = m.impactBps === null || r.verdict.verdict === "OUT_OF_RANGE";
  const unsignedReason =
    r.verdict.verdict !== "DEX" || !r.verdict.executable
      ? `Only executable "Execute on DEX" verdicts are signed. This one is "${copy.label}".`
      : (r.referenceError ?? "No fresh CEX reference to sign against.");

  const values = { fee: m.feeBps, impact: m.impactBps ?? 0, dev: m.adverseDevBps ?? 0 };
  const sum = values.fee + values.impact + values.dev;

  return (
    <div className="space-y-6">
      <div className={cn("rounded-lg p-6 sm:p-8", tone.card)}>
        <p className="text-sm text-soft">Verdict</p>
        <p className={cn("mt-1 flex items-center gap-3 text-4xl font-semibold tracking-tight sm:text-5xl", tone.badge)}>
          <span aria-hidden="true" className={cn("inline-block size-3.5 shrink-0 rounded-full", tone.dot)} />
          {copy.label}
        </p>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink">{copy.summary}</p>
        <p className="mt-2 text-sm text-soft">
          {fmtAmount(Number(s.amount), 6)} {dir.tokenIn} ≈ {fmtUsd(m.notionalUsd)}
          {partial ? " · output not shown (the order would only partially fill)" : ` → ~${fmtAmount(out, 4)} ${dir.tokenOut}`}
        </p>
        {r.verdict.failedChecks.length > 0 && (
          <div className="mt-4">
            <p className="text-sm text-soft">On-chain checks that would fail:</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {r.verdict.failedChecks.map((c) => (
                <li key={c} className="rounded-full bg-ground/60 px-3 py-1 text-sm text-ink">
                  {CHECK_COPY[c]}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Panel as="section" labelledBy="cost-title">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <PanelTitle id="cost-title">Cost breakdown</PanelTitle>
          <p className="text-right">
            <span className="block text-3xl font-semibold tracking-tight text-ink">{fmtBps(m.totalCostBps)}</span>
            <span className="text-sm text-soft">{totalUsd === null ? "USD cost not available" : `≈ ${fmtUsd(totalUsd)} on this order`}</span>
          </p>
        </div>
        {sum > 0 && (
          <div className="mt-5 flex h-4 gap-0.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
            {SEGMENTS.map((seg) =>
              values[seg.key] > 0 ? (
                <span key={seg.key} className={cn("h-full", seg.color)} style={{ width: `${(values[seg.key] / sum) * 100}%` }} />
              ) : null,
            )}
          </div>
        )}
        <dl className="mt-5 grid gap-4 sm:grid-cols-3">
          <CostItem color="bg-sky-400" label="LP fee" value={fmtBps(m.feeBps)} />
          <CostItem color="bg-amber-400" label="Price impact" value={fmtBps(m.impactBps)} />
          <CostItem
            color="bg-rose-400"
            label="Deviation vs CEX median"
            value={m.adverseDevBps === null ? "no reference" : fmtBps(m.adverseDevBps)}
            hint={m.devBps === null ? undefined : `DEX spot ${m.devBps > 0 ? "+" : ""}${m.devBps} bps vs CEX`}
          />
        </dl>
      </Panel>

      <div className="grid gap-6 sm:grid-cols-2">
        <Panel as="section" labelledBy="size-title">
          <PanelTitle id="size-title">Largest size within policy</PanelTitle>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-ink">
            {suggested === null ? (m.impactBps === null ? "–" : "This size already fits") : `${fmtAmount(suggested, 4)} ${dir.tokenIn}`}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Policy ({r.policySource === "guard" ? "on-chain" : "default"}): impact ≤ {r.policy.maxImpactBps} bps, deviation ≤{" "}
            {r.policy.maxDevBps} bps, quote age ≤ {r.policy.maxAge} s.
          </p>
        </Panel>
        <Panel as="section" labelledBy="att-title">
          <PanelTitle id="att-title">Attestation</PanelTitle>
          <p className="mt-3 flex items-center gap-2 text-2xl font-semibold tracking-tight text-ink">
            <span aria-hidden="true" className={cn("size-2.5 rounded-full", r.attested ? "bg-emerald-400" : "bg-muted")} />
            {r.attested ? "Signed (EIP-712)" : "Unsigned"}
          </p>
          {r.attested && r.signature ? (
            <div className="mt-2 space-y-2">
              <p className="flex items-center gap-2">
                <code className="truncate font-mono text-sm text-soft">{r.signature.slice(0, 22)}…</code>
                <CopyButton value={r.signature} label="Copy signature" />
              </p>
              <p className="text-sm leading-relaxed text-muted">GuardedRouter accepts it until it expires.</p>
            </div>
          ) : (
            <p className="mt-2 text-sm leading-relaxed break-words text-muted">{unsignedReason}</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

function CostItem({ color, label, value, hint }: { color: string; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-raised/60 p-3">
      <dt className="flex items-center gap-2 text-sm text-soft">
        <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", color)} />
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold text-ink">{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  );
}
