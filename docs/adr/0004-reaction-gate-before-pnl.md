# 0004. Reaction gate before any P&L

Status: accepted

## Context
With entry at the WickLevel, stop at 1x and target at 2x the sweep depth, a driftless path hits the target first one time in three. A P&L backtest on a grid of parameters will find something. The question that matters comes first: do these levels cause a reaction at all?

## Decision
The order of work is fixed: reaction test, gate, target validation, walk-forward and grid, then reports. `wsr backtest` and `wsr grid` refuse to run (exit 3) unless a stored `reaction.json` matching the venue, symbol, span and gate config hash passed. Only `--run-reaction` (rerun) or `--force-pnl` (labelled `forced` in the output, diagnostic only) bypass this. Gates, thresholds and kill rules are pre-registered in `specs/hypothesis-register.md` and `specs/research-plan.md` before data is run. The optimised parameters are capped at six. Overfitting is reported through the number of configs tried, the Deflated Sharpe ratio and White's reality check.

## Consequences
- The research can end at the gate. It did: the project was stopped after Phase 2 with verdict (a), "no level effect" (`specs/research-plan.md`, decision log).
- A failed hypothesis is a valid result, so the repo ships the tooling and the honest verdict.
