# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti Keep a Changelog, versi mengikuti SemVer.

## [Unreleased]

### Added
- Kontrak `ExecutionGuard` (verifikasi quote EIP-712 + policy per agent), `GuardConsumer`, dan `GuardedRouter` untuk swap WHSK/USDT di HSK Chain.
- Simulasi pool Uniswap V3 presisi integer (`@preflight/core`), cocok exact dengan replay on-chain (2.134/2.134 swap tanpa tick crossing + 1/1 swap tick crossing) dan dengan swap nyata di fork.
- Harga wajar CEX (HashKey Global HSKUSDT, median 5 menit ber-volume) dengan cache 30 s, timeout, dan backoff.
- Verdict `DEX` / `CEX` / `TUNDA` / `KECILKAN` / `NO_REFERENCE` / `OUT_OF_RANGE` beserta metrik biaya dan ukuran maksimal yang lolos policy.
- Tanda tangan quote EIP-712 dengan nonce acak 256-bit.
- Endpoint `POST /api/quote` (Next.js) yang mengembalikan quote bertanda tangan, verdict, dan metrik.
- MCP server stdio `@preflight/mcp` dengan tool `guard_quote`, `guard_check` (eth_call `ExecutionGuard.verify`), dan `guarded_swap` (calldata unsigned; kirim hanya bila `AGENT_PRIVATE_KEY` dan `PREFLIGHT_EXECUTE=1`).
- Agent price-guard `@preflight/agent`: trigger med5 ±100 bps, sizing `size_trade` riset, modal maks via `AGENT_CAPITAL_USD`, ukuran + alasan dari Claude Haiku (fallback deterministik tanpa `ANTHROPIC_API_KEY`), `reasonHash` on-chain, log alasan JSONL, `--dry-run` default.
- Test e2e di anvil fork blok 30609500: satu `guardedSwap` sukses dan satu swap kebesaran yang revert `ImpactTooHigh` (`PREFLIGHT_E2E=1 pnpm --filter @preflight/agent test:e2e`).
- Demo revert jujur `pnpm --filter @preflight/agent start --scenario revert` (hanya anvil): bot front-run di blok yang sama sehingga `guardedSwap` agent yang lolos simulasi di-revert `DeviationTooHigh`; ikut di e2e.
- Error dari `guardedSwap` yang revert setelah ditambang kini di-decode dengan replay `eth_call` di blok itu.
- Indexer biaya eksekusi `packages/core/src/indexer.ts`: impact per swap dari replay simulasi, fee, deviasi vs med5 CEX, biaya USD, agregasi per wallet, feed event `GuardedSwap`.
- Deploy cadangan HSK testnet (chain 133) dengan pool uji Uniswap V3 (bukan HSKSwap): `apps/agent/scripts/testnet-demo.ts` + fixture `contracts/script/testnet/TestnetKit.sol`; satu `guardedSwap` sukses dan satu revert `DeviationTooHigh(480, 200)` setelah front-run (alamat & tx di `docs/DEPLOYMENTS.md`).
- `pnpm snapshot` → `apps/web/data/leaderboard.json` (30 hari, 2.136 swap, 31 wallet, volume $40.651).
- Halaman `/leaderboard`, endpoint `/api/leaderboard`, dan landing `/` baru (Tailwind, tema gelap).
- Halaman `/playground`: arah + jumlah (preset 50/1.000/5.000/20.000), alamat agent/executor opsional, kartu verdict, breakdown biaya (fee, impact, deviasi vs CEX, total bps & USD), ukuran maksimal dalam policy, status tanda tangan, dan kurva biaya vs ukuran order; pesan ramah untuk 429/5xx.
- Endpoint `POST /api/curve` `{zeroForOne}`: biaya per ukuran $50–$20k dari simulasi pool + referensi CEX, tanpa tanda tangan; limit sama dengan `/api/quote` (30/menit per IP) tetapi key terpisah (`curve:<ip>`) sehingga tidak memakan jatah quote.
- Landing: alur Quote → Check → Guarded swap, bagian "For AI agents" (MCP tools), alamat kontrak mainnet dari `NEXT_PUBLIC_GUARD_ADDRESS` / `NEXT_PUBLIC_ROUTER_ADDRESS` (tampil "deploying soon" bila kosong) dengan link Blockscout.
- Screenshot demo di `docs/screens/`.

### Changed
- Agent: `reasonHash` dihitung dari alasan final yang memuat ukuran setelah clamp (`[final size X TOKEN]`); cek edge vs gas memakai `eth_gasPrice`; saldo dibaca sebagai BigInt dan ukuran tidak melebihi saldo; klien Anthropic memakai timeout 15 s dan 1 retry.
- Dokumentasi verdict: deviasi spot tanpa arah (sinyal > 200 bps → `TUNDA`) dan definisi `cexImpactBps` (selisih output, sama dengan tabel "biaya dampak" REPORT).
- Copy UI lebih akurat: landing menyebut model kepercayaan (harga CEX di-attest satu signer tepercaya; guard membatasi impact & deviasi dari harga itu) dan TVL bertanggal; verdict CEX "may be cheaper"; output tidak ditampilkan untuk fill parsial/OUT_OF_RANGE; caption kurva menyebut policy default vs policy on-chain agent; pesan 429 sesuai limit nyata.
- Redesign UI web: design token (ground/surface/accent di `globals.css`) dan komponen bersama (`components/`: PageHeader, Section, Panel, Stat, VerdictBadge, CodeBlock + copy, AddressChip + copy & link explorer) di semua halaman, plus footer dan favicon baru. Landing kini memuat hero dengan biaya order dari riset ($50 / $4.24k / $10k), angka masalah pool, alur quote → sign → guardedSwap, tabel enam verdict, "Proof on-chain" testnet (tx sukses, front-run, revert `DeviationTooHigh(480, 200)`; berlabel "Testnet (test pool, not HSKSwap)"), alamat mainnet dari env atau "Coming soon", snippet MCP/HTTP, serta trust model & limitations. Playground: rincian biaya bertumpuk (fee/impact/deviasi), kurva dengan tooltip hover/tap/panah keyboard, serta state kosong (quick run 50 / 20.000 USDT), loading, dan error dengan "Try again". Leaderboard: stat ringkas, distribusi dengan persentase, dan tabel wallet yang bisa diurutkan (`aria-sort`). Screenshot `docs/screens/` diperbarui (1440 px dan 375 px).
- Poles redesign: chip tx front-run bernada netral "Front-run (attacker tx)"; placeholder snippet MCP aman disalin (`0xYourGuardAddress`); ukuran di kurva tanpa ".00" (`fmtUsdSize`); teks sr-only link explorer dipersingkat; footer menandai mainnet "(pending)" selama env alamat kosong; `*.tsbuildinfo` di-ignore.
- UI web berbahasa Inggris dengan nav bersama (penanda halaman aktif), skip link, fokus terlihat, kontras teks sekunder dinaikkan, dan tabel/heading semantik.
- `/api/quote` hanya menandatangani verdict `DEX` yang executable dengan harga CEX segar; selain itu respons tetap berisi verdict + metrik dengan `quote`/`signature` = `null`.

### Security
- Rate limit API: IP diambil dari `x-vercel-forwarded-for` / `x-real-ip` (di-set platform), dengan fallback hop terakhir `X-Forwarded-For`. Hop pertama yang bisa dipalsukan klien tidak lagi dipakai.
- Limiter in-memory (tanpa Upstash, termasuk fallback saat Upstash gagal) punya bucket global 300 request/menit (`RATE_LIMIT_GLOBAL_PER_MINUTE`). Banjir key baru juga tidak bisa menggusur bucket yang masih dibatasi.
- Pengiriman `guardedSwap` (agent & MCP) menolak kirim bila wallet punya tx pending, menunggu tiap receipt dengan timeout 120 s, dan memakai approve gaya `forceApprove` (reset ke 0 hanya bila token menolak non-zero → non-zero).
- Agent `--live` berhenti otomatis (exit code 2) setelah `AGENT_MAX_CONSECUTIVE_FAILURES` (default 3) revert/penolakan/error berturut-turut.
- MCP `guarded_swap` menolak notional di atas `PREFLIGHT_MAX_USD` (default $100) dan `amountOutMin` di bawah fair floor quote.
- `GuardedRouter` menegakkan fair floor on-chain terhadap harga wajar quote, sehingga sandwich dibatasi walau `amountOutMin = 0`; output diukur dari selisih saldo.
- `GuardConsumer` hanya menerima quote yang `agent`-nya kontrak itu sendiri.
- `ExecutionGuard` memakai kepemilikan dua langkah dan tidak bisa di-renounce; nonce ditandai terpakai sebelum panggilan eksternal.
- Trade debu (output ideal 0) dan simulasi parsial tidak pernah dianggap berdampak kecil.
- Konstruktor `GuardedRouter` menolak factory yang berbeda dari milik SwapRouter02; script deploy hanya untuk chain 177/133 dan mewajibkan attestor.
- Attestor tidak lagi memakai spot DEX sebagai `fairSqrtPriceX96` saat harga CEX basi.
- Rate limit per IP di `/api/quote` (default 30/menit, opsional Upstash Redis) → HTTP 429 + `retry-after`.
- Error RPC tidak lagi diteruskan ke klien (pesan generik 500/502); log server tanpa URL RPC.
