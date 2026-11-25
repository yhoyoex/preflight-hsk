# Preflight — demo video script (≤ 3:00)

Target length 2:50. Narration is plain text, ready for TTS (numbers are written the way they should be spoken).
Live app: https://preflight-hsk.vercel.app. Placeholders to fill before recording: `{{GUARD_ADDRESS}}`, `{{ROUTER_ADDRESS}}`, `{{TX_SUCCESS}}`, `{{TX_REVERT}}`.
Reference screenshots: [`docs/screens/`](screens/).

## Timeline

| Time | Shot | Narration |
|---|---|---|
| 0:00–0:15 | **Landing** `https://preflight-hsk.vercel.app/` — headline, then scroll to the quote → sign → guardedSwap flow. ([landing.png](screens/landing.png)) | AI agents can send swaps, but they can't see what a swap will cost. Preflight tells an agent the cost before it sends, and reverts on-chain when the cost goes past its limits. |
| 0:15–0:40 | Landing "problem" section; overlay the four numbers one by one: *$839k TVL*, *2,136 swaps / 30 days*, *largest swap $502*, *72% no recovery*. | The WHSK to USDT pool on HSKSwap shows about eight hundred thirty-nine thousand dollars of liquidity. But in thirty days it saw only two thousand one hundred thirty-six swaps, and the largest was five hundred two dollars. After a price-moving swap, seventy-two percent did not recover even halfway within a day. Nobody arbitrages this pool back. |
| 0:40–1:05 | **Playground**, buy with **50 USDT** → verdict `DEX`, cost breakdown (fee, impact, deviation), "signed" badge. ([playground-50.png](screens/playground-50.png)) | Here is the playground. A fifty dollar buy: Preflight simulates the swap on the exact pool state, compares the price to HashKey Global, and returns verdict DEX. The cost is basically the thirty basis point fee. Because it is within policy, the quote is signed. |
| 1:05–1:30 | Playground, change amount to **20,000 USDT** → verdict changes (not signed); point at "max size within policy". ([playground-20000.png](screens/playground-20000.png)) | Now twenty thousand dollars. Same pool, very different answer. Price impact is far past the agent's one hundred basis point limit, so Preflight does not sign. It suggests another venue or a smaller size, and tells the agent the largest size that still fits its policy. |
| 1:30–1:45 | Scroll to the **cost curve** (cost vs. order size, $50 to $20k). | The curve shows why. Ten thousand dollars costs about two hundred thirty-three basis points of impact. And splitting the order doesn't help here: with no arbitrage, the median saving from splitting is zero. So Preflight never recommends splitting. |
| 1:45–2:05 | **MCP in a client** (Claude Desktop or Claude Code): user asks "What would it cost to buy 50 USDT of WHSK?" → `guard_quote` tool call → answer; then `guard_check`. | Agents use it as MCP tools. guard quote returns the verdict and cost. guard check calls the on-chain guard to verify the signed quote. guarded swap prepares the transaction, and only sends it when execution is explicitly enabled. |
| 2:05–2:20 | **Blockscout — success**: `https://hsk.blockscout.com/tx/{{TX_SUCCESS}}` — show `GuardedSwap` event / `reasonHash`. | On HSK Chain mainnet, the agent executes through the Guarded Router. The guard checks the signature, the nonce, the impact and the deviation, swaps, and then checks the real outcome again. The agent's reason is recorded on-chain as a hash. |
| 2:20–2:35 | **Blockscout — revert**: `https://hsk.blockscout.com/tx/{{TX_REVERT}}` (or terminal of `pnpm start --scenario revert`) showing `DeviationTooHigh(325, 200)`. | And when the price moves between quote and execution, for example a bot front-runs the agent in the same block, the guard reverts with Deviation Too High: three hundred twenty-five basis points against a limit of two hundred. The agent pays gas, not the pushed price. |
| 2:35–2:48 | **Leaderboard** `https://preflight-hsk.vercel.app/leaderboard` ([leaderboard.png](screens/leaderboard.png)). | The leaderboard replays all two thousand one hundred thirty-six swaps from the last thirty days: thirty-one wallets, median execution cost thirty point three five basis points, mostly the pool fee. |
| 2:48–3:00 | Back to landing; show repo URL `https://github.com/yhoyoex/preflight-hsk` and contract address `{{GUARD_ADDRESS}}`. | One honest limit: the CEX price comes from a single trusted attestor today. Preflight: know the cost before you swap, and enforce it on-chain. |

## Shot checklist

- [ ] Landing page (desktop, dark theme), contract addresses visible (not "deploying soon").
- [ ] Playground: 50 USDT buy → `DEX`, signed.
- [ ] Playground: 20,000 USDT → not signed, max size within policy shown.
- [ ] Cost curve visible on screen ≥ 5 s.
- [ ] MCP client: `guard_quote` and `guard_check` calls visible, `PREFLIGHT_API_URL=https://preflight-hsk.vercel.app`.
- [ ] Blockscout success tx `{{TX_SUCCESS}}`.
- [ ] Blockscout revert tx `{{TX_REVERT}}` (or anvil terminal output with `DeviationTooHigh(325, 200)`; say "on a mainnet fork" if using anvil).
- [ ] Leaderboard summary cards.
- [ ] No private keys, `.env` files or API keys on screen.

## Notes for recording

- Do not show or say "+2.1% per month" — the arbitrage backtest is in-sample and not a return claim.
- Say "execution cost", not "loss", for leaderboard numbers.
- If the live verdict for 20,000 USDT differs from the screenshot (pool state changes), narrate what is on screen; the key point is "not signed" plus the suggested max size.
