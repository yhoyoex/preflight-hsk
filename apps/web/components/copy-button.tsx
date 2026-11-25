"use client";

import { useEffect, useState } from "react";
import { cn } from "./ui";

/** Copies `value` to the clipboard and announces the result to screen readers. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(t);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={cn(
        "inline-flex min-h-8 shrink-0 items-center rounded-md bg-raised px-2.5 text-xs font-medium text-soft transition-colors hover:bg-edge hover:text-ink",
        className,
      )}
    >
      <span aria-hidden="true">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
      <span role="status" className="sr-only">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
