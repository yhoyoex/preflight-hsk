// sendGuardedSwap safety (review #1, #6) with a hand-written mock client/wallet: no network, no anvil.
import { getAddress, type Account, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { forceApprove, PendingTxError, sendGuardedSwap, USDT, type GuardedSwapParams } from "../src/chain.ts";

const AGENT = getAddress("0x00000000000000000000000000000000000a6e17");
const ROUTER = getAddress("0x00000000000000000000000000000000000000bb");
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const params: GuardedSwapParams = {
  router: ROUTER,
  quote: {
    agent: AGENT,
    executor: ROUTER,
    pool: getAddress("0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC"),
    zeroForOne: false,
    amountIn: 50_000_000n,
    expectedImpactBps: 2,
    fairSqrtPriceX96: 22523105442617287490681n,
    issuedAt: 1n,
    expiry: 61n,
    nonce: 1n,
  },
  signature: `0x${"11".repeat(65)}` as Hex,
  amountOutMin: 1n,
  reasonHash: H(0),
};

interface MockOpts {
  latest?: number;
  pending?: number;
  allowance?: bigint;
  /** approve(value) reverts in simulation while a non-zero allowance exists (USDT-mainnet style). */
  strictApprove?: boolean;
  receipt?: "success" | "timeout";
}

function mocks(o: MockOpts = {}) {
  let allowance = o.allowance ?? 0n;
  let n = 0;
  const writes: { fn: string; args: readonly unknown[] }[] = [];
  const client = {
    getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) => (blockTag === "pending" ? (o.pending ?? 5) : (o.latest ?? 5))),
    readContract: vi.fn(async () => allowance),
    simulateContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "approve" && o.strictApprove && allowance !== 0n && args[1] !== 0n) {
        throw new Error("execution reverted");
      }
      return { result: undefined };
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash, timeout }: { hash: Hex; timeout: number }) => {
      expect(timeout).toBeGreaterThan(0);
      if (o.receipt === "timeout") throw new Error(`Timed out while waiting for transaction with hash "${hash}" to be confirmed.`);
      return { status: "success", blockNumber: 1n, logs: [] };
    }),
  } as unknown as PublicClient;
  const wallet = {
    account: { address: AGENT },
    writeContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      writes.push({ fn: functionName, args });
      if (functionName === "approve") allowance = args[1] as bigint;
      return H(++n);
    }),
  } as unknown as WalletClient<Transport, Chain, Account>;
  return { client, wallet, writes };
}

describe("sendGuardedSwap: pending nonce + receipt timeout (review #1)", () => {
  it("refuses to send while the agent has a pending tx", async () => {
    const m = mocks({ latest: 5, pending: 6 });
    await expect(sendGuardedSwap(m.client, m.wallet, params)).rejects.toBeInstanceOf(PendingTxError);
    await expect(sendGuardedSwap(m.client, m.wallet, params)).rejects.toThrow(/1 pending tx \(nonce latest=5, pending=6\)/);
    expect(m.writes).toHaveLength(0);
  });

  it("waits for receipts with an explicit timeout and reports which tx timed out", async () => {
    const m = mocks({ allowance: 10n ** 12n, receipt: "timeout" });
    await expect(sendGuardedSwap(m.client, m.wallet, params, { receiptTimeoutMs: 2_000 })).rejects.toThrow(
      /^guardedSwap 0x0+1: no receipt within 2 s/,
    );
    expect(m.writes.map((w) => w.fn)).toEqual(["guardedSwap"]);
    const waits = vi.mocked(m.client.waitForTransactionReceipt).mock.calls;
    expect(waits[0]![0]).toMatchObject({ timeout: 2_000 });
  });
});

describe("forceApprove (review #6)", () => {
  it("non-zero → non-zero directly when the token allows it (HSK USDT on the fork)", async () => {
    const m = mocks({ allowance: 10n });
    const r = await sendGuardedSwap(m.client, m.wallet, params).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(Error); // the mock receipt has no GuardedSwap event; only the approve sequence matters
    expect(m.writes.map((w) => w.fn)).toEqual(["approve", "guardedSwap"]);
    expect(m.writes[0]!.args[1]).toBe(50_000_000n);
  });

  it("resets to 0 first when the token rejects non-zero → non-zero", async () => {
    const m = mocks({ allowance: 10n, strictApprove: true });
    await forceApprove(m.client, m.wallet, USDT, ROUTER, 50_000_000n, 10n);
    expect(m.writes.map((w) => w.args[1])).toEqual([0n, 50_000_000n]);
  });

  it("does not hide a rejection when there was no allowance to reset", async () => {
    const m = mocks({ allowance: 0n });
    vi.mocked(m.client.simulateContract).mockImplementation(async () => {
      throw new Error("token paused");
    });
    await expect(forceApprove(m.client, m.wallet, USDT, ROUTER, 5n, 0n)).rejects.toThrow("token paused");
    expect(m.writes).toHaveLength(0);
  });
});
