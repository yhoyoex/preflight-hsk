// LLM proposes a size inside the deterministic bounds + a 1–2 sentence reason. It cannot raise the size above the
// strategy's max and has no way around the attestor/ExecutionGuard; any failure falls back to the deterministic plan.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Decision } from "./strategy.ts";

/** Latest Haiku in @anthropic-ai/sdk 1.14.0's Model union; override with AGENT_LLM_MODEL. */
export const DEFAULT_MODEL = "claude-haiku-5-5";
const TOOL = "propose_trade";
export const LLM_TIMEOUT_MS = 15_000;
export const LLM_MAX_RETRIES = 1;

export interface Proposal {
  amountIn: number;
  reason: string;
  source: "llm" | "fallback";
  /** Set when the LLM answer was clamped or rejected. */
  note?: string;
}

export interface ProposalContext {
  decision: Decision;
  refPrice: number;
  tokenIn: "WHSK" | "USDT";
}

export interface Proposer {
  propose(ctx: ProposalContext): Promise<Proposal>;
}

export function fallbackProposal(ctx: ProposalContext, note?: string): Proposal {
  const d = ctx.decision;
  const dir = d.sell ? "above" : "below";
  return {
    amountIn: d.maxAmountIn,
    reason:
      `DEX ${Math.abs(d.gapBps).toFixed(0)} bps ${dir} CEX med5 (${ctx.refPrice.toFixed(5)}); ` +
      `${d.sell ? "sell" : "buy"} WHSK with ${d.maxAmountIn.toFixed(4)} ${ctx.tokenIn} per size_trade (edge ≈ $${d.edgeUsd.toFixed(2)}).`,
    source: "fallback",
    ...(note ? { note } : {}),
  };
}

const Answer = z.object({ amountIn: z.number().finite().positive(), reason: z.string().min(10).max(400) });

/** Minimal surface of `anthropic.messages.create` used here (mockable in tests). */
export type CreateMessage = (body: Anthropic.MessageCreateParamsNonStreaming) => Promise<Pick<Anthropic.Message, "content">>;

export function llmProposer(create: CreateMessage, model = DEFAULT_MODEL): Proposer {
  return {
    async propose(ctx) {
      const d = ctx.decision;
      try {
        const msg = await create({
          model,
          max_tokens: 300,
          system:
            "You size a single WHSK/USDT swap on HashKey Chain for a price-guard agent. " +
            "Pick amountIn within [minAmountIn, maxAmountIn] (tokenIn units). Smaller is fine when the edge is thin. " +
            "Write the reason in English, 1-2 sentences, citing the gap and size. Call the tool exactly once.",
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                tokenIn: ctx.tokenIn,
                side: d.sell ? "sell WHSK (DEX above CEX)" : "buy WHSK (DEX below CEX)",
                gapBps: Number(d.gapBps.toFixed(1)),
                dexPrice: d.dexPrice,
                cexMed5: ctx.refPrice,
                minAmountIn: d.minAmountIn,
                maxAmountIn: d.maxAmountIn,
                expectedEdgeUsdAtMax: Number(d.edgeUsd.toFixed(4)),
                gasUsd: Number(d.gasUsd.toFixed(4)),
              }),
            },
          ],
          tools: [
            {
              name: TOOL,
              description: "Propose the trade size and a short reason.",
              input_schema: {
                type: "object",
                properties: {
                  amountIn: { type: "number", description: "tokenIn units within the given bounds" },
                  reason: { type: "string", description: "1-2 sentences, English" },
                },
                required: ["amountIn", "reason"],
              },
            },
          ],
          tool_choice: { type: "tool", name: TOOL },
        });
        const block = msg.content.find((b) => b.type === "tool_use" && b.name === TOOL);
        if (!block || block.type !== "tool_use") return fallbackProposal(ctx, "llm: no tool call");
        const parsed = Answer.safeParse(block.input);
        if (!parsed.success) return fallbackProposal(ctx, "llm: invalid answer");
        const { amountIn, reason } = parsed.data;
        const clamped = Math.min(Math.max(amountIn, d.minAmountIn), d.maxAmountIn);
        return {
          amountIn: clamped,
          reason: reason.trim(),
          source: "llm",
          ...(clamped !== amountIn ? { note: `llm size ${amountIn} clamped to ${clamped}` } : {}),
        };
      } catch (err) {
        return fallbackProposal(ctx, `llm error: ${err instanceof Error ? err.name : "unknown"}`);
      }
    },
  };
}

export const deterministicProposer: Proposer = { propose: async (ctx) => fallbackProposal(ctx) };

/** LLM when ANTHROPIC_API_KEY is set, otherwise the deterministic fallback. */
export function proposerFromEnv(env: NodeJS.ProcessEnv = process.env): Proposer {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return deterministicProposer;
  // Bounded so a slow API cannot stall the per-minute tick; on failure the deterministic fallback is used.
  const client = new Anthropic({ apiKey: key, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });
  return llmProposer((body) => client.messages.create(body), env.AGENT_LLM_MODEL?.trim() || DEFAULT_MODEL);
}
