import type { VerdictKind } from "@preflight/core";
import { fmtBps, fmtUsd } from "@/lib/format";
import { VERDICT_COPY } from "@/lib/verdict-copy";

/** /api/curve response (bigints arrive as strings). */
export interface CurveData {
  zeroForOne: boolean;
  reference: "cex" | "dex-spot";
  policy: { maxImpactBps: number; maxDevBps: number };
  points: {
    usd: number;
    amountIn: string;
    verdict: VerdictKind;
    feeBps: number;
    impactBps: number | null;
    adverseDevBps: number | null;
    totalCostBps: number | null;
  }[];
}

const TONE_FILL = { go: "fill-emerald-400", caution: "fill-amber-400", info: "fill-sky-400", stop: "fill-rose-400" } as const;

const W = 640;
const H = 260;
const PAD = { l: 52, r: 16, t: 16, b: 36 };

function niceMax(v: number): number {
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
}

const usdTick = (u: number) => (u >= 1000 ? `$${u / 1000}k` : `$${u}`);

export function CostCurve({ data, highlightUsd }: { data: CurveData; highlightUsd: number }) {
  const pts = data.points.filter((p): p is typeof p & { totalCostBps: number } => p.totalCostBps !== null);
  const usds = data.points.map((p) => p.usd);
  const minU = Math.min(...usds);
  const maxU = Math.max(...usds);
  const limit = data.policy.maxImpactBps + (pts[0]?.feeBps ?? 30);
  const yMax = niceMax(Math.max(limit, ...pts.map((p) => p.totalCostBps)) * 1.05);
  const x = (u: number) => PAD.l + ((Math.log(u) - Math.log(minU)) / (Math.log(maxU) - Math.log(minU))) * (W - PAD.l - PAD.r);
  const y = (b: number) => H - PAD.b - (b / yMax) * (H - PAD.t - PAD.b);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.usd).toFixed(1)},${y(p.totalCostBps).toFixed(1)}`).join(" ");
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const showMarker = highlightUsd >= minU && highlightUsd <= maxU;
  const last = pts.at(-1);
  const summary = last
    ? `Total cost rises from ${fmtBps(pts[0]?.totalCostBps ?? null)} at ${fmtUsd(pts[0]?.usd ?? 0)} to ${fmtBps(last.totalCostBps)} at ${fmtUsd(last.usd)}.`
    : "No size in this range could be simulated.";

  return (
    <figure className="mt-4 space-y-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Cost versus order size. ${summary}`}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-zinc-800" strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="fill-zinc-400 text-[11px]">
              {t}
            </text>
          </g>
        ))}
        {usds.map((u) => (
          <text key={u} x={x(u)} y={H - PAD.b + 18} textAnchor="middle" className="fill-zinc-400 text-[11px]">
            {usdTick(u)}
          </text>
        ))}
        {limit <= yMax && (
          <g>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(limit)}
              y2={y(limit)}
              className="stroke-amber-400/70"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            <text x={PAD.l + 6} y={y(limit) - 6} className="fill-amber-300 text-[11px]">
              impact cap + fee ({limit} bps)
            </text>
          </g>
        )}
        {showMarker && (
          <line
            x1={x(highlightUsd)}
            x2={x(highlightUsd)}
            y1={PAD.t}
            y2={H - PAD.b}
            className="stroke-zinc-400"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
        )}
        <path d={path} fill="none" className="stroke-emerald-400" strokeWidth={2} />
        {pts.map((p) => (
          <circle
            key={p.usd}
            cx={x(p.usd)}
            cy={y(p.totalCostBps)}
            r={4.5}
            className={`${TONE_FILL[VERDICT_COPY[p.verdict].tone]} stroke-zinc-950`}
            strokeWidth={2}
          >
            <title>{`${fmtUsd(p.usd)}: ${fmtBps(p.totalCostBps)} · ${VERDICT_COPY[p.verdict].label}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="text-xs text-zinc-400">
        Total cost in bps (fee + impact + deviation) by USD order size, log scale.{" "}
        {showMarker && "Dotted line: your order. "}
        Reference: {data.reference === "cex" ? "CEX median" : "DEX spot (CEX stale)"}. Unsigned, and uses the default
        policy; a quote uses the agent&apos;s on-chain policy when one is set.
      </figcaption>
      <details>
        <summary className="cursor-pointer rounded-sm text-xs text-zinc-300 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-emerald-400">
          Show data
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-xs">
            <thead className="text-zinc-400">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">Size</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Impact</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Total</th>
                <th scope="col" className="py-1.5 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 font-mono text-zinc-300">
              {data.points.map((p) => (
                <tr key={p.usd}>
                  <td className="py-1.5 pr-3">{fmtUsd(p.usd)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtBps(p.impactBps)}</td>
                  <td className="py-1.5 pr-3 text-right">{fmtBps(p.totalCostBps)}</td>
                  <td className="py-1.5 font-sans">{VERDICT_COPY[p.verdict].label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
