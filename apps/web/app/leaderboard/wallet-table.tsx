"use client";

import type { WalletStats } from "@preflight/core";
import { useMemo, useState } from "react";
import { cn, linkClass } from "@/components/ui";
import { fmtBps, fmtInt, fmtUsd } from "@/lib/format";
import { BLOCKSCOUT, shortAddress } from "@/lib/leaderboard";

type Key = "swaps" | "volumeUsd" | "meanCostBps" | "medianCostBps" | "totalCostUsd";

const COLUMNS: { key: Key; label: string; fmt: (w: WalletStats) => string }[] = [
  { key: "swaps", label: "Swaps", fmt: (w) => fmtInt(w.swaps) },
  { key: "volumeUsd", label: "Volume", fmt: (w) => fmtUsd(w.volumeUsd) },
  { key: "meanCostBps", label: "Mean cost", fmt: (w) => fmtBps(w.meanCostBps) },
  { key: "medianCostBps", label: "Median cost", fmt: (w) => fmtBps(w.medianCostBps) },
  { key: "totalCostUsd", label: "Total execution cost", fmt: (w) => fmtUsd(w.totalCostUsd) },
];

/** Wallet table, sortable by any numeric column (click a header; click again to flip the order). */
export function WalletTable({ wallets }: { wallets: WalletStats[] }) {
  const [sort, setSort] = useState<{ key: Key; dir: "asc" | "desc" }>({ key: "totalCostUsd", dir: "desc" });
  const rows = useMemo(() => {
    // Wallets without a measurable cost (null) always sort last.
    const val = (w: WalletStats) => w[sort.key];
    return [...wallets].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
      return sort.dir === "asc" ? va - vb : vb - va;
    });
  }, [wallets, sort]);
  const current = COLUMNS.find((c) => c.key === sort.key)!;

  return (
    <div className="overflow-x-auto rounded-lg bg-surface">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <caption className="sr-only">
          Execution cost per wallet, sorted by {current.label.toLowerCase()}, {sort.dir === "desc" ? "highest" : "lowest"} first
        </caption>
        <thead className="text-muted">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">
              Wallet
            </th>
            {COLUMNS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className="px-2 py-2 text-right font-medium last:pr-3"
                >
                  <button
                    type="button"
                    onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === "desc" ? "asc" : "desc" }))}
                    className={cn(
                      "inline-flex min-h-9 items-center gap-1 rounded-md px-2 transition-colors hover:text-ink",
                      active && "text-ink",
                    )}
                  >
                    {c.label}
                    <span aria-hidden="true" className={cn("w-3 text-xs", !active && "opacity-0")}>
                      {sort.dir === "asc" ? "▲" : "▼"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((w, i) => (
            <tr key={w.wallet} className={cn("transition-colors hover:bg-raised", i % 2 === 0 && "bg-raised/40")}>
              <td className="px-5 py-3 whitespace-nowrap">
                {w.wallet === "unknown" ? (
                  <span className="text-muted">unknown</span>
                ) : (
                  <a
                    href={`${BLOCKSCOUT}/address/${w.wallet}`}
                    target="_blank"
                    rel="noreferrer"
                    className={cn("font-mono", linkClass)}
                    title={w.wallet}
                  >
                    {shortAddress(w.wallet)}
                    <span className="sr-only"> (wallet {w.wallet}, opens the explorer in a new tab)</span>
                  </a>
                )}
              </td>
              {COLUMNS.map((c) => (
                <td key={c.key} className={cn("px-4 py-3 text-right last:pr-6", sort.key === c.key ? "text-ink" : "text-soft")}>
                  {c.fmt(w)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
