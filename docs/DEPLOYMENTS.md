# Deployments

## Mainnet (HSK Chain, chain 177)

Pending (waiting for gas funds). Explorer: https://hsk.blockscout.com

| Contract | Address |
|---|---|
| ExecutionGuard | `{{GUARD_ADDRESS}}` |
| GuardedRouter | `{{ROUTER_ADDRESS}}` |
| Successful `guardedSwap` | `{{TX_SUCCESS}}` |
| Reverted `guardedSwap` | `{{TX_REVERT}}` |

## Testnet (HSK Chain Testnet, chain 133): backup demo, deployed 25 Nov 2026

RPC `https://testnet.hsk.xyz`, explorer https://testnet-explorer.hskchain.net

> **Test pool, not HSKSwap.** HSKSwap is not deployed on testnet (no code at the mainnet factory `0x972cA9D1662F5e029cD18327D29026532E84c742` or SwapRouter02 `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3`). This deployment uses its own Uniswap V3 pool built from the official npm bytecode (`@uniswap/v3-core@1.0.1` `UniswapV3Factory`, `@uniswap/swap-router-contracts@1.3.1` `SwapRouter02`) and two worthless 18-decimal test tokens, initialised at price 1 with full-range liquidity of 10,000 per side. It shows the guard mechanics on a live chain, not HSKSwap liquidity or prices. There is no CEX reference on testnet, so the quote's fair price is the pool spot at quote time.

Reproduce: `apps/agent/scripts/testnet-demo.ts` (usage in the file header). Quotes are built and signed with the same `@preflight/core` code as the web API (`simulateSwap`, `buildQuote`, `signQuote`); the attestor key signs off-chain only.

### Contracts

| Contract | Address | Source verified |
|---|---|---|
| ExecutionGuard (owner = deployer) | [`0xF30860d72319B376D87503D2F8e725141Bb0CB5f`](https://testnet-explorer.hskchain.net/address/0xF30860d72319B376D87503D2F8e725141Bb0CB5f) | Sourcify exact match |
| GuardedRouter | [`0x0e21210ED3630f8aEC74CF5Ae2CA73C2114921d6`](https://testnet-explorer.hskchain.net/address/0x0e21210ED3630f8aEC74CF5Ae2CA73C2114921d6) | Sourcify exact match |
| Attestor (registered via `addAttestor`) | `0xC53749181dC1eb2C41c98964907849C6485C904E` | n/a (EOA) |
| Test pool tUSDT/tWHSK 0.3% | [`0x144359a10A229ed1CCcCc4Fef7EA26B23f37d3d0`](https://testnet-explorer.hskchain.net/address/0x144359a10A229ed1CCcCc4Fef7EA26B23f37d3d0) | Uniswap V3 pool |
| UniswapV3Factory (test) | [`0xAfAF2c1783D7D0aFF31a15762A2a8420Ff1eBBE7`](https://testnet-explorer.hskchain.net/address/0xAfAF2c1783D7D0aFF31a15762A2a8420Ff1eBBE7) | official bytecode, not verified |
| SwapRouter02 (test) | [`0xbFbfB524a8a72bC6EcA12072EB72864Ca1a0f184`](https://testnet-explorer.hskchain.net/address/0xbFbfB524a8a72bC6EcA12072EB72864Ca1a0f184) | official bytecode, not verified |
| Test token tWHSK ("Preflight Test WHSK") | [`0x9d6033845535255395EB839b86E397965A8a2459`](https://testnet-explorer.hskchain.net/address/0x9d6033845535255395EB839b86E397965A8a2459) | Blockscout |
| Test token tUSDT ("Preflight Test USDT") | [`0x62853E4cf3622E73ca5E6f0be894a70366B7c009`](https://testnet-explorer.hskchain.net/address/0x62853E4cf3622E73ca5E6f0be894a70366B7c009) | Blockscout (same bytecode as tWHSK) |
| V3LiquidityHelper | [`0xCd5c043D01BF585dA55357291599Eb09D2e10d14`](https://testnet-explorer.hskchain.net/address/0xCd5c043D01BF585dA55357291599Eb09D2e10d14) | Blockscout |

Deployer / agent: `0xfEEC2434faBcA0305A6F3997E65Ad5e5cd2a3F46`. Blockscout source verification of ExecutionGuard and GuardedRouter failed with `413 Request Entity Too Large` (standard JSON and flattened source are both > 100 KB because of the OpenZeppelin imports), so they are verified on Sourcify instead: https://sourcify.dev/server/v2/contract/133/0xF30860d72319B376D87503D2F8e725141Bb0CB5f and https://sourcify.dev/server/v2/contract/133/0x0e21210ED3630f8aEC74CF5Ae2CA73C2114921d6

### Guarded swaps

| Step | Tx | Result |
|---|---|---|
| Successful `guardedSwap` (10 tUSDT → tWHSK) | [`0xb0d7f065…e3f38b`](https://testnet-explorer.hskchain.net/tx/0xb0d7f0651f39c467e5fa9dd7f5458a664760565c5b948eb4cb72579db5e3f38b) | success; `GuardedSwap` event: amountOut 9.960069810399032164 tWHSK (equal to the off-chain `simulateSwap` output), impactBps 10, devBps 19 |
| Front-run (250 tUSDT direct to SwapRouter02, after the next quote was signed) | [`0xd98fd742…c39002`](https://testnet-explorer.hskchain.net/tx/0xd98fd742bf02c62fb674d9b0e5378177d38d846081a050d0bc050e2008c39002) | success; moves the pool away from the quoted fair price |
| Reverted `guardedSwap` (same quote size, signed before the front-run) | [`0xba7348a9…42e31d`](https://testnet-explorer.hskchain.net/tx/0xba7348a90dba847d552675840407dddb37cfa700018b5af610b3f3d2dd42e31d) | reverted on-chain with `DeviationTooHigh(480, 200)` (selector `0x54ed9c5e`) from `ExecutionGuard.verify` |

### Setup transactions

| Step | Tx |
|---|---|
| Deploy ExecutionGuard | [`0x8b23a2a3…5d083b`](https://testnet-explorer.hskchain.net/tx/0x8b23a2a36e628db70553c43e77eb3e1d21d87301f78519548982eddfe85d083b) |
| `addAttestor` | [`0xd83cb30c…9349c1`](https://testnet-explorer.hskchain.net/tx/0xd83cb30c48b49e56434fa82468804d880577f7df20b1a1513d27b31a519349c1) |
| Deploy GuardedRouter | [`0xd5736ea1…b2c7a8`](https://testnet-explorer.hskchain.net/tx/0xd5736ea1d8102e8bf7f42a7fc11cfd71b7ce39383259a01767cd8e7eb0b2c7a8) |
| Deploy UniswapV3Factory / SwapRouter02 | [`0x513cf890…a4040b`](https://testnet-explorer.hskchain.net/tx/0x513cf89092b2d16dcd943ba90a7cb73372a606a439942e23a48dbd8762a4040b) / [`0x8460f760…870442`](https://testnet-explorer.hskchain.net/tx/0x8460f7609a2de53f5a9ddd965e2c5cb22f4ebc9c246e15dfe81eac9d43870442) |
| `createPool` / `initialize` | [`0xc97439de…1c3ea0`](https://testnet-explorer.hskchain.net/tx/0xc97439dee6803d8d3d6be4984d1c11a67e5cf5c63202a5ab57082ba5b41c3ea0) / [`0xec406c3b…973210`](https://testnet-explorer.hskchain.net/tx/0xec406c3bef9ca0e46101e2915ece79ffa4f4a8686f0e1b122eccf1a76c973210) |
| Add liquidity | [`0xe3caefaf…20be88`](https://testnet-explorer.hskchain.net/tx/0xe3caefaf8a15fb4abd3ac8644cc1384ba36c848102706b8e3994bb518420be88) |

The whole testnet run cost about 0.0205 testnet HSK (gas price ≈1 gwei).
