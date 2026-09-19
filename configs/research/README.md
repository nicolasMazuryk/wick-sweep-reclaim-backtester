# configs/research — one config per experiment

The run-config schema is `.strict()` and has no comment key (`packages/core/src/config.ts`), so this
file is the comment: it names the hypothesis every config serves (prompt §C "each with a comment field"
→ Tooling gap G2). Every file was validated with `parseRunConfig` (see `specs/research-plan.md` §F).

All files share `fees` (copied from `configs/default.json`, `verifiedAt: 2026-09-19`, re-verified in
Phase 0 step P0.9), `seed: 1` and `data.lowCapSymbol`. `data.lowCapSymbol` is inert for every
command in the plan (every command passes `--symbol`), and `data` is not part of the gate config
hash; Phase 0 step P0.4 substitutes the resolved T4 #1 symbol into **all** files at once, before any
run, so every run shares one config hash per file.

Hashes below are the first 12 hex of `computeConfigHash` / `computeGateConfigHash` at the time of
writing (before the P0.4 substitution, which changes `config` but not `gate`).

| File | Serves | Differs from `base.json` | config | gate | Needs its own reaction run? |
|---|---|---|---|---|---|
| `base.json` | reference (all §8.2 defaults) | — | `0fb08e046a4e` | `8abb77f93458` | — |
| `p0-h0-synthetic.json` | H0 (Phase 0) | none. `wsr backtest --synthetic driftless` does **not** read `--config` (`runSynthetic` in `program.ts`); the file exists so the ledger names a config for every command | `0fb08e046a4e` | `8abb77f93458` | n/a |
| `p2-h2-reaction.json` | H2–H4 (Phase 2, `wsr reaction`) | none — identical gate keys to `p3-h6-baseline.json` on purpose, so Phase-3 backtests reuse its `reaction.json` | `0fb08e046a4e` | `8abb77f93458` | it *is* the reaction run |
| `p3-h6-baseline.json` | H1 (report §3), H5, H6 (Phase 3, `wsr backtest`), long window | none. Same configHash as `p2-h2-reaction.json` ⇒ same `runId`; the backtest writes into the reaction run's directory (superset of files) | `0fb08e046a4e` | `8abb77f93458` | no (reuses Phase 2) |
| `p3-h6-stageb.json` | H6 Stage B as level-quality model (Phase 3 / H12 evidence) | `strengthModel: "stageB"` | `d1ae3e811b6d` | `3e5c9703d91c` | **yes** (`--run-reaction`; `strengthModel` is a gate key) |
| `p4-h8-triggeroffset1.json` | H8 TriggerOffset variant (Phase 4) | `TriggerOffset: 1` | `aae352e73a26` | `df6b29b774fb` | **yes** (`--run-reaction`) |
| `p4-h8-triggeroffset2.json` | H8 TriggerOffset variant (Phase 4) | `TriggerOffset: 2` | `2a0b8fb4d4c3` | `13c89e41fdbc` | **yes** (`--run-reaction`) |
| `p4-h9-blacklist-funding.json` | H9 funding-proximity diagnostic (Phase 4) | `blacklistFunding: true` | `04776da3fc98` | `85edb519b1a9` | **yes** (`--run-reaction`) |
| `p5-h6-grid.json` | H6/H10 grid (Phase 5, `wsr grid`) | explicit `search.grid` = the Spec §6.4 default 1 296-cell grid and `search.targetGrid` = the default 7 × 4 target table, written out so the ledger shows the searched space | `6ed054d07a7b` | `8abb77f93458` | no (`search` is not a gate key ⇒ reuses Phase 2) |
| `p7-h11-transfer.json` | H11 transfer runs on other venues / symbols (Phase 7) | none (separate file so `runs/INDEX.md` can attribute the run) | `0fb08e046a4e` | `8abb77f93458` | no (Phase 2 ran every feasible venue) |

Variants that are CLI flags, not config keys (`--variants armMode,timeStop,counterTrendBlock,targetMode,ageClock`,
`--latency-sweep`, `--slippage-sweep`), are applied by `wsr backtest` on top of `p3-h6-baseline.json` and
counted in `folds.json.nConfigs` (8 variants × 4 latency points = 32 per run).

Re-validate after any edit (from the repo root, after `pnpm build`):

```sh
for f in configs/research/*.json; do
  node -e "import('./packages/core/dist/config.js').then(m => { m.parseRunConfig(JSON.parse(require('fs').readFileSync('$f', 'utf8'))); console.log('ok $f'); })"
done
```
