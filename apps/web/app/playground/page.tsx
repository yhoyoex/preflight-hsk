import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { Playground } from "./playground";

export const metadata: Metadata = { title: "Playground" };

export default function PlaygroundPage() {
  return (
    <div className="space-y-10">
      <PageHeader
        title="Preflight playground"
        lead="Price a WHSK/USDT swap on HSKSwap the way an agent would: live pool state, the CEX median as reference, and the same verdict the on-chain guard enforces. Nothing is sent on-chain."
      />
      <Playground />
    </div>
  );
}
