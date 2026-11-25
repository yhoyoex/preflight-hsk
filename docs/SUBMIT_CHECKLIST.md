# Submission checklist — HSK Chain Horizon Hackathon (Seoul), Track 1

**Deadline: 3 Dec 2026 13:00 KST (= 11:00 WIB).** Internal target: submitted by **3 Dec 2026 11:00 WIB at the latest**, ideally 2 Dec.

Placeholders used in `README.md`, `docs/VIDEO_SCRIPT.md`, `docs/DORAHACKS.md`:

| Placeholder | Value | Filled? |
|---|---|---|
| `{{GUARD_ADDRESS}}` | ExecutionGuard on mainnet 177 | [ ] |
| `{{ROUTER_ADDRESS}}` | GuardedRouter on mainnet 177 | [ ] |
| ~~`{{WEB_URL}}`~~ | https://preflight-hsk.vercel.app (already filled in) | [x] |
| `{{TX_SUCCESS}}` | tx hash of a successful `guardedSwap` | [ ] |
| `{{TX_REVERT}}` | tx hash of a reverted `guardedSwap` | [ ] |
| ~~`{{REPO_URL}}`~~ | https://github.com/yhoyoex/preflight-hsk (already filled in) | [x] |
| `{{VIDEO_URL}}` | YouTube/Loom link (DORAHACKS.md only) | [ ] |
| `{{TEAM}}` | team info (DORAHACKS.md only) | [ ] |

Find leftovers: `grep -rn "{{" README.md docs/`

## 1. Repository

- [ ] `pnpm install && pnpm -r test && pnpm -r typecheck` pass.
- [ ] `cd contracts && forge build && forge test` pass; fork tests pass with `--fork-url https://mainnet.hsk.xyz --fork-block-number 30609500`.
- [ ] `contracts/lib/` (forge-std, openzeppelin-contracts) is included in the repo or as git submodules, so a clean clone builds.
- [ ] No secrets committed: `.env*` ignored (only `.env.example`), no private keys in history (`git log -p | grep -i private_key`).
- [x] Initial commit + push to https://github.com/yhoyoex/preflight-hsk; repo is **public**.
- [ ] Clean-clone test: clone into a temp dir, follow README Quickstart.

## 2. Deploy contracts (HSK Chain mainnet, 177)

- [ ] Attestor key generated and stored in the secret manager (never in the repo); `ATTESTOR_ADDRESS` set.
- [ ] Dry run: `cd contracts && forge script script/Deploy.s.sol --rpc-url $HSK_RPC_URL`.
- [ ] Broadcast after review (`--broadcast`); record `ExecutionGuard` → `{{GUARD_ADDRESS}}`, `GuardedRouter` → `{{ROUTER_ADDRESS}}`.
- [ ] If `GUARD_OWNER` ≠ deployer: owner calls `acceptOwnership()`.
- [ ] Verify both contracts on Blockscout (`https://hsk.blockscout.com`) — source visible, "Contract" tab green.

## 3. Deploy web (Vercel)

- [ ] Env: `ATTESTOR_PRIVATE_KEY`, `GUARD_ADDRESS`, `HSK_CHAIN_ID=177`, `HSK_RPC_URL`, `NEXT_PUBLIC_GUARD_ADDRESS`, `NEXT_PUBLIC_ROUTER_ADDRESS`, optional `UPSTASH_REDIS_REST_URL`/`_TOKEN`.
- [ ] `pnpm --filter web build` passes locally; production deploy → https://preflight-hsk.vercel.app (redeploy after setting mainnet addresses).
- [ ] Landing shows contract addresses with Blockscout links (not "deploying soon").
- [ ] `/playground`: 50 USDT → `DEX` signed; 20,000 USDT → not signed.
- [ ] `/leaderboard` and `/api/leaderboard` load.
- [ ] `curl -X POST https://preflight-hsk.vercel.app/api/quote ...` returns verdict; 31 rapid requests from one IP → 429.

## 4. On-chain demo transactions

- [ ] Fund agent wallet with a small amount of HSK (gas) and USDT (≤ $100).
- [ ] Successful `guardedSwap` via agent `--live` or MCP `guarded_swap` → `{{TX_SUCCESS}}`; `GuardedSwap` event + `reasonHash` visible on Blockscout.
- [ ] Reverted `guardedSwap` → `{{TX_REVERT}}` (e.g. expired/over-policy quote, or a policy tightened via `setPolicy`). If no honest mainnet revert is available, show the anvil front-run demo (`DeviationTooHigh(325, 200)`) and label it "mainnet fork" everywhere.
- [ ] Optional: re-run `pnpm snapshot` with `ROUTER_ADDRESS` set so the leaderboard shows the `GuardedSwap` feed.

## 5. MCP

- [ ] `claude mcp add preflight -e PREFLIGHT_API_URL=https://preflight-hsk.vercel.app -e GUARD_ADDRESS={{GUARD_ADDRESS}} -e ROUTER_ADDRESS={{ROUTER_ADDRESS}} -- node …/packages/mcp/bin/preflight-mcp.mjs`
- [ ] `guard_quote` and `guard_check` work against production.

## 6. Video (≤ 3 min)

- [ ] Record per `docs/VIDEO_SCRIPT.md`; length ≤ 3:00; no secrets on screen.
- [ ] Upload (public/unlisted) → `{{VIDEO_URL}}`; open in a private window to confirm it plays.

## 7. Link check

- [ ] Every link in README, DORAHACKS.md and the DoraHacks form opens (repo, web, playground, leaderboard, video, 2 addresses, 2 txs).
- [ ] `grep -rn "{{" README.md docs/` returns only this checklist.

## 8. Submit on DoraHacks

- [ ] BUIDL created with fields from `docs/DORAHACKS.md`; Track 1 — AI Agent Trading selected.
- [ ] Logo/cover image and screenshots (`docs/screens/`) uploaded.
- [ ] BUIDL **submitted to the hackathon** (not just saved as draft) before **3 Dec 2026 11:00 WIB**.
- [ ] Screenshot of the confirmation page saved.
