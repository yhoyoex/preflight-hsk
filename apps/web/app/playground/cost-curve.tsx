"use client";

import type { VerdictKind } from "@preflight/core";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { VerdictBadge } from "@/components/ui";
import { fmtBps, fmtUsdSize } from "@/lib/format";
import { TONE_CLASSES, VERDICT_COPY } from "@/lib/verdict-copy";

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

type Point = CurveData["points"][number] & { totalCostBps: number };

const W = 640;
const H = 280;
const PAD = { l: 48, r: 16, t: 20, b: 36 };

function niceMax(v: number): number {
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
}

const usdTick = (u: number) => (u >= 1000 ? `$${u / 1000}k` : `$${u}`);

export function CostCurve({ data, highlightUsd }: { data: CurveData; highlightUsd: number }) {
  const hintId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const pts = data.points.filter((p): p is Point => p.totalCostBps !== null);
  const usds = data.points.map((p) => p.usd);
  const minU = Math.min(...usds);
  const maxU = Math.max(...usds);
  const limit = data.policy.maxImpactBps + (pts[0]?.feeBps ?? 30);
  const yMax = niceMax(Math.max(limit, ...pts.map((p) => p.totalCostBps)) * 1.05);
  const x = (u: number) => PAD.l + ((Math.log(u) - Math.log(minU)) / (Math.log(maxU) - Math.log(minU))) * (W - PAD.l - PAD.r);
  const y = (b: number) => H - PAD.b - (b / yMax) * (H - PAD.t - PAD.b);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.usd).toFixed(1)},${y(p.totalCostBps).toFixed(1)}`).join(" ");
  const area = pts.length > 1 ? `${path} L${x(pts.at(-1)!.usd).toFixed(1)},${y(0)} L${x(pts[0]!.usd).toFixed(1)},${y(0)} Z` : "";
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const showMarker = highlightUsd >= minU && highlightUsd <= maxU;
  const last = pts.at(-1);
  const summary = last
    ? `Total cost rises from ${fmtBps(pts[0]?.totalCostBps ?? null)} at ${fmtUsdSize(pts[0]?.usd ?? 0)} to ${fmtBps(last.totalCostBps)} at ${fmtUsdSize(last.usd)}.`
    : "No size in this range could be simulated.";

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || pts.length === 0) return;
    const sx = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(x(pts[i]!.usd) - sx) < Math.abs(x(pts[best]!.usd) - sx)) best = i;
    setActive(best);
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (pts.length === 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setActive((a) => Math.min(pts.length - 1, Math.max(0, (a ?? (step > 0 ? -1 : pts.length)) + step)));
    } else if (e.key === "Escape") setActive(null);
  }

  const a = active === null ? null : pts[active];

  return (
    <figure className="space-y-4">
      <div className="-mx-1 overflow-x-auto px-1">
      <div className="relative min-w-[30rem]">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-pan-x touch-pan-y rounded-md"
          role="img"
          tabIndex={0}
          aria-label={`Cost versus order size. ${summary}`}
          aria-describedby={hintId}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="stroke-edge/60" strokeWidth={1} />
              <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="fill-muted text-[11px]">
                {t}
              </text>
            </g>
          ))}
          {usds.map((u) => (
            <text key={u} x={x(u)} y={H - PAD.b + 20} textAnchor="middle" className="fill-muted text-[11px]">
              {usdTick(u)}
            </text>
          ))}
          {area && <path d={area} className="fill-accent/10" />}
          {limit <= yMax && (
            <g>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(limit)}
                y2={y(limit)}
                className="stroke-amber-400/80"
                strokeWidth={1.5}
                strokeDasharray="5 4"
              />
              <text x={PAD.l + 6} y={y(limit) - 7} className="fill-amber-300 text-[11px]">
                impact cap + fee ({limit} bps)
              </text>
            </g>
          )}
          {showMarker && (
            <g>
              <line
                x1={x(highlightUsd)}
                x2={x(highlightUsd)}
                y1={PAD.t}
                y2={H - PAD.b}
                className="stroke-soft"
                strokeWidth={1.5}
                strokeDasharray="2 3"
              />
              <text
                x={x(highlightUsd) + (x(highlightUsd) > W - 60 ? -4 : x(highlightUsd) < PAD.l + 40 ? 4 : 0)}
                y={PAD.t - 6}
                textAnchor={x(highlightUsd) > W - 60 ? "end" : x(highlightUsd) < PAD.l + 40 ? "start" : "middle"}
                className="fill-soft text-[11px]"
              >
                your order
              </text>
            </g>
          )}
          <path d={path} fill="none" className="stroke-accent" strokeWidth={2.5} strokeLinejoin="round" />
          {a && <line x1={x(a.usd)} x2={x(a.usd)} y1={PAD.t} y2={H - PAD.b} className="stroke-ink/40" strokeWidth={1} />}
          {pts.map((p, i) => (
            <circle
              key={p.usd}
              cx={x(p.usd)}
              cy={y(p.totalCostBps)}
              r={active === i ? 7 : 5}
              className={`${TONE_CLASSES[VERDICT_COPY[p.verdict].tone].fill} stroke-surface transition-[r] motion-reduce:transition-none`}
              strokeWidth={2.5}
            />
          ))}
        </svg>

        {a && (
          <div
            className={`pointer-events-none absolute z-10 w-max max-w-[14rem] -translate-x-1/2 rounded-md bg-raised px-3 py-2 text-xs text-soft shadow-lg shadow-black/40 ${
              y(a.totalCostBps) / H < 0.45 ? "translate-y-3" : "-translate-y-[calc(100%+0.75rem)]"
            }`}
            style={{
              left: `${Math.min(80, Math.max(20, (x(a.usd) / W) * 100))}%`,
              top: `${(y(a.totalCostBps) / H) * 100}%`,
            }}
          >
            <p className="text-sm font-semibold text-ink">
              {fmtUsdSize(a.usd)} · {fmtBps(a.totalCostBps)}
            </p>
            <p className="mt-0.5">
              fee {a.feeBps} · impact {a.impactBps ?? "–"} · deviation {a.adverseDevBps ?? "–"} bps
            </p>
            <VerdictBadge kind={a.verdict} className="mt-1.5" />
          </div>
        )}
      </div>
      </div>

      <p id={hintId} className="sr-only">
        Use the left and right arrow keys to step through the sizes.
      </p>
      <p aria-live="polite" className="sr-only">
        {a ? `${fmtUsdSize(a.usd)}: total ${fmtBps(a.totalCostBps)}, ${VERDICT_COPY[a.verdict].label}` : ""}
      </p>

      <figcaption className="text-sm leading-relaxed text-muted">
        Total cost in bps (fee + impact + deviation) by USD order size, log scale. Hover, tap or use the arrow keys for
        each size. Reference: {data.reference === "cex" ? "CEX median" : "DEX spot (CEX stale)"}. Unsigned, and uses the
        default policy; a quote uses the agent&apos;s on-chain policy when one is set.
      </figcaption>
      <details className="group">
        <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-md text-sm text-soft hover:text-ink">
          Show data
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="sr-only">Cost by order size</caption>
            <thead className="text-muted">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">Size</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Impact</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Total</th>
                <th scope="col" className="py-2 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody className="text-soft">
              {data.points.map((p, i) => (
                <tr key={p.usd} className={i % 2 === 0 ? "bg-raised/50" : undefined}>
                  <td className="py-2 pr-3 pl-2">{fmtUsdSize(p.usd)}</td>
                  <td className="py-2 pr-3 text-right">{fmtBps(p.impactBps)}</td>
                  <td className="py-2 pr-3 text-right">{fmtBps(p.totalCostBps)}</td>
                  <td className="py-2 pr-2">
                    <VerdictBadge kind={p.verdict} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
