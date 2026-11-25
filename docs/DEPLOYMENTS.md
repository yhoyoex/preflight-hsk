# Deployments

## Mainnet (HSK Chain, chain 177)

Pending (waiting for gas funds). Explorer: https://hsk.blockscout.com

| Contract | Address |
|---|---|
| ExecutionGuard | `{{GUARD_ADDRESS}}` |
| GuardedRouter | `{{ROUTER_ADDRESS}}` |
| Successful `guardedSwap` | `{{TX_SUCCESS}}` |
| Reverted `guardedSwap` | `{{TX_REVERT}}` |

## Testnet (HSK Chain Testnet, chain 133): backup, not deployed yet

RPC `https://testnet.hsk.xyz`, explorer https://testnet-explorer.hskchain.net

Status (checked 25 Nov 2026, testnet block 36203859):

- Deployer `0xfEEC2434faBcA0305A6F3997E65Ad5e5cd2a3F46` and attestor `0xC53749181dC1eb2C41c98964907849C6485C904E` hold 0 HSK on testnet.
- HSKSwap is **not** deployed on testnet: there is no code at the mainnet factory `0x972cA9D1662F5e029cD18327D29026532E84c742` or at SwapRouter02 `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3`. A testnet demo therefore needs its own Uniswap V3 test pool (factory + SwapRouter02-compatible router + two test tokens). Such a deployment would show the guard mechanics only, not HSKSwap liquidity, and must be labelled that way.
- Testnet HSK comes from the official faucet https://faucet.hskchain.net/faucet (1 HSK per address per 24 h, Google reCAPTCHA) or from the Sepolia → HSK testnet bridge (see https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Tools/Faucet).

| Item | Value |
|---|---|
| Test token A / B | not deployed |
| V3 factory / router (test) | not deployed |
| ExecutionGuard | not deployed |
| GuardedRouter | not deployed |
| Successful `guardedSwap` | not run |
| Reverted `guardedSwap` | not run |
