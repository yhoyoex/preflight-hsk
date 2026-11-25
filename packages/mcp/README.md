# @preflight/mcp

MCP server (stdio) untuk Preflight. Tool:

| Tool | Fungsi | Tx? |
|---|---|---|
| `guard_quote` | `POST /api/quote` → verdict, dampak, deviasi CEX, total biaya. Quote bertanda tangan hanya untuk verdict DEX yang executable dengan harga CEX segar (selain itu `quote`/`signature` = `null`). | tidak |
| `guard_check` | `eth_call ExecutionGuard.verify(quote, sig)` dari `quote.executor` terhadap policy on-chain agent; mengembalikan custom error yang ter-decode. | tidak |
| `guarded_swap` | Quote + calldata unsigned `approve` dan `GuardedRouter.guardedSwap` (`reasonHash = keccak256(reason)`). Dikirim **hanya** bila `AGENT_PRIVATE_KEY` terisi **dan** `PREFLIGHT_EXECUTE=1`. | opsional |

## Env

| Var | Default | Keterangan |
|---|---|---|
| `PREFLIGHT_API_URL` | `http://localhost:3000` | Deployment `apps/web` |
| `HSK_RPC_URL` | `https://mainnet.hsk.xyz` | |
| `HSK_CHAIN_ID` | `177` | |
| `GUARD_ADDRESS` | – | ExecutionGuard (untuk `guard_check`) |
| `ROUTER_ADDRESS` | – | GuardedRouter (executor default + target swap) |
| `AGENT_PRIVATE_KEY` | – | Hanya untuk eksekusi; tidak pernah dicetak |
| `PREFLIGHT_EXECUTE` | – | `1` untuk mengizinkan pengiriman tx |
| `PREFLIGHT_MAX_USD` | `100` | `guarded_swap` menolak quote dengan `metrics.notionalUsd` di atasnya. `amountOutMin` di bawah fair floor quote juga ditolak. |

## Pasang

Claude Code:

```sh
claude mcp add preflight \
  -e PREFLIGHT_API_URL=http://localhost:3000 -e GUARD_ADDRESS=0x... -e ROUTER_ADDRESS=0x... \
  -- node /ABS/PATH/hsk-seoul/packages/mcp/bin/preflight-mcp.mjs
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "preflight": {
      "command": "node",
      "args": ["/ABS/PATH/hsk-seoul/packages/mcp/bin/preflight-mcp.mjs"],
      "env": { "PREFLIGHT_API_URL": "http://localhost:3000", "GUARD_ADDRESS": "0x...", "ROUTER_ADDRESS": "0x..." }
    }
  }
}
```

Jalankan `pnpm install` di root repo dulu (launcher memakai `tsx`).

## Cek cepat (`tools/list`)

```sh
cd packages/mcp
{ printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 3; } | node bin/preflight-mcp.mjs
```

Respons `id: 2` berisi `guard_quote`, `guard_check`, `guarded_swap`. Test: `pnpm --filter @preflight/mcp test` (handler dengan mock RPC + `tools/list` via in-memory transport).
