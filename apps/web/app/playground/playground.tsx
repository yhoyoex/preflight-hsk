"use client";

import type { RouterCheck, VerdictKind } from "@preflight/core";
import { useCallback, useId, useState, type FormEvent } from "react";
import { formatUnits, isAddress } from "viem";
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

export function Playground() {
  const ids = { amount: useId(), agent: useId(), executor: useId(), amountHint: useId() };
  const [direction, setDirection] = useState<Direction>("usdt");
  const [amount, setAmount] = useState("1000");
  const [agent, setAgent] = useState("");
  const [executor, setExecutor] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [curves, setCurves] = useState<Partial<Record<Direction, CurveData>>>({});
  const [curveError, setCurveError] = useState<string | null>(null);

  const amountValid = /^\d{1,15}(\.\d{1,6})?$/.test(amount) && Number(amount) > 0;
  const agentValid = agent === "" || isAddress(agent);
  const executorValid = executor === "" || isAddress(executor);

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!amountValid || !agentValid || !executorValid) return;
      const dir = DIRECTIONS[direction];
      setLoading(true);
      setError(null);
      const quoteReq = postJson<QuoteResult>("/api/quote", {
        agent: agent || EXAMPLE_ADDRESS,
        executor: executor || agent || EXAMPLE_ADDRESS,
        zeroForOne: dir.zeroForOne,
        amountIn: amount,
      });
      // The curve only depends on direction; fetch once per direction (it shares the quote rate limit).
      const curveReq = curves[direction] ? null : postJson<CurveData>("/api/curve", { zeroForOne: dir.zeroForOne });
      const [q, c] = await Promise.allSettled([quoteReq, curveReq]);
      if (q.status === "fulfilled") setSubmitted({ direction, amount, result: q.value });
      else setError((q.reason as Error).message);
      if (c.status === "fulfilled" && c.value) {
        const data = c.value;
        setCurves((prev) => ({ ...prev, [direction]: data }));
        setCurveError(null);
      } else if (c.status === "rejected") setCurveError((c.reason as Error).message);
      setLoading(false);
    },
    [agent, amount, amountValid, agentValid, curves, direction, executor, executorValid],
  );

  const dir = DIRECTIONS[direction];
  const curve = submitted ? curves[submitted.direction] : undefined;

  return (
    <div className="grid gap-8 lg:grid-cols-[20rem_1fr]">
      <form onSubmit={onSubmit} noValidate className="space-y-6 self-start rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-zinc-100">Direction</legend>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(DIRECTIONS) as Direction[]).map((d) => (
              <label
                key={d}
                className="cursor-pointer rounded-md border border-zinc-700 px-3 py-2 text-center text-sm text-zinc-300 has-checked:border-emerald-400 has-checked:bg-emerald-500/10 has-checked:text-zinc-50 has-focus-visible:outline-2 has-focus-visible:outline-emerald-400"
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

        <div className="space-y-2">
          <label htmlFor={ids.amount} className="block text-sm font-medium text-zinc-100">
            Amount in ({dir.tokenIn})
          </label>
          <input
            id={ids.amount}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/,/g, "").trim())}
            aria-invalid={!amountValid}
            aria-describedby={ids.amountHint}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-50 focus-visible:border-emerald-400 focus-visible:outline-2 focus-visible:outline-emerald-400 aria-invalid:border-rose-400"
          />
          <p id={ids.amountHint} className={`text-xs ${amountValid ? "text-zinc-400" : "text-rose-300"}`}>
            {amountValid ? "Positive number, up to 6 decimals." : "Enter a positive number with up to 6 decimals."}
          </p>
          <div role="group" aria-label="Preset amounts" className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(p)}
                aria-pressed={amount === p}
                className="rounded-md border border-zinc-700 px-2.5 py-1 font-mono text-xs text-zinc-300 hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-emerald-400 aria-pressed:border-emerald-400 aria-pressed:text-zinc-50"
              >
                {fmtAmount(Number(p))}
              </button>
            ))}
          </div>
        </div>

        <details className="group space-y-3">
          <summary className="cursor-pointer rounded-sm text-sm text-zinc-300 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-400">
            Agent &amp; executor (optional)
          </summary>
          <AddressField id={ids.agent} label="Agent address" value={agent} onChange={setAgent} valid={agentValid} />
          <AddressField
            id={ids.executor}
            label="Executor address"
            value={executor}
            onChange={setExecutor}
            valid={executorValid}
          />
          <p className="text-xs text-zinc-400">Empty fields use the example address {EXAMPLE_ADDRESS.slice(0, 10)}….</p>
        </details>

        <button
          type="submit"
          disabled={loading || !amountValid || !agentValid || !executorValid}
          className="w-full rounded-md bg-emerald-500 px-4 py-2.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {loading ? "Checking…" : "Run preflight"}
        </button>
      </form>

      <section aria-label="Result" aria-live="polite" aria-busy={loading} className="min-w-0 space-y-6">
        {error && (
          <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
            {error}
          </p>
        )}
        {!submitted && !error && (
          <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-400">
            {loading ? "Reading the pool and the CEX reference…" : "Pick a direction and a size, then run a preflight check."}
          </div>
        )}
        {submitted && (
          <div className={`space-y-6 transition-opacity motion-reduce:transition-none ${loading ? "opacity-60" : ""}`}>
            <Result s={submitted} />
            <div className="rounded-lg border border-zinc-800 p-5">
              <h2 className="text-sm font-semibold text-zinc-100">Cost vs order size · {DIRECTIONS[submitted.direction].label}</h2>
              {curve ? (
                <CostCurve data={curve} highlightUsd={submitted.result.metrics.notionalUsd} />
              ) : (
                <p className="mt-3 text-sm text-zinc-400">{curveError ?? "Loading curve…"}</p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function AddressField(props: { id: string; label: string; value: string; onChange: (v: string) => void; valid: boolean }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={props.id} className="block text-xs font-medium text-zinc-300">
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
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-50 placeholder:text-zinc-600 focus-visible:border-emerald-400 focus-visible:outline-2 focus-visible:outline-emerald-400 aria-invalid:border-rose-400"
      />
      {!props.valid && <p className="text-xs text-rose-300">Not a valid 0x address.</p>}
    </div>
  );
}

function Result({ s }: { s: Submitted }) {
  const { result: r } = s;
  const dir = DIRECTIONS[s.direction];
  const m = r.metrics;
  const copy = VERDICT_COPY[r.verdict.verdict];
  const tone = TONE_CLASSES[copy.tone];
  const totalUsd = m.totalCostBps === null ? null : (m.notionalUsd * m.totalCostBps) / 10_000;
  const out = Number(formatUnits(BigInt(m.amountOut), dir.decimalsOut));
  const suggested = m.suggestedMaxAmountIn === null ? null : Number(formatUnits(BigInt(m.suggestedMaxAmountIn), dir.decimalsIn));
  const unsignedReason =
    r.verdict.verdict !== "DEX" || !r.verdict.executable
      ? `Only executable "Execute on DEX" verdicts are signed. This one is "${copy.label}".`
      : (r.referenceError ?? "No fresh CEX reference to sign against.");

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-6 ${tone.card}`}>
        <p className="text-xs uppercase tracking-widest text-zinc-400">Verdict</p>
        <p className={`mt-1 flex items-center gap-3 text-3xl font-semibold tracking-tight sm:text-4xl ${tone.badge}`}>
          <span aria-hidden="true" className={`inline-block size-3 rounded-full ${tone.dot}`} />
          {copy.label}
        </p>
        <p className="mt-3 text-sm text-zinc-300">{copy.summary}</p>
        <p className="mt-1 text-sm text-zinc-400">
          {fmtAmount(Number(s.amount), 6)} {dir.tokenIn} ≈ {fmtUsd(m.notionalUsd)}
          {m.impactBps === null || r.verdict.verdict === "OUT_OF_RANGE"
            ? " · output not shown (the order would only partially fill)"
            : ` → ~${fmtAmount(out, 4)} ${dir.tokenOut}`}
        </p>
        {r.verdict.failedChecks.length > 0 && (
          <p className="mt-1 text-sm text-zinc-400">On-chain checks that would fail: {r.verdict.failedChecks.map((c) => CHECK_COPY[c]).join("; ")}.</p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 p-5">
          <h2 className="text-sm font-semibold text-zinc-100">Cost breakdown</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="LP fee" value={fmtBps(m.feeBps)} />
            <Row label="Price impact" value={fmtBps(m.impactBps)} />
            <Row
              label="Deviation vs CEX median"
              value={m.adverseDevBps === null ? "no reference" : fmtBps(m.adverseDevBps)}
              hint={m.devBps === null ? undefined : `DEX spot ${m.devBps > 0 ? "+" : ""}${m.devBps} bps vs CEX`}
            />
            <div className="border-t border-zinc-800 pt-2">
              <Row label="Total" value={fmtBps(m.totalCostBps)} strong />
              <Row label="Total in USD" value={totalUsd === null ? "–" : fmtUsd(totalUsd)} strong />
            </div>
          </dl>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-800 p-5">
            <h2 className="text-sm font-semibold text-zinc-100">Largest size within policy</h2>
            <p className="mt-2 text-lg font-semibold text-zinc-50">
              {suggested === null
                ? m.impactBps === null
                  ? "–"
                  : "This size already fits"
                : `${fmtAmount(suggested, 4)} ${dir.tokenIn}`}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              Policy ({r.policySource === "guard" ? "on-chain" : "default"}): impact ≤ {r.policy.maxImpactBps} bps, deviation ≤{" "}
              {r.policy.maxDevBps} bps, quote age ≤ {r.policy.maxAge} s.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800 p-5">
            <h2 className="text-sm font-semibold text-zinc-100">Attestation</h2>
            <p className={`mt-2 text-sm font-medium ${r.attested ? "text-emerald-300" : "text-zinc-200"}`}>
              {r.attested ? "Signed quote (EIP-712)" : "Unsigned"}
            </p>
            <p className="mt-1 break-words text-xs text-zinc-400">
              {r.attested && r.signature
                ? `Signature ${r.signature.slice(0, 18)}… — GuardedRouter accepts it until it expires.`
                : unsignedReason}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-zinc-400">
        {label}
        {hint && <span className="block text-xs text-zinc-400">{hint}</span>}
      </dt>
      <dd className={`font-mono ${strong ? "font-semibold text-zinc-50" : "text-zinc-200"}`}>{value}</dd>
    </div>
  );
}
