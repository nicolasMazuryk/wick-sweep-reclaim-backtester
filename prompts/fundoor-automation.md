# Prompt for Claude Code: examine Fundoor hands-on, then design the arbitrage-analysis system

## Before you run it (setup notes for me, not part of the prompt)

1. Create an empty project folder, run `git init`, and start Claude Code there.
2. Do not paste the password into the chat. Create a `.env` file in the project folder instead:
   ```
   FUNDOOR_LOGIN=...
   FUNDOOR_PASSWORD=...
   ```
   Pasted credentials end up in the conversation transcript and logs; a file that scripts read keeps them out.
3. Optional but it saves time: add a browser MCP server before starting, e.g. `claude mcp add playwright npx @playwright/mcp@latest` and/or `claude mcp add chrome-devtools npx chrome-devtools-mcp@latest` (check the current install commands in each project's README). The prompt also lets Claude Code set this up itself.
4. Save the four screenshots into `docs/screenshots/` so Claude Code can look at them.
5. Fill in the `[brackets]` below, then paste everything under the line.

---

## Your task

Examine a login-gated web app hands-on, work out the best way for you (Claude Code) to extract data from it, and then design the system that will let you analyze that data for me on a regular basis. This session is **investigation and design**. It ends with a written findings report, a recommended architecture, and a build plan. Do not build the full system yet; stop and wait for my approval after the report.

I am deliberately giving you access instead of asking for a theoretical comparison: base every conclusion on what you actually observe on the site, and say so when something is an assumption rather than an observation.

## Context

I do crypto spread and funding-rate arbitrage: long on one exchange, short on another, collecting the price gap and/or the funding differential. For analysis I use a paid web service, https://fundoor.pro/, behind a user login. As far as I know it has no public API; verify this early, because an official API would change everything.

What I know about the service (screenshots in `docs/screenshots/`):

- **Scanner / Pair scanner**: real-time table of arbitrage pairs, auto-refreshing every few seconds. Columns include long/short exchange, entry spread %, deviation, funding per leg with interval (1h/4h/8h), APR, accrued funding over 1/3/7 days, 24h volume, open interest. Many filters (asset types such as Crypto and RWA, exchanges per side, funding periods, liquidity, statuses, blacklists/whitelists) and saved **filter profiles** (e.g. "Default", "Funding").
- **Top rates**: best single-exchange funding setups with funding, next payment time, APR, deviation, accrued sums over 1d/3d/7d/15d/30d, paginated.
- **History**: per-token funding history chart across ~20 exchanges, raw / annual / accrued views, selectable period, a **CSV export** button, URL parameters (e.g. `/history?token=BTC`).
- **Spread**: per-pair page with a candlestick chart of the entry spread (15s to 1h bars), entry/exit spread, per-leg funding, mark/index and deviation, funding limits, live order books for both legs, position limits, volume and OI, and a **funding PnL backtest** based on actual payments.
- **Tools**, Telegram and browser notifications, and other pages I have not listed. Find them.

The charts (spread history, funding history) are the most important inputs to my analysis. They are rendered graphics, so find the data series behind them; do not plan on reading pixels.

## End goal of the system (for orientation)

You operate or read Fundoor, extract the relevant data efficiently, evaluate it, and give me a ranked shortlist of the best current opportunities with reasoning. I decide and place trades myself. The arbitrage scoring logic is a separate later task; treat it as a pluggable module that receives clean structured data.

## Access and credentials

- Credentials are in `.env` as `FUNDOOR_LOGIN` and `FUNDOOR_PASSWORD`. Login method: [email + password].
- Never print, echo, log, or commit the credentials, session cookies, or tokens. Do not `cat .env`. Read them only inside scripts, and redact secrets in anything you write to disk or show me (HAR files, captured headers, docs).
- Your first action in the repo: add `.env`, the auth/session state file, and the raw capture folder to `.gitignore`.
- Log in once, save the browser session state to a file, and reuse it for the rest of the session. Avoid repeated logins.
- If you hit a captcha, 2FA, email confirmation, or anything that looks like bot detection, stop and ask me; I can complete that step by hand in a visible browser window.

## Rules while on the site

- Behave like one human user: modest request rates, no parallel hammering, no brute-force enumeration of endpoints or tokens. When replaying an endpoint, a handful of calls is enough to confirm behavior.
- Stay on fundoor.pro and the hosts its front end talks to.
- If you see signs of rate limiting or blocking (429s, forced logouts, challenge pages), stop and report.

## Phase A: tooling check

Check which browser tools you have in this session (Playwright MCP, Chrome DevTools MCP, or similar). If none is available, propose the best option, give me the exact install command, and wait; or fall back to writing Playwright scripts yourself. Tell me which tool you chose for the investigation and why. My machine: macOS, preferred language for scripts: TypeScript.

## Phase B: investigation

Keep your context small while you do this: save raw captures (HAR, response bodies, WebSocket frames) to `captures/` and read them with scripts or `jq`, rather than dumping page snapshots and payloads into the conversation. Write findings to disk as you go so nothing is lost if the session is interrupted.

1. **Site map.** Visit every page and tool reachable from the navigation, including sub-tabs (e.g. Funding / Components / Events / Trade on the Spread page) and the help tooltips that explain filters. Build the full list of features with their full set of parameters and understanding how to use them as a power user. Record for each: URL, URL parameters, purpose, what data it shows, and whether it matters for arbitrage analysis.
2. **Auth mechanism.** Cookie or bearer token, where it is stored, lifetime, refresh behavior, and whether the data requests work outside the browser with the session attached.
3. **Network traffic per page.** For each important page capture the XHR/fetch calls and WebSocket connections: endpoint, method, parameters, response shape and size, how filters and profiles map to request parameters (server-side or client-side filtering), pagination, and how the auto-refresh works (polling interval or push).
4. **The data behind the charts.** For funding history and the spread candlestick chart: the endpoint, time range and resolution limits, maximum history available, and response size for typical queries.
5. **CSV export.** What triggers it (client-side generation or a server endpoint), its columns, and whether it offers anything the JSON does not.
6. **Replay test.** Take the key endpoints and call them directly from a script with the saved session (no browser). Record what works, what needs extra headers or signatures, and any anti-bot protection (Cloudflare or similar).
7. **Other sources.** Check for official API docs, a public API section, or anything in Tools that exports data. Note whether the Telegram alerts could serve as a trigger for runs.
8. **Cost measurements.** For the same piece of data (e.g. the current scanner table), estimate the token cost and latency of getting it through AI-driven browser control versus a script or direct call. Use real numbers from your captures.

Deliverables of this phase:
- `docs/site-map.md`
- `docs/api-notes.md`: every endpoint and WebSocket channel with parameters, redacted example request, trimmed example response, and a draft schema
- `docs/auth.md`: how the session works and how to persist and renew it
- redacted samples in `captures/samples/`

## Phase C: findings report and recommendation

Write `docs/architecture.md` and summarize it for me in chat. It must contain:

1. **Comparison of extraction approaches, based on your evidence**: AI-driven browser control, scripted headless Playwright returning JSON, direct endpoint/WebSocket calls with my session, plus anything else you found (official API, CSV export, URL parameters). Compare reliability, setup effort, token cost per run, latency, fragility when the site changes, login handling, real-time handling, access to chart series. A table plus a short paragraph each.
2. **One recommended architecture** (hybrids are fine), with the runner-up and the condition under which you would switch. Cover:
   - session persistence, expiry detection, and secret hygiene
   - real-time strategy: snapshot, short sampling window, or WebSocket subscription, given that I run the analysis [on demand, a few times a day, every 15 min]
   - normalized schema and a local store (e.g. SQLite) so history is fetched incrementally
   - a funnel to control cost: cheap wide scan (scanner, top rates), then deep-dives (history, spread series, backtest, order book) only for the top N candidates
   - your own interface to the data: CLI, custom MCP server, or both; what runs as deterministic code and what is left to your reasoning; how raw data stays out of the context window
   - packaging in Claude Code: CLAUDE.md contents, skills or slash commands (e.g. `/scan`, `/deep-dive TOKEN`), subagents, hooks, headless mode for scheduled runs, and the format of the final shortlist
   - resilience: schema validation, detection of site changes, fallback path, rate limiting and backoff, freshness timestamps on every data point, handling of the known data quirks
   - where my filter configuration lives: Fundoor profiles, my own config file, or both
4. **Build plan** in phases, each ending in something I can run and verify: objective, steps, tools and libraries, deliverable, acceptance check. Include the repository layout. Keep the scoring model as a one-paragraph interface placeholder.

Then stop and wait for my go-ahead.

## Working style

- Ask me questions only when the answer would change the architecture or when a rule above tells you to stop; otherwise state your assumptions and proceed.
- Give me a short progress note at the end of each phase.
- Verify tool capabilities and current Claude Code features from documentation where it matters instead of relying on memory.
- Be opinionated and concrete: commands, file names, schemas, example tool signatures.
- If something on the site contradicts my description above, trust what you observe and tell me.