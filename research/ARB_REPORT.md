# Simulasi arbitrase "penjaga harga" HSKSwap WHSK/USDT vs HashKey Global

Dibuat oleh `python3 arb_sim.py` dari cache `data/` milik `backtest.py` (tanpa fetch ulang). Periode 2026-10-25 18:38 UTC → 2026-11-24 14:58 UTC (29.8 hari), 2136 swap historis, 42,981 menit CEX (16,875 ber-volume = 39%). Gas per swap ≈ $0.0081 (200k gas × 501 gwei + l1Fee, HSK $0.0813). HSK di CEX turun $0.0882 → $0.0813 selama periode.

**Catatan harga CEX:** close menit ber-volume HashKey Global punya autokorelasi return lag-1 -0.42 dan perubahan non-nol median 12.3 bps (= 1 tick 0.0001) — ciri bid-ask bounce: close melompat antara bid & ask sehingga sebagian besar 'gap' DEX−CEX adalah noise spread CEX, bukan mispricing. Karena itu diuji dua acuan: `last` (close menit ber-volume terakhir ≤N menit) dan `med5` (median 5 close ber-volume terakhir dalam 30 menit, syarat trade terakhir ≤N menit).

## Simulasi arbitrase

Semua konfigurasi. **Alpha** = nilai portofolio agent − buy-and-hold 50/50, keduanya di harga CEX (trade nyata) akhir, setelah gas. **Realisasi** = Σ(edge tiap trade di harga CEX acuan saat keputusan) − gas. DD alpha = drawdown maks kurva alpha. Adv60/Adv1440 = % trade dengan markout negatif 60 menit / 24 jam kemudian (adverse selection).

| Acuan | Modal | Ambang | N | Trade | Volume | Alpha | Alpha %/bln | Realisasi | Real. %/bln | DD alpha | Adv60 | Adv1440 | Markout 24j |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| last | $100 | 40 | 1 | 237 | $10,476 | $-26.77 | -26.90% | $47.98 | +48.23% | $29.80 | 64% | 62% | $-21.86 |
| last | $100 | 40 | 5 | 295 | $12,196 | $-32.22 | -32.38% | $54.19 | +54.46% | $35.22 | 65% | 62% | $-27.94 |
| last | $100 | 60 | 1 | 138 | $6,472 | $-14.08 | -14.15% | $42.27 | +42.48% | $18.40 | 55% | 60% | $-7.32 |
| last | $100 | 60 | 5 | 163 | $7,491 | $-16.99 | -17.08% | $46.61 | +46.85% | $19.92 | 56% | 60% | $-9.96 |
| last | $100 | 80 | 1 | 62 | $2,971 | $-3.25 | -3.27% | $31.52 | +31.68% | $7.94 | 37% | 52% | $3.09 |
| last | $100 | 80 | 5 | 67 | $3,243 | $-4.13 | -4.16% | $33.17 | +33.34% | $8.14 | 37% | 54% | $2.40 |
| last | $100 | 100 | 1 | 42 | $1,998 | $-3.02 | -3.04% | $30.70 | +30.86% | $7.49 | 36% | 60% | $2.66 |
| last | $100 | 100 | 5 | 47 | $2,268 | $-3.87 | -3.89% | $32.93 | +33.10% | $8.04 | 32% | 64% | $1.73 |
| last | $1,000 | 40 | 1 | 431 | $109,644 | $-268.94 | -27.03% | $513.07 | +51.57% | $297.66 | 68% | 58% | $-222.20 |
| last | $1,000 | 40 | 5 | 471 | $118,754 | $-297.09 | -29.86% | $560.33 | +56.32% | $320.75 | 68% | 58% | $-248.48 |
| last | $1,000 | 60 | 1 | 192 | $80,632 | $-183.00 | -18.39% | $474.74 | +47.72% | $227.89 | 62% | 61% | $-144.63 |
| last | $1,000 | 60 | 5 | 210 | $86,839 | $-201.85 | -20.29% | $533.08 | +53.58% | $237.20 | 62% | 61% | $-167.04 |
| last | $1,000 | 80 | 1 | 94 | $42,625 | $-69.15 | -6.95% | $387.95 | +38.99% | $138.14 | 49% | 60% | $-25.28 |
| last | $1,000 | 80 | 5 | 100 | $45,170 | $-77.18 | -7.76% | $408.20 | +41.03% | $140.16 | 49% | 59% | $-33.95 |
| last | $1,000 | 100 | 1 | 60 | $27,882 | $-38.89 | -3.91% | $357.04 | +35.89% | $88.56 | 48% | 57% | $13.43 |
| last | $1,000 | 100 | 5 | 67 | $30,601 | $-46.36 | -4.66% | $375.67 | +37.76% | $92.64 | 48% | 57% | $12.22 |
| last | $5,000 | 40 | 1 | 777 | $393,445 | $-949.70 | -19.09% | $2,309.22 | +46.42% | $1,078.68 | 64% | 54% | $-833.73 |
| last | $5,000 | 40 | 5 | 787 | $396,300 | $-958.48 | -19.27% | $2,339.42 | +47.03% | $1,086.92 | 64% | 54% | $-842.12 |
| last | $5,000 | 60 | 1 | 394 | $352,271 | $-822.29 | -16.53% | $2,291.50 | +46.06% | $955.91 | 62% | 56% | $-710.04 |
| last | $5,000 | 60 | 5 | 396 | $354,260 | $-828.28 | -16.65% | $2,316.73 | +46.57% | $961.91 | 62% | 57% | $-715.55 |
| last | $5,000 | 80 | 1 | 215 | $285,174 | $-627.11 | -12.61% | $2,233.01 | +44.89% | $763.43 | 59% | 53% | $-514.58 |
| last | $5,000 | 80 | 5 | 218 | $286,175 | $-629.15 | -12.65% | $2,246.48 | +45.16% | $765.47 | 59% | 54% | $-506.39 |
| last | $5,000 | 100 | 1 | 119 | $200,194 | $-404.62 | -8.13% | $1,954.49 | +39.29% | $573.86 | 48% | 52% | $-183.13 |
| last | $5,000 | 100 | 5 | 122 | $205,809 | $-421.75 | -8.48% | $2,023.59 | +40.68% | $591.20 | 50% | 52% | $-195.52 |
| last | $20,000 | 40 | 1 | 897 | $646,769 | $-1,627.15 | -8.18% | $5,294.32 | +26.61% | $1,940.94 | 61% | 56% | $-1,591.04 |
| last | $20,000 | 40 | 5 | 905 | $647,227 | $-1,629.08 | -8.19% | $5,294.62 | +26.61% | $1,942.34 | 61% | 56% | $-1,593.77 |
| last | $20,000 | 60 | 1 | 479 | $598,903 | $-1,485.55 | -7.47% | $5,266.68 | +26.47% | $1,803.03 | 59% | 57% | $-1,454.53 |
| last | $20,000 | 60 | 5 | 479 | $598,903 | $-1,485.55 | -7.47% | $5,266.68 | +26.47% | $1,803.03 | 59% | 57% | $-1,454.53 |
| last | $20,000 | 80 | 1 | 273 | $520,279 | $-1,252.57 | -6.29% | $5,213.24 | +26.20% | $1,572.67 | 53% | 55% | $-1,223.56 |
| last | $20,000 | 80 | 5 | 274 | $520,609 | $-1,253.53 | -6.30% | $5,223.65 | +26.25% | $1,573.63 | 53% | 55% | $-1,224.54 |
| last | $20,000 | 100 | 1 | 175 | $444,697 | $-1,067.36 | -5.36% | $5,055.42 | +25.41% | $1,415.55 | 47% | 54% | $-912.54 |
| last | $20,000 | 100 | 5 | 176 | $445,122 | $-1,068.57 | -5.37% | $5,069.80 | +25.48% | $1,418.17 | 47% | 55% | $-913.80 |
| med5 | $100 | 40 | 1 | 96 | $4,217 | $-8.27 | -8.31% | $14.07 | +14.14% | $14.79 | 46% | 62% | $-6.30 |
| med5 | $100 | 40 | 5 | 98 | $4,250 | $-8.30 | -8.35% | $14.02 | +14.10% | $14.90 | 46% | 61% | $-6.58 |
| med5 | $100 | 60 | 1 | 61 | $2,949 | $-3.92 | -3.94% | $15.13 | +15.21% | $11.78 | 38% | 56% | $2.44 |
| med5 | $100 | 60 | 5 | 65 | $3,128 | $-4.50 | -4.53% | $16.08 | +16.16% | $12.38 | 38% | 54% | $1.90 |
| med5 | $100 | 80 | 1 | 21 | $1,037 | $1.80 | +1.81% | $8.04 | +8.08% | $8.06 | 43% | 38% | $4.39 |
| med5 | $100 | 80 | 5 | 21 | $1,037 | $1.80 | +1.81% | $7.65 | +7.69% | $8.06 | 43% | 38% | $4.39 |
| med5 | $100 | 100 | 1 | 7 | $348 | $2.60 | +2.62% | $4.91 | +4.93% | $6.76 | 0% | 0% | $3.99 |
| med5 | $100 | 100 | 5 | 7 | $348 | $2.60 | +2.62% | $4.85 | +4.88% | $6.76 | 0% | 0% | $3.99 |
| med5 | $1,000 | 40 | 1 | 168 | $36,419 | $-57.36 | -5.77% | $107.46 | +10.80% | $122.42 | 51% | 54% | $-19.52 |
| med5 | $1,000 | 40 | 5 | 170 | $36,405 | $-57.67 | -5.80% | $106.93 | +10.75% | $122.36 | 52% | 54% | $-21.02 |
| med5 | $1,000 | 60 | 1 | 67 | $27,422 | $-29.72 | -2.99% | $109.54 | +11.01% | $116.07 | 45% | 51% | $3.88 |
| med5 | $1,000 | 60 | 5 | 67 | $27,422 | $-29.72 | -2.99% | $109.54 | +11.01% | $116.07 | 46% | 51% | $3.88 |
| med5 | $1,000 | 80 | 1 | 35 | $16,677 | $-1.95 | -0.20% | $106.41 | +10.70% | $93.71 | 37% | 37% | $36.97 |
| med5 | $1,000 | 80 | 5 | 35 | $16,677 | $-1.95 | -0.20% | $105.32 | +10.59% | $93.71 | 37% | 37% | $36.97 |
| med5 | $1,000 | 100 | 1 | 18 | $8,968 | $20.84 | +2.09% | $79.24 | +7.96% | $74.69 | 28% | 28% | $41.19 |
| med5 | $1,000 | 100 | 5 | 18 | $8,968 | $20.84 | +2.09% | $79.24 | +7.96% | $74.69 | 28% | 28% | $41.19 |
| med5 | $5,000 | 40 | 1 | 318 | $107,214 | $-128.57 | -2.58% | $424.05 | +8.52% | $235.39 | 48% | 53% | $-80.19 |
| med5 | $5,000 | 40 | 5 | 321 | $107,204 | $-128.91 | -2.59% | $423.84 | +8.52% | $235.39 | 48% | 53% | $-80.25 |
| med5 | $5,000 | 60 | 1 | 137 | $93,110 | $-94.55 | -1.90% | $429.07 | +8.63% | $221.55 | 52% | 55% | $-60.42 |
| med5 | $5,000 | 60 | 5 | 137 | $93,110 | $-94.55 | -1.90% | $429.07 | +8.63% | $221.55 | 52% | 55% | $-60.53 |
| med5 | $5,000 | 80 | 1 | 70 | $71,978 | $-34.57 | -0.69% | $384.08 | +7.72% | $234.36 | 43% | 50% | $-21.01 |
| med5 | $5,000 | 80 | 5 | 70 | $71,978 | $-34.57 | -0.69% | $384.08 | +7.72% | $238.73 | 43% | 50% | $-21.16 |
| med5 | $5,000 | 100 | 1 | 44 | $59,466 | $5.56 | +0.11% | $407.02 | +8.18% | $211.65 | 39% | 48% | $74.78 |
| med5 | $5,000 | 100 | 5 | 44 | $59,466 | $5.56 | +0.11% | $407.02 | +8.18% | $211.65 | 39% | 48% | $74.33 |
| med5 | $20,000 | 40 | 1 | 389 | $172,529 | $-281.11 | -1.41% | $780.80 | +3.92% | $313.88 | 45% | 57% | $-279.70 |
| med5 | $20,000 | 40 | 5 | 392 | $172,529 | $-281.46 | -1.41% | $780.20 | +3.92% | $313.88 | 44% | 56% | $-278.70 |
| med5 | $20,000 | 60 | 1 | 175 | $154,429 | $-232.41 | -1.17% | $780.18 | +3.92% | $295.37 | 46% | 57% | $-242.58 |
| med5 | $20,000 | 60 | 5 | 176 | $154,429 | $-232.42 | -1.17% | $779.09 | +3.92% | $295.37 | 46% | 57% | $-240.95 |
| med5 | $20,000 | 80 | 1 | 94 | $130,027 | $-167.01 | -0.84% | $757.62 | +3.81% | $301.75 | 40% | 52% | $-190.91 |
| med5 | $20,000 | 80 | 5 | 94 | $130,027 | $-167.01 | -0.84% | $757.62 | +3.81% | $301.75 | 40% | 52% | $-190.91 |
| med5 | $20,000 | 100 | 1 | 56 | $104,351 | $-123.67 | -0.62% | $689.23 | +3.46% | $269.87 | 38% | 50% | $-94.00 |
| med5 | $20,000 | 100 | 5 | 56 | $104,351 | $-123.67 | -0.62% | $689.23 | +3.46% | $269.87 | 38% | 50% | $-94.00 |

### Konfigurasi terbaik per modal (alpha) & ketahanan

| Modal | Acuan | Ambang | N | Alpha | %/bln | Alpha paruh-1 | Alpha paruh-2 | Hold akhir | Agent akhir | Porsi WHSK akhir | DD ekuitas |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| $100 | med5 | 100 | 1 | $2.60 | +2.62% | $1.29 | $1.31 | $96.40 | $99.01 | 0% | $12.93 |
| $1,000 | med5 | 100 | 1 | $20.84 | +2.09% | $8.87 | $11.98 | $964.04 | $984.88 | 51% | $132.65 |
| $5,000 | med5 | 100 | 5 | $5.56 | +0.11% | $-13.40 | $18.96 | $4,820.21 | $4,825.76 | 56% | $602.51 |
| $20,000 | med5 | 100 | 1 | $-123.67 | -0.62% | $-70.64 | $-53.03 | $19,280.82 | $19,157.15 | 47% | $2,230.17 |

Sensitivitas konfigurasi terbaik (latensi eksekusi & buffer target):

| Uji | Nilai | Modal | Trade | Alpha | %/bln | Realisasi | Adv1440 |
|---|---:|---:|---:|---:|---:|---:|---:|
| latency | 2 mnt | $100 | 7 | $2.60 | +2.62% | $4.91 | 0% |
| latency | 5 mnt | $100 | 7 | $2.60 | +2.62% | $4.85 | 14% |
| latency | 2 mnt | $1,000 | 22 | $18.33 | +1.84% | $84.00 | 36% |
| latency | 5 mnt | $1,000 | 20 | $19.91 | +2.00% | $63.76 | 35% |
| latency | 2 mnt | $5,000 | 44 | $10.89 | +0.22% | $373.62 | 45% |
| latency | 5 mnt | $5,000 | 50 | $-6.50 | -0.13% | $385.04 | 52% |
| latency | 2 mnt | $20,000 | 56 | $-125.04 | -0.63% | $685.39 | 50% |
| latency | 5 mnt | $20,000 | 67 | $-130.21 | -0.65% | $656.79 | 55% |
| buffer | 30 bps | $100 | 7 | $2.60 | +2.62% | $4.91 | 0% |
| buffer | 30 bps | $1,000 | 18 | $20.84 | +2.09% | $79.24 | 28% |
| buffer | 30 bps | $5,000 | 52 | $-69.51 | -1.40% | $505.29 | 52% |
| buffer | 30 bps | $20,000 | 57 | $-161.57 | -0.81% | $708.52 | 49% |
| buffer | 60 bps | $100 | 7 | $2.60 | +2.62% | $4.91 | 0% |
| buffer | 60 bps | $1,000 | 19 | $20.92 | +2.10% | $79.33 | 32% |
| buffer | 60 bps | $5,000 | 40 | $51.64 | +1.04% | $331.62 | 40% |
| buffer | 60 bps | $20,000 | 57 | $-42.33 | -0.21% | $647.26 | 47% |

Penutupan gap ≥100 bps historis (tanpa agent, ≤240 menit, siapa yang bergerak lebih banyak):

- N=1: ditutup DEX 3, ditutup CEX 117, tidak tertutup 6
- N=5: ditutup DEX 3, ditutup CEX 116, tidak tertutup 7

Distribusi trade konfigurasi terbaik:

- $100 (med5, ambang 100, N=1): 7 trade (0.2/hari), ukuran median $50.00 (p90 $50.89), edge median 119 bps vs acuan, Σedge $4.97, markout 1 jam Σ $3.55, 24 jam Σ $3.99
- $1,000 (med5, ambang 100, N=1): 18 trade (0.6/hari), ukuran median $500.00 (p90 $500.79), edge median 62 bps vs acuan, Σedge $79.40, markout 1 jam Σ $36.03, 24 jam Σ $41.19
- $5,000 (med5, ambang 100, N=5): 44 trade (1.5/hari), ukuran median $1,385.29 (p90 $2,163.45), edge median 46 bps vs acuan, Σedge $407.40, markout 1 jam Σ $80.91, 24 jam Σ $74.33
- $20,000 (med5, ambang 100, N=1): 56 trade (1.9/hari), ukuran median $1,649.52 (p90 $3,139.45), edge median 50 bps vs acuan, Σedge $689.70, markout 1 jam Σ $48.18, 24 jam Σ $-94.00

### Kesimpulan

P&L TIDAK positif secara robust: alpha (MTM vs hold 50/50, setelah fee & gas) positif hanya di 8/64 konfigurasi (last: 0/32, med5: 8/32), konfigurasi terbaik tidak positif di kedua paruh periode dan tidak selalu positif pada latensi 2–5 menit/buffer 30–60 bps; 'realisasi' terhadap close CEX (Σ $73,519) jauh di atas alpha (Σ $-20,064) karena gap yang ditangkap sebagian besar bid-ask bounce CEX, sehingga angka realisasi tidak boleh dipakai sebagai klaim. Konfigurasi terbaik (dipilih in-sample, jadi optimistis) adalah acuan median CEX + ambang tinggi — $100: med5 ambang 100 N=1 → $2.60 (+2.62%/bln, 7 trade); $1,000: med5 ambang 100 N=1 → $20.84 (+2.09%/bln, 18 trade); $5,000: med5 ambang 100 N=5 → $5.56 (+0.11%/bln, 44 trade); $20,000: med5 ambang 100 N=1 → $-123.67 (-0.62%/bln, 56 trade); angka paling jujur untuk demo: 'pada backtest 30 hari, modal $1,000 menghasilkan ≈+2.1%/bulan (≈$21) di atas hold, sebelum risiko MEV/kompetitor' — dan disebut bahwa kapasitasnya kecil (alpha tidak naik dengan modal; modal besar justru negatif). Risiko utama: adverse selection (gap ≥100 bps hampir selalu ditutup oleh CEX yang bergerak, bukan DEX), harga acuan CEX yang tipis/bounce (tick 0.0001 ≈ 12 bps), inventaris tanpa hedge yang menyimpang dari 50/50 saat HSK turun, dan kapasitas pool ≈$40k volume/bulan.

### Asumsi & batasan

- Replay harga DEX: offset aditif sqrtPrice D dari trade agent dipertahankan permanen (tidak ada arbitrase pihak lain yang mengembalikannya; sesuai temuan backtest bahwa harga hampir tidak pulih). Swap historis diasumsikan tetap terjadi dengan jumlah USDT yang sama (aliran tidak bereaksi terhadap harga agent). L aktif = `liquidity` dari event Swap historis terakhir (berubah ~2× selama periode); tidak ada crossing tick (posisi ≈ full-range).
- Sinyal di akhir menit m memakai close CEX dari menit ber-volume ≤N menit; eksekusi di akhir menit m+1 terhadap harga DEX saat itu (swap historis di menit m+1 sudah masuk), target harga = acuan CEX keputusan × (1 ± 40 bps). Tidak ada look-ahead: harga CEX masa depan hanya dipakai untuk mark-to-market & markout.
- Inventaris awal 50/50 di harga CEX awal; trade maks 50% modal; trade hanya bila edge ≥2× gas dan ≥$1. Fee LP 0.3% dihitung pada input. Gas 200k × 501 gwei (effectiveGasPrice teramati 500.1–501 gwei di 3 receipt) + l1Fee 3.2e13 wei, dibayar HSK di harga CEX saat itu.
- Tanpa hedge CEX: alpha MTM mencakup efek inventaris yang menyimpang dari 50/50. Tidak memodelkan MEV/front-run, kompetitor arbitrase baru, atau slippage CEX.
- Harga 'CEX' = close menit HashKey Global; 61% menit tanpa volume dibuang (harga basi). Tidak ada data bid/ask/orderbook historis, jadi mid CEX tidak bisa dihitung langsung.
- 'Konfigurasi terbaik' dipilih dari data yang sama (in-sample) → bias optimistis; uji paruh periode & sensitivitas hanya mitigasi parsial. Penutupan gap memakai acuan `last`.
