# Recorded venue fixtures (Spec §11.5)

Small extracts of the real archives for ETHUSDT, UTC day 2025-01-09, downloaded
2026-09-19 and re-compressed in each venue's own format (zip or csv.gz):

| venue | source archive(s) | extract |
|---|---|---|
| binance | `futures/um/daily/trades/ETHUSDT/ETHUSDT-trades-2025-01-09.zip` | header + first 1 500 rows; `.CHECKSUM` = sha256 of this zip, `.CHECKSUM.bad` = wrong hash |
| bybit | `trading/ETHUSDT/ETHUSDT2025-01-09.csv.gz` | header + first 1 500 rows |
| okx | `…/daily/20250109/ETH-USDT-SWAP-trades-2025-01-09.zip`, `…/20250110/…-2025-01-10.zip` | per file: 750 rows before + 750 rows after UTC midnight (files are cut on the UTC+8 day) |
| bitget | `UMCBL/ETHUSDT/20250109_00{1..4}.zip`, `20250110_00{1..3}.zip` | `20250109_001`: 500 rows before 2025-01-09 00:00Z; `_002`: 500 rows after; `20250110_001`: 500 rows before + 500 after 2025-01-10 00:00Z |
| gate | `futures_usdt/trades/202501/ETH_USDT-202501.csv.gz` | first 300 rows of the month, rows within ±60 s of 2025-01-09/10 00:00Z (≤ 600 each), 300 rows from 2025-01-31 |
| kucoin | `futures/daily/trades/ETHUSDTM/ETHUSDTM-trades-2025-01-09.zip` | header + first 1 500 rows |

`files.json` lists each fixture day's files in delivery order, `meta.json` is the
instrument record fetched from the venue API on the same date, and
`expected.json` holds the golden `CanonicalTrade`s. Regenerate goldens only for an
intended adapter change: `pnpm build && node fixtures/venues/make-goldens.mjs`.
