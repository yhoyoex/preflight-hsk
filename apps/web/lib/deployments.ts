import { BLOCKSCOUT } from "./leaderboard";

/** Source: docs/DEPLOYMENTS.md (HSK Chain Testnet, chain 133, deployed 25 Nov 2026). */
export const TESTNET_EXPLORER = "https://testnet-explorer.hskchain.net";

export const testnet = {
  chainId: 133,
  deployedOn: "25 Nov 2026",
  contracts: [
    { label: "ExecutionGuard", address: "0xF30860d72319B376D87503D2F8e725141Bb0CB5f", note: "Sourcify exact match" },
    { label: "GuardedRouter", address: "0x0e21210ED3630f8aEC74CF5Ae2CA73C2114921d6", note: "Sourcify exact match" },
    { label: "Test pool tUSDT/tWHSK 0.3%", address: "0x144359a10A229ed1CCcCc4Fef7EA26B23f37d3d0", note: "Uniswap V3 pool" },
  ],
  txs: {
    success: "0xb0d7f0651f39c467e5fa9dd7f5458a664760565c5b948eb4cb72579db5e3f38b",
    frontRun: "0xd98fd742bf02c62fb674d9b0e5378177d38d846081a050d0bc050e2008c39002",
    revert: "0xba7348a90dba847d552675840407dddb37cfa700018b5af610b3f3d2dd42e31d",
  },
} as const;

export const testnetUrl = (kind: "address" | "tx", value: string) => `${TESTNET_EXPLORER}/${kind}/${value}`;
export const mainnetUrl = (kind: "address" | "tx", value: string) => `${BLOCKSCOUT}/${kind}/${value}`;

/** Mainnet addresses come from the build environment; empty means not deployed yet. */
export const mainnetContracts = [
  { label: "ExecutionGuard", address: process.env.NEXT_PUBLIC_GUARD_ADDRESS?.trim() || null },
  { label: "GuardedRouter", address: process.env.NEXT_PUBLIC_ROUTER_ADDRESS?.trim() || null },
];

export const GITHUB_URL = "https://github.com/yhoyoex/preflight-hsk";
