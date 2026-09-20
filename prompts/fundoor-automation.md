# Prompt: Design a Claude Code workflow for automated Fundoor arbitrage analysis

> Attach the four Fundoor screenshots (History, Pair scanner, Top rates, Spread) when you send this.

---

## Role and task

You are a senior engineer who builds data-extraction pipelines and Claude Code automations (MCP servers, skills, subagents, headless/scheduled runs). Design the technical system that lets Claude Code pull data out of a login-gated web app and analyze it for me. I am asking for an architecture and a build plan, not for the code yet and not for trading strategy.

## Context

I do crypto spread and funding-rate arbitrage: long on one exchange, short on another, collecting the price gap and/or the funding differential. For analysis I use a paid web service, https://fundoor.pro/. It sits behind a user login and I have an account. As far as I know it has no public API or API documentation; verify this first, because an official API would change everything.

What the service contains (see screenshots):

- **Scanner / Pair scanner**: a real-time table of arbitrage pairs, auto-refreshing every few seconds. Columns include long/short exchange, entry spread %, deviation, funding per leg with interval (1h/4h/8h), APR, accrued funding over 1/3/7 days, 24h volume, open interest. It has a large set of filters (asset types such as Crypto and RWA, exchanges per side, funding periods, liquidity, statuses, blacklists/whitelists) and saved **filter profiles** (e.g. "Default", "Funding").
- **Top rates**: the best single-exchange funding setups, with funding, next payment time, APR, deviation, and accrued sums over 1d/3d/7d/15d/30d, paginated (dozens of pages).
- **History**: per-token funding history chart across ~20 exchanges, with raw / annual / accrued views, selectable period (1d to 180d+), a **CSV export** button, and URL parameters (e.g. `/history?token=BTC`).
- **Spread**: a per-pair page with a candlestick chart of the entry spread over time (15s to 1h bars), current entry/exit spread, per-leg funding, mark/index price and deviation, funding limits, live order books for both legs, position limits, 24h volume and OI, and a **funding PnL backtest** based on actual payments (long accrued, short accrued, spread accrued, APR).
- **Tools**, built-in Telegram and browser notifications, and other pages I have not listed.

The charts (spread history, funding history) are the most important inputs to my analysis. They are rendered graphics, so the underlying series must come from the data behind them, not from reading pixels.

## Goal

Claude Code should operate and read Fundoor, extract the relevant data in the most efficient way, evaluate it, and give me a **ranked shortlist of the best current opportunities with reasoning**. I make the final decision and place trades myself. The system is strictly read-only: it never places orders and never touches exchange accounts.

Focus on **how Claude Code works with Fundoor effectively**. The arbitrage scoring logic itself is a separate later task; for now treat it as a pluggable module that receives clean structured data.

## My setup (assumptions; correct me if they matter)

- OS: macOS. Claude Code runs locally on my machine.
- I run the analysis: scheduled runs and alerts would be a nice later step.
- Single user, single Fundoor account. Login method: email + password.
- I am comfortable with TypeScript and can run scripts, but I want Claude Code to write and maintain them.

## What I need from you

### 1. Compare the ways to get data out of Fundoor

Evaluate each approach on: reliability, setup effort, token cost per run, latency, fragility when the site changes, login/session handling, handling of real-time updates, ability to get the series behind the charts, and account/ToS risk.

- **AI-driven browser control** (Playwright MCP, Chrome DevTools MCP, Claude in Chrome, or whatever is best today). Say which one you would choose and why.
- **Scripted headless browser** (Playwright) that Claude Code writes once and then just runs, returning structured JSON.
- **Direct calls to the site's own endpoints**: discover the XHR/fetch/WebSocket traffic the front end uses, then call it with my authenticated session (cookies or token).
- Anything else worth considering (official API if one exists, the CSV export and URL parameters as a semi-official interface, Fundoor's Telegram alerts as a trigger source).

Present this as a comparison table plus a short paragraph per approach. Be specific about token cost: a live table that refreshes every 5 seconds and DOM snapshots of a dense dashboard are very different from a 20 KB JSON response.

### 2. Recommend one architecture

Pick a primary approach (hybrids are fine, e.g. AI-driven browser for one-time discovery, scripts or direct endpoint calls for daily use, browser automation as fallback) and justify it. Cover:

- **Discovery phase**: how to map the site's endpoints, payload shapes, auth mechanism, and WebSocket messages (e.g. HAR capture, DevTools MCP network inspection), and how to document the findings so later sessions do not repeat the work.
- **Auth and session**: how to log in once, persist and refresh the session, detect expiry.
- **Real-time data**: snapshot vs. short sampling window vs. WebSocket subscription, and what is actually needed for a ranking produced every 1h.
- **Data layer**: normalized schema for scanner rows, funding history, spread history, order-book/liquidity snapshots; local cache or store (e.g. SQLite/Parquet) so history is fetched incrementally rather than re-downloaded.
- **Funnel to control cost**: a cheap wide scan first (scanner, top rates), then expensive deep-dives (history, spread chart, backtest, order book) only for the top N candidates.
- **The Claude Code interface**: whether to expose the data layer as a CLI, a custom MCP server, or both; what belongs in deterministic code versus in Claude's reasoning; how to keep raw data out of the context window and pass only compact summaries.
- **Packaging inside Claude Code**: CLAUDE.md contents, skills or slash commands (e.g. `/scan`, `/deep-dive TOKEN`), subagents, hooks, headless mode for scheduled runs, and the output format of the final shortlist.
- **Resilience**: schema validation, detection of site changes, fallback path, rate limiting and backoff, freshness timestamps on every data point, and explicit handling of the site's known data quirks.
- **Where my filter configuration lives**: in Fundoor's saved profiles, in my own config file, or both.

### 4. Build plan

A phased plan where each phase ends in something I can run and verify:

- Phase 0: discovery and feasibility check (what to capture, what decides between the approaches)
- Phase 1: minimal extractor for one page
- Following phases up to the full scan, deep-dive, and ranked-report loop, then optional scheduling and alerts

For each phase give: objective, concrete steps, tools and libraries, the deliverable, an acceptance check, and the prompt or instruction I should give Claude Code to execute it. Include a proposed repository layout.

## How to respond

- Ask clarifying questions first only if an answer would change the architecture; otherwise state your assumptions explicitly and proceed.
- Check current information where it matters (the state of browser-automation MCP servers and Claude Code features changes quickly); do not rely on memory for tool capabilities.
- Be opinionated: one recommendation, with the runner-up and the condition under which you would switch to it.
- Prefer concrete detail (commands, file names, schemas, example tool signatures) over general advice.
- Do not write the full implementation and do not design the arbitrage scoring model; a one-paragraph placeholder for the scoring interface is enough.