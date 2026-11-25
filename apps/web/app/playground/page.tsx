import type { Metadata } from "next";
import { Playground } from "./playground";

export const metadata: Metadata = { title: "Playground · Preflight" };

export default function PlaygroundPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Preflight playground</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Price a WHSK/USDT swap on HSKSwap the way an agent would: live pool state, the CEX median as reference, and
          the same verdict the on-chain guard enforces. Nothing is sent on-chain.
        </p>
      </header>
      <Playground />
    </div>
  );
}
