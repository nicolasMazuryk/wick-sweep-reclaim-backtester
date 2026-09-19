# Prompt: execute the WSR research plan, one phase per session

PHASE = next        # "next" = lowest phase without runs/MEMO-phase<N>.md; set 0-7 only to force a phase

You are the executing agent for `specs/research-plan.md` on the OCI research VM, inside tmux, from
`~/wick-sweep-reclaim` (`data/` and `runs/` are symlinks to `/mnt/wsr`). The plan is the contract:
you run it, you do not redesign it. Execute exactly one phase, then stop.

READ FIRST (every session, in full)
`specs/research-plan.md` (§0, §A, §C common rules + Phase PHASE, C.8, C.9, §D, §E, §G),
`specs/hypothesis-register.md`, `configs/research/README.md`, `research/data-manifest.json`,
`specs/tooling-gaps.md`. Then state, before running anything: the resolved PHASE, its hypotheses and
their pre-registered thresholds, the prior-phase outputs it consumes, and its C.8 time/disk estimate.

RESUME / PRECONDITIONS
- Reconstruct state from disk only: `runs/INDEX.md`, `runs/MEMO-phase*.md`, `research/universe.json`,
  §G. Assume no memory of earlier sessions.
- Do not start phase N > 0 unless `runs/MEMO-phase<N-1>.md` exists and its go/no-go says go. A kill
  verdict in any earlier memo (e.g. H0 FAIL, H2 FAIL on every Binance symbol) ⇒ report it and stop.
- Partially done phase: skip every command whose `runs/INDEX.md` row has exit 0 or 3 and whose
  `runs/<runId>/` outputs exist; resume an interrupted grid with `grid --run-id <gridRunId>`.
- `git pull`; if HEAD moved: `pnpm install --frozen-lockfile && pnpm build`.

EXECUTE
- Run the phase's commands as written (`CLI` = `node packages/cli/dist/main.js`). Substitute only the
  placeholders the plan says earlier phases resolve (symbols from `research/universe.json`, passer
  lists and selections from earlier memos, runIds from `runs/INDEX.md`).
- Long commands run in the background; poll their logs. At most 3 concurrent `reaction`/`backtest`
  jobs and 1 `grid` (§C). Watch disk against the A.8 trim rule.
- Append every command to `runs/INDEX.md` immediately after it returns (columns per §C).
- Exit 3 = gate FAIL: a result, record it and continue. Exit 5 = invariant bug: stop the phase and
  write a bug report. Exit 1/2/4: diagnose; fix it if it is your invocation or data, else stop and report.
- Tooling gaps: use only the workaround the plan documents for that G-id (scripts under `research/`,
  never edits under `packages/`). No documented workaround ⇒ record the deviation, skip, continue.
- Phase 5 burst: `infra/oci/scripts/burst.sh` runs from the laptop. Stop and ask the user to run
  `burst.sh up`; continue only after confirmation. After the grid, ask for `burst.sh down`.

RULES (binding; summary of §D, which wins on conflict)
- Thresholds, bins, seeds, slices, universe and trim rules are fixed. Never change them after seeing data.
- No BTC- or ETH-based symbol anywhere. No `--force-pnl` run feeds a verdict. Every tested config
  counts toward N_configs in `runs/INDEX.md`.
- Anything not pre-registered is reported under "Post-hoc observations", never in a verdict.
- Any deviation (missing flag, file differs from plan, budget exceeded > 2×) ⇒ memo + §G, with reason.
- Fee `[VERIFY]` differences are fixed in all research configs before Phase 3 (P0.5).
- Do not commit, push, delete data, resize the VM or touch terraform.

FINISH THE PHASE
- Write `runs/<runId>/MEMO.md` per run and `runs/MEMO-phase<PHASE>.md` per the C.9 template: numbers
  with CIs, PASS/FAIL per hypothesis against the register threshold, deviations, post-hoc
  observations, go/no-go for the next phase and its input list.
- Phase 7 (or any kill): fill §E into `runs/VERDICT.md`.
- Stop. Final message: phase, hypothesis verdict table, runIds, wall-clock and disk vs C.8, deviations,
  next action (including anything the user must do by hand).
