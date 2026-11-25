# Backtest pemulihan harga — HSKSwap WHSK/USDT 0.3%

Dibuat otomatis oleh `backtest.py` (read-only). Pool `0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC`.

## Data

- Rentang blok: 29,302,744 – 30,598,744 (block time ≈2.00 s)
- Swap pertama/terakhir: 2026-10-25 18:36 UTC → 2026-11-24 14:57 UTC (29.8 hari)
- Jumlah swap: **2136** (≈72/hari). Sumber: RPC `eth_getLogs` (chunk 5000 blok); timestamp diinterpolasi dari blok sampel tiap 50k blok, galat maks 0 s pada 5 swap sampel (Blockscout API kena rate-limit 429, tidak dipakai).
- Ukuran swap (USD): median 15, p90 25, p99 103, maks 502; total volume ≈40,651
- Dampak harga per swap (bps): median 0.7, p90 1.4, p99 6.7, maks 23.5; jumlah ≥30 bps: 0, ≥100 bps: 0
- State pool sekarang: harga 0.08082 USDT/WHSK, tick -301482, liquidity 1,475,813,786,831,558,685, tickSpacing 60, 6 tick terinisialisasi (word [-24, -16])

## Pemulihan setelah swap berdampak besar

Pemulihan X% = harga pool (setelah swap berikutnya) kembali ≥X% jarak menuju harga sebelum swap. Event yang horizon 24 jamnya belum lengkap dikecualikan.

| Ambang | Event | Level | Median menit | p75 menit | Maks menit | Median #swap | p75 #swap | Tidak pulih ≤24 j |
|---|---|---|---|---|---|---|---|---|
| ≥5 bps | 25 | 50% | 135.6 | 897.9 | 1,401.9 | 20 | 24 | 18/25 (72%) |
| ≥5 bps | 25 | 90% | 114.8 | 519.9 | 1,402.1 | 20 | 28 | 19/25 (76%) |
| ≥10 bps | 5 | 50% | 1,147.9 | 1,147.9 | 1,147.9 | 20 | 20 | 4/5 (80%) |
| ≥10 bps | 5 | 90% | — | — | — | — | — | 5/5 (100%) |
| ≥30 bps | 0 | 50% | — | — | — | — | — | — |
| ≥30 bps | 0 | 90% | — | — | — | — | — | — |
| ≥100 bps | 0 | 50% | — | — | — | — | — | — |
| ≥100 bps | 0 | 90% | — | — | — | — | — | — |

Kurva fraksi pemulihan. **A** = berbasis swap (event ≥5 bps; ambang tertinggi dengan ≥20 event). **B** = proxy arbitrase: episode |DEX−CEX| ≥100 bps, fraksi gap yang ditutup oleh pergerakan harga DEX sendiri.

| Menit setelah | A p25 | A median | A mean | B p25 | B median | B mean |
|---|---|---|---|---|---|---|
| 2 | 0.00 | 0.00 | 0.08 | 0.00 | 0.00 | 0.00 |
| 5 | 0.00 | 0.00 | 0.08 | 0.00 | 0.00 | 0.01 |
| 10 | 0.00 | 0.00 | 0.08 | 0.00 | 0.00 | 0.01 |
| 15 | 0.00 | 0.00 | 0.08 | 0.00 | 0.00 | 0.02 |
| 30 | 0.00 | 0.00 | 0.08 | 0.00 | 0.00 | 0.03 |
| 60 | 0.00 | 0.00 | 0.08 | 0.00 | 0.00 | 0.04 |
| 120 | 0.00 | 0.00 | 0.12 | 0.00 | 0.00 | 0.06 |
| 240 | 0.00 | 0.00 | 0.12 | 0.00 | 0.00 | 0.10 |
| 480 | 0.00 | 0.00 | 0.12 | 0.00 | 0.07 | 0.19 |
| 1440 | 0.00 | 0.00 | 0.18 | 0.03 | 0.30 | 0.44 |

## Simulasi split order (biaya dampak, di luar fee LP 0.3%)

Model: swap disimulasikan dengan tick map pool saat ini (likuiditas konstan di antara tick terinisialisasi, matematika Uniswap V3). Antar-potongan, harga pool digeser kembali ke harga awal sebesar fraksi pemulihan median atau mean kurva A/B pada interval tsb (median = kasus tipikal; mean = optimistis, didorong sedikit event yang pulih). Biaya = nilai pada harga mid awal − hasil diterima. Fee 0.3% identik di kedua strategi sehingga tidak dihitung. Tanpa pemulihan, split = sekaligus (path-independent). Sel hemat = `USD (bps dari ukuran order)`.

| Ukuran USD | Sisi | N | Interval (mnt) | Durasi (j) | Sekaligus bps | Sekaligus USD | Hemat A-median | A-mean pulih | Hemat A-mean | Hemat B-median | B-mean pulih | Hemat B-mean |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10,000 | jual WHSK | 5 | 60 | 4.0 | 233 | 233 | 0 (0) | 0.08 | 28 (28) | 0 (0) | 0.04 | **14 (14)** |
| 10,000 | jual WHSK | 5 | 136 | 9.1 | 233 | 233 | 0 (0) | 0.12 | 40 (40) | 0 (0) | 0.06 | **22 (22)** |
| 10,000 | jual WHSK | 5 | 240 | 16.0 | 233 | 233 | 0 (0) | 0.12 | 40 (40) | 0 (0) | 0.10 | **33 (33)** |
| 10,000 | jual WHSK | 5 | 1440 | 96.0 | 233 | 233 | 0 (0) | 0.18 | 59 (59) | 89 (89) | 0.44 | **118 (118)** |
| 10,000 | jual WHSK | 10 | 60 | 9.0 | 233 | 233 | 0 (0) | 0.08 | 52 (52) | 0 (0) | 0.04 | **27 (27)** |
| 10,000 | jual WHSK | 10 | 136 | 20.4 | 233 | 233 | 0 (0) | 0.12 | 73 (73) | 0 (0) | 0.06 | **43 (43)** |
| 10,000 | jual WHSK | 10 | 240 | 36.0 | 233 | 233 | 0 (0) | 0.12 | 73 (73) | 0 (0) | 0.10 | **61 (61)** |
| 10,000 | jual WHSK | 10 | 1440 | 216.0 | 233 | 233 | 0 (0) | 0.18 | 100 (100) | 135 (135) | 0.44 | **163 (163)** |
| 10,000 | jual WHSK | 20 | 60 | 19.0 | 233 | 233 | 0 (0) | 0.08 | 88 (88) | 0 (0) | 0.04 | **50 (50)** |
| 10,000 | jual WHSK | 20 | 136 | 43.1 | 233 | 233 | 0 (0) | 0.12 | 115 (115) | 0 (0) | 0.06 | **75 (75)** |
| 10,000 | jual WHSK | 20 | 240 | 76.0 | 233 | 233 | 0 (0) | 0.12 | 115 (115) | 0 (0) | 0.10 | **100 (100)** |
| 10,000 | jual WHSK | 20 | 1440 | 456.0 | 233 | 233 | 0 (0) | 0.18 | 145 (145) | 175 (175) | 0.44 | **194 (194)** |
| 10,000 | beli WHSK | 5 | 60 | 4.0 | 233 | 233 | 0 (0) | 0.08 | 27 (27) | 0 (0) | 0.04 | **13 (13)** |
| 10,000 | beli WHSK | 5 | 136 | 9.1 | 233 | 233 | 0 (0) | 0.12 | 40 (40) | 0 (0) | 0.06 | **22 (22)** |
| 10,000 | beli WHSK | 5 | 240 | 16.0 | 233 | 233 | 0 (0) | 0.12 | 40 (40) | 0 (0) | 0.10 | **32 (32)** |
| 10,000 | beli WHSK | 5 | 1440 | 96.0 | 233 | 233 | 0 (0) | 0.18 | 58 (58) | 88 (88) | 0.44 | **117 (117)** |
| 10,000 | beli WHSK | 10 | 60 | 9.0 | 233 | 233 | 0 (0) | 0.08 | 51 (51) | 0 (0) | 0.04 | **27 (27)** |
| 10,000 | beli WHSK | 10 | 136 | 20.4 | 233 | 233 | 0 (0) | 0.12 | 72 (72) | 0 (0) | 0.06 | **42 (42)** |
| 10,000 | beli WHSK | 10 | 240 | 36.0 | 233 | 233 | 0 (0) | 0.12 | 72 (72) | 0 (0) | 0.10 | **60 (60)** |
| 10,000 | beli WHSK | 10 | 1440 | 216.0 | 233 | 233 | 0 (0) | 0.18 | 99 (99) | 134 (134) | 0.44 | **163 (163)** |
| 10,000 | beli WHSK | 20 | 60 | 19.0 | 233 | 233 | 0 (0) | 0.08 | 87 (87) | 0 (0) | 0.04 | **49 (49)** |
| 10,000 | beli WHSK | 20 | 136 | 43.1 | 233 | 233 | 0 (0) | 0.12 | 114 (114) | 0 (0) | 0.06 | **74 (74)** |
| 10,000 | beli WHSK | 20 | 240 | 76.0 | 233 | 233 | 0 (0) | 0.12 | 114 (114) | 0 (0) | 0.10 | **99 (99)** |
| 10,000 | beli WHSK | 20 | 1440 | 456.0 | 233 | 233 | 0 (0) | 0.18 | 144 (144) | 175 (175) | 0.44 | **194 (194)** |
| 50,000 | jual WHSK | 5 | 60 | 4.0 | 1065 | 5,324 | 0 (0) | 0.08 | 609 (122) | 0 (0) | 0.04 | **302 (60)** |
| 50,000 | jual WHSK | 5 | 136 | 9.1 | 1065 | 5,324 | 0 (0) | 0.12 | 888 (178) | 0 (0) | 0.06 | **493 (99)** |
| 50,000 | jual WHSK | 5 | 240 | 16.0 | 1065 | 5,324 | 0 (0) | 0.12 | 888 (178) | 0 (0) | 0.10 | **724 (145)** |
| 50,000 | jual WHSK | 5 | 1440 | 96.0 | 1065 | 5,324 | 0 (0) | 0.18 | 1,300 (260) | 1,955 (391) | 0.44 | **2,613 (523)** |
| 50,000 | jual WHSK | 10 | 60 | 9.0 | 1065 | 5,324 | 0 (0) | 0.08 | 1,146 (229) | 0 (0) | 0.04 | **595 (119)** |
| 50,000 | jual WHSK | 10 | 136 | 20.4 | 1065 | 5,324 | 0 (0) | 0.12 | 1,601 (320) | 0 (0) | 0.06 | **944 (189)** |
| 50,000 | jual WHSK | 10 | 240 | 36.0 | 1065 | 5,324 | 0 (0) | 0.12 | 1,601 (320) | 0 (0) | 0.10 | **1,338 (268)** |
| 50,000 | jual WHSK | 10 | 1440 | 216.0 | 1065 | 5,324 | 0 (0) | 0.18 | 2,204 (441) | 3,003 (601) | 0.44 | **3,646 (729)** |
| 50,000 | jual WHSK | 20 | 60 | 19.0 | 1065 | 5,324 | 0 (0) | 0.08 | 1,951 (390) | 0 (0) | 0.04 | **1,099 (220)** |
| 50,000 | jual WHSK | 20 | 136 | 43.1 | 1065 | 5,324 | 0 (0) | 0.12 | 2,551 (510) | 0 (0) | 0.06 | **1,656 (331)** |
| 50,000 | jual WHSK | 20 | 240 | 76.0 | 1065 | 5,324 | 0 (0) | 0.12 | 2,551 (510) | 0 (0) | 0.10 | **2,216 (443)** |
| 50,000 | jual WHSK | 20 | 1440 | 456.0 | 1065 | 5,324 | 0 (0) | 0.18 | 3,219 (644) | 3,926 (785) | 0.44 | **4,386 (877)** |
| 50,000 | beli WHSK | 5 | 60 | 4.0 | 1065 | 5,324 | 0 (0) | 0.08 | 555 (111) | 0 (0) | 0.04 | **272 (54)** |
| 50,000 | beli WHSK | 5 | 136 | 9.1 | 1065 | 5,324 | 0 (0) | 0.12 | 816 (163) | 0 (0) | 0.06 | **447 (89)** |
| 50,000 | beli WHSK | 5 | 240 | 16.0 | 1065 | 5,324 | 0 (0) | 0.12 | 816 (163) | 0 (0) | 0.10 | **662 (132)** |
| 50,000 | beli WHSK | 5 | 1440 | 96.0 | 1065 | 5,324 | 0 (0) | 0.18 | 1,213 (243) | 1,860 (372) | 0.44 | **2,534 (507)** |
| 50,000 | beli WHSK | 10 | 60 | 9.0 | 1065 | 5,324 | 0 (0) | 0.08 | 1,062 (212) | 0 (0) | 0.04 | **542 (108)** |
| 50,000 | beli WHSK | 10 | 136 | 20.4 | 1065 | 5,324 | 0 (0) | 0.12 | 1,505 (301) | 0 (0) | 0.06 | **869 (174)** |
| 50,000 | beli WHSK | 10 | 240 | 36.0 | 1065 | 5,324 | 0 (0) | 0.12 | 1,505 (301) | 0 (0) | 0.10 | **1,248 (250)** |
| 50,000 | beli WHSK | 10 | 1440 | 216.0 | 1065 | 5,324 | 0 (0) | 0.18 | 2,108 (422) | 2,930 (586) | 0.44 | **3,603 (721)** |
| 50,000 | beli WHSK | 20 | 60 | 19.0 | 1065 | 5,324 | 0 (0) | 0.08 | 1,852 (370) | 0 (0) | 0.04 | **1,017 (203)** |
| 50,000 | beli WHSK | 20 | 136 | 43.1 | 1065 | 5,324 | 0 (0) | 0.12 | 2,461 (492) | 0 (0) | 0.06 | **1,559 (312)** |
| 50,000 | beli WHSK | 20 | 240 | 76.0 | 1065 | 5,324 | 0 (0) | 0.12 | 2,461 (492) | 0 (0) | 0.10 | **2,119 (424)** |
| 50,000 | beli WHSK | 20 | 1440 | 456.0 | 1065 | 5,324 | 0 (0) | 0.18 | 3,153 (631) | 3,893 (779) | 0.44 | **4,371 (874)** |

Ukuran order (USD) yang menimbulkan biaya dampak sekaligus (di luar fee):

| Sisi | ≥10 bps | ≥30 bps | ≥100 bps |
|---|---|---|---|
| jual WHSK | 420 | 1,262 | 4,238 |
| beli WHSK | 420 | 1,262 | 4,238 |

## DEX vs CEX (HashKey Global HSKUSDT, kline 1 menit)

- Sumber: `https://api-glb.hashkey.com/quote/v1/klines?symbol=HSKUSDT&interval=1m&limit=1000&endTime=1795532247000` (endpoint publik, paginasi endTime)
- Menit dibandingkan: 42,981 (2026-10-25 18:37 UTC → 2026-11-24 14:57 UTC); menit dengan volume CEX 0: 61% (close CEX sering basi)
- Selisih DEX−CEX (bps, bertanda): median 4, mean 10
- |selisih| bps: median 40, p75 62, p90 77, p99 222
- Porsi waktu |selisih| >50 bps: 39.2% (DEX di atas: 24.0%, di bawah: 15.2%); >100 bps: 5.3%
- Episode |selisih| >50 bps: 1336, durasi median 3 mnt, p75 9 mnt, maks 1109 mnt
- Episode gap ≥100 bps (awal di menit CEX bervolume): 219; gap tertutup 50% median 21 mnt (219/219 dalam 24 j), 90% median 251 mnt (219/219); ditutup ≥50% oleh gerak harga DEX: 88/219, median 725 mnt
- Timing (mulai tiap jam, 713 sampel, tunggu ≤240 mnt, eksekusi saat selisih menguntungkan ≥25 bps, else akhir window): perbaikan harga relatif CEX vs eksekusi langsung — jual mean 23 bps (median 0), beli mean 31 bps (median 12); batas atas oracle (titik terbaik di window): jual 69 bps, beli 77 bps.
- Catatan: harga DEX = harga setelah swap terakhir sebelum akhir menit; CEX = close kline. Timing hanya berlaku untuk order kecil (tidak memperhitungkan dampak order sendiri).

## Kesimpulan

1. **Split order tidak memberi penghematan nyata pada kasus tipikal di pool ini (timing vs CEX hanya membantu order kecil)**: dalam 30 hari tidak ada satu pun swap ≥30 bps, dan setelah swap ≥5 bps harga median **tidak pulih sama sekali** (18/25 tidak pulih 50% dalam 24 jam); dari 219 episode selisih DEX−CEX ≥100 bps, harga DEX sendiri hanya menutup ≥50% gap pada 88 episode (sisanya CEX yang bergerak) — artinya praktis tidak ada arbitrase aktif yang mengembalikan harga di antara potongan, sehingga split ≈ sekaligus (hemat median 0).
2. Klaim yang jujur untuk demo: (1) agent mengukur & menampilkan biaya dampak nyata sebelum eksekusi (order $10k sekaligus ≈233 bps, $50k ≈1065 bps), (2) timing terhadap harga CEX untuk order kecil memperbaiki harga rata-rata ≈23–31 bps (median 0–12 bps) dengan tunggu ≤4 jam, dan (3) split hanya disebut 'hingga' ≈443 bps untuk $50k/20 potongan/4 jam (76 jam total) di skenario optimistis — bukan angka tipikal.
3. Ukuran order minimum yang membuat agent berguna: ≈$1,262 (dampak ≥30 bps, setara fee tier) dan jelas berguna ≥$4,238 (dampak ≥100 bps); untuk order ≥$10k nilai terbesar agent adalah menyarankan venue lain (CEX/OTC) atau menunda/menolak, karena cadangan virtual pool hanya ≈$419,547 USDT per sisi dan volume DEX 30 hari total ≈$40,651.

## Asumsi & batasan

- Harga sebelum swap = sqrtPrice swap sebelumnya (mint/burn tidak menggeser harga).
- Pemulihan hanya teramati saat ada swap berikutnya (resolusi waktu = jeda antar-swap).
- Simulasi memakai tick map saat ini; likuiditas historis bisa berbeda. Fraksi pemulihan kurva A diukur dari swap kecil (tidak ada swap ≥30 bps) dan diasumsikan berlaku proporsional untuk deviasi besar akibat order sendiri — ini asumsi optimistis; kurva B lebih relevan karena mengukur apakah harga DEX bergerak kembali ke harga CEX.
- Pemulihan empiris mencampur arbitrase dan pergerakan pasar (drift); tidak ada kausalitas yang diklaim.
- Tidak memperhitungkan gas (murah di HSK Chain) maupun risiko harga selama durasi eksekusi.
