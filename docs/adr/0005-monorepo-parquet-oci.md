# 0005. pnpm monorepo, Parquet storage, OCI compute

Status: accepted

## Context
The system downloads about a year of trades for six venues and replays them many times. It needs clear module boundaries, columnar storage and cheap long-running compute.

## Decision
- **Monorepo:** pnpm workspace with `@wsr/core` (pure engine), `@wsr/data` (venue adapters and storage), `@wsr/backtest` (replay, statistics, grid) and `@wsr/cli`. Dependency direction (core imports nothing, data imports core, and so on) is enforced by ESLint `import/no-restricted-paths` and fails CI.
- **Storage:** Parquet partitions per venue, symbol and day, with sha256 checksums recorded in `run.json`.
- **Compute:** one Always-Free ARM VM on Oracle Cloud (4 OCPU, 24 GB), Terraform-managed under `infra/oci`, with a 170 GB block volume and an in-place resize to 16 OCPU for the heavy grid phases. Results sync hourly to a private bucket. A budget and alarms guard cost.

## Consequences
- Layer violations cannot merge.
- Raw data stays out of git. Only small recorded fixtures are committed.
- The VM address is deliberately not committed; `infra/oci` takes it from Terraform output.
