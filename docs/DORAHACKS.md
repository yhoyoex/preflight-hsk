# DoraHacks BUIDL form — copy/paste

Fill the placeholders `{{GUARD_ADDRESS}}`, `{{ROUTER_ADDRESS}}`, `{{TX_SUCCESS}}`, `{{TX_REVERT}}` (and the video link) before submitting.

## BUIDL name

Preflight

## Tagline (≤ 100 chars)

Tells AI agents what a swap costs before they send it — and reverts on-chain past their limits.

## Track

Track 1 — AI Agent Trading

## Short description

Preflight is an execution guard for AI trading agents on HSK Chain. Before a swap, it simulates the trade on the exact HSKSwap pool state, compares the price with HashKey Global, and returns a verdict (DEX / CEX / wait / reduce size) with the full cost. Executable quotes are signed (EIP-712) and enforced by an on-chain guard that reverts if the real outcome breaks the agent's policy. Available as an HTTP API, an MCP server and a reference agent.

## Long description

```markdown
## Problem

AI agents can call `swap()`, but they can't see what a swap will cost. On HSK Chain the main WHSK/USDT pool on HSKSwap looks deep (≈$839k TVL, 24 Nov 2026) but behaves thin:

- 30 days: only **2,136 swaps**, **≈$40.6k volume**, largest swap **$502**
- a **$10k** order costs **≈233 bps** of price impact on top of the 0.3% fee; **≈$4.24k** already reaches 100 bps
- median |DEX − CEX| gap: **40 bps**
- **no active arbitrage**: 72% of swaps that moved the price ≥5 bps did not recover even 50% within 24 h

An agent that sizes from TVL — or splits orders expecting the price to come back — overpays silently.

## Solution

**Preflight = off-chain quote + on-chain enforcement.**

1. **Quote** — `POST /api/quote` simulates the swap with BigInt Uniswap V3 math on the live pool state, reads a fair CEX price (median of the last 5 traded minutes on HashKey Global), and returns a verdict:
   `DEX` · `CEX` (another venue may be cheaper) · `TUNDA` (wait) · `KECILKAN` (reduce size, with max size that fits) · `NO_REFERENCE` · `OUT_OF_RANGE`, plus fee / impact / deviation / total cost in bps and USD.
2. **Sign** — only a `DEX` verdict with a fresh CEX price is signed as an EIP-712 `Quote` (random 256-bit nonce, short expiry).
3. **guardedSwap** — `GuardedRouter` verifies the quote via `ExecutionGuard` (signer, executor, expiry, nonce, per-agent policy), swaps, then re-checks actual impact, post-swap deviation and a fair-price floor. Anything outside policy reverts with a decoded custom error, e.g. a same-block front-run → `DeviationTooHigh(325, 200)`, an oversized order → `ImpactTooHigh(454, 100)`. The agent's reason is stored on-chain as `reasonHash`.

## For agents

- **MCP server** (stdio): `guard_quote`, `guard_check` (eth_call to the guard), `guarded_swap` (unsigned calldata; sends only when explicitly enabled, capped at $100 notional by default).
- **Reference agent**: price-guard agent with Claude Haiku sizing/reasoning and a deterministic fallback, dry-run by default, circuit breaker in live mode.
- **Playground** and **cost curve** ($50 → $20k) in the web app.
- **Execution-cost leaderboard**: replay of all 2,136 swaps in 30 days — 31 wallets, median execution cost 30.35 bps (mostly the fee).

## Evidence & honesty

- Pool simulation matches on-chain replay **exactly for 2,134/2,134** swaps (no tick crossing) and 1/1 tick-crossing swap; TypeScript impact equals the on-chain `PriceMath` result on a fork fixture.
- Research (`research/REPORT.md`): splitting an order saves a **median of 0** in this pool, so Preflight does **not** recommend splitting.
- Limits: the CEX price is attested by a **single trusted signer** today; research numbers are **in-sample (30 days)**; with a 100 bps trigger and 200 bps deviation cap the agent only executes in a 100–200 bps window. The arbitrage simulation is not robustly profitable and is not presented as a return claim.

## Deployed (HSK Chain mainnet, 177)

- ExecutionGuard: `{{GUARD_ADDRESS}}`
- GuardedRouter: `{{ROUTER_ADDRESS}}`
- Guarded swap (success): https://hsk.blockscout.com/tx/{{TX_SUCCESS}}
- Guarded swap (revert): https://hsk.blockscout.com/tx/{{TX_REVERT}}
```

## Tech stack

Solidity 0.8.24, Foundry, OpenZeppelin · TypeScript, viem, zod · Next.js 16, React 19, Tailwind · Model Context Protocol SDK · Anthropic Claude Haiku · Upstash Redis (optional rate limiting) · Vercel · Python (research backtests) · HSK Chain mainnet, HSKSwap (Uniswap V3), HashKey Global market data, Blockscout

## Links

- Demo app: https://preflight-hsk.vercel.app
- Playground: https://preflight-hsk.vercel.app/playground
- Leaderboard: https://preflight-hsk.vercel.app/leaderboard
- GitHub: https://github.com/yhoyoex/preflight-hsk
- Video: {{VIDEO_URL}}
- ExecutionGuard: https://hsk.blockscout.com/address/{{GUARD_ADDRESS}}
- GuardedRouter: https://hsk.blockscout.com/address/{{ROUTER_ADDRESS}}
- Success tx: https://hsk.blockscout.com/tx/{{TX_SUCCESS}}
- Revert tx: https://hsk.blockscout.com/tx/{{TX_REVERT}}

## Team

{{TEAM}} — fill in name(s), role(s) and contact as shown on DoraHacks.

## What's new during the hackathon

Everything in the repository was built during the hackathon:

- `ExecutionGuard`, `GuardedRouter`, `GuardConsumer` contracts with unit and mainnet-fork tests.
- BigInt Uniswap V3 simulation, CEX fair price, verdict engine and EIP-712 signer (`packages/core`).
- Quote / curve / leaderboard API, landing, playground and leaderboard pages (`apps/web`).
- MCP server (`packages/mcp`) and reference price-guard agent with on-chain `reasonHash` (`apps/agent`).
- 30-day on-chain research: price recovery, split-order simulation, DEX vs CEX gaps, arbitrage simulation (`research/`).
- Mainnet deployment of the guard and router: `{{GUARD_ADDRESS}}`, `{{ROUTER_ADDRESS}}`.
