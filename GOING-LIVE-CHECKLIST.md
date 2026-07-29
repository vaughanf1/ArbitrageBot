# Going live — runbook

**Status (2026-07-24, rewritten for Polymarket US):** Cesar's funds ($59) are on
**Polymarket US (QCEX)** — the CFTC-regulated US exchange, a completely separate
venue from global Polymarket with its own accounts and API. The bot now has a
dedicated US connector, verified live against Cesar's account (auth OK, balance
visible, his manual UFC position visible). Live order placement is built,
safety-gated, and verified up to (but not including) transmitting a real order.

## What the bot trades now

Primary strategy: **Polymarket US multi-outcome event arbitrage.** On the US
exchange each market is one instrument (Yes = long, No = short of the same
thing), so the old YES+NO trick can't exist inside one market. Instead: a
multi-outcome EVENT (e.g. "NL Champion" — one market per team) has independent
books, and exactly one outcome pays $1. If buying long on EVERY outcome costs
under $1 combined, the difference is locked-in profit.

**Exhaustiveness rule:** that logic is only riskless if the listed outcomes
cover every possibility. Sports events (game winner, league champion) are
exhaustive by construction and may auto-fire. Everything else (politics etc.)
is **review-only, never auto-fires** — a missing candidate makes "sum under $1"
a bet, not an arb. First live scan found a real 3.09% edge (Kansas Governor,
correctly held for review) — the US books are visibly less efficient than the
global ones, so expect more signals here than the global scanner ever showed.

The global-Polymarket YES+NO scanner still runs (paper-only — no funds there).
Kalshi and BitGet integrations remain in the code but are retired from live use.

## The three switches

A real order leaves the engine only when ALL THREE are set in Railway
(engine service → Variables):

| Variable | Live value | What it does |
|---|---|---|
| `TRADING_MODE` | `live` | Global paper/live switch |
| `LIVE_VENUES` | `polymarket-us` | Only listed venues may trade for real |
| `EXECUTION_DRY_RUN` | `false` | While `true` (default): orders are built and signed but **never sent** |

Anything else = simulation. If in doubt, set `EXECUTION_DRY_RUN=true` — that is
always safe.

### Fourth gate: no half-real trades (added 2026-07-24)

The engine refuses to auto-trade any opportunity whose legs span a live venue and
a simulated one. This matters because the retired Polymarket↔Kalshi scanner still
runs and still produces most of the opportunities you see on the dashboard: with
`LIVE_VENUES=polymarket`, those pairs would otherwise buy the Polymarket leg with
**real money** and simulate the Kalshi hedge — leaving a naked directional bet
while the dashboard books it as a locked, riskless spread. The partial-fill
unwind does not catch this, because the simulated leg always reports success.

Blocked opportunities are logged as:
`SKIPPED: opportunity spans live and simulated venues`

Seeing these in the Stage 1 log is **correct behaviour**, not an error. In live
mode the only strategy that can actually trade is the single-venue Polymarket
YES+NO arb. Related: trades are now recorded with the mode they *actually*
executed in, so paper fills can never appear as live P&L.

## Stage 0 — prerequisites (once)

> **2026-07-24, all cleared:** Cesar's US-app account is funded ($59 buying
> power) and his developer API key (from polymarket.us/developer) is verified
> working — signed balance + positions reads return his real data. Credentials
> are set in Railway (`POLYMARKET_US_KEY_ID` / `POLYMARKET_US_SECRET_KEY`) with
> `LIVE_VENUES=polymarket-us`. The old global-CLOB wallet-key prerequisites
> below are struck: that account is empty and no longer the live venue.

- [x] **Deployment is up** (redeployed fresh into Cesar's Railway, 2026-07-22 —
      project `cesar-arb-bot`):
      - Dashboard: https://dashboard-production-1fb7.up.railway.app
      - Engine: https://engine-production-af7b.up.railway.app
      - Engine runs in **paper mode** with `LIVE_VENUES=polymarket` and
        `EXECUTION_DRY_RUN=true` pre-staged; `CONTROL_TOKEN` is set (Vaughan has
        it). Going to Stage 1 = flip `TRADING_MODE` to `live` in Railway.
      - Note: deployed via `railway up` from the local repo, not GitHub-linked.
        To redeploy after code changes: `railway up --service engine` (and/or
        `--service dashboard`) from the repo root, logged in as Cesar.
- [x] **Fund the account**: $59 buying power confirmed via the US API 2026-07-24.
      Cesar has also placed a manual trade (1 UFC contract) which shows up
      correctly through the API — the read path against his real account works.
- [x] **API credentials**: `POLYMARKET_US_KEY_ID` + `POLYMARKET_US_SECRET_KEY`
      set in Railway and verified live (signed balance/positions reads OK).
      The secret travelled over Skool DM — same accepted-risk decision as the
      old wallet key, with the account balance as the cap; it can be revoked
      and reissued at polymarket.us/developer any time.
- [x] `CONTROL_TOKEN` — set. Without it, limits/start/stop/resume are
      **locked** (kill switch always works).
- *(Superseded: the global-CLOB wallet-key / funder-address items. That
  account holds $0 and is no longer the live venue; its key stays configured
  only so the paper-mode global scanner keeps market data.)*
- [ ] **Dashboard**: Controls page → paste the same `CONTROL_TOKEN` value into the
      Control token field → Save. This authorises your browser.
- [ ] **Risk limits for the trial** (Controls page): Max trade size **$10**,
      Max daily exposure **$50**, Min spread **0.5%**.

## Stage 1 — dry run (mandatory, ≥ 1 trading day)

Set `TRADING_MODE=live`, `LIVE_VENUES=polymarket-us`, keep `EXECUTION_DRY_RUN=true`.

> **Started 2026-07-24:** `TRADING_MODE=live` set in Railway with dry-run ON.
> The wallet key was also verified directly against the CLOB the same night
> (L2 API creds derive cleanly — no auth errors). Dry-run trades are recorded
> as `paper` on the dashboard, since no money moves; the `live` label is
> reserved for real transmitted orders.

The engine log (Railway → engine → Logs) will show:
`LIVE venues enabled in DRY-RUN: orders will be signed but NOT sent`

What you're verifying:
- [ ] Engine runs without auth errors from Polymarket (a bad key/funder shows up here).
- [ ] If an opportunity fires, the trade appears on the dashboard with both legs —
      that entire path (market lookup, sizing, signing) ran against real credentials,
      stopping only at transmission.
- [ ] No crashes/restarts over the day.

## Stage 2 — first real money (supervised)

Only after a clean Stage 1. **Do this while watching the dashboard and logs live.**

1. Confirm limits: max trade size $10.
2. Set `EXECUTION_DRY_RUN=false` in Railway (service restarts). The log line
   changes to: `*** LIVE venues enabled and DRY-RUN OFF: real orders will be
   transmitted ***`
3. Wait for the first trade. Then **reconcile against Polymarket itself**: open
   your Polymarket account and confirm you actually hold the YES and NO positions
   the dashboard shows, at roughly the recorded prices.
4. If anything looks wrong → hit the **kill switch** (dashboard, no token needed)
   and set `EXECUTION_DRY_RUN=true`.

**What can go wrong, and what the bot does:**
- *One leg fills, the other fails* (price moved): the bot automatically sells back
  the filled leg. You lose the spread — cents at $10 size.
- *The unwind itself fails*: kill switch trips automatically, a CRITICAL log line
  is written, and the bot stops. You then close the position by hand in Polymarket.

### Incident 2026-07-29 — false rejections hid real fills (FIXED)

The first Stage 2 attempts all showed `failed / $0.00` with
`ORD_REJECT_REASON_EXCHANGE_OPTION`. That string is the **default value** the
exchange stamps on *every* execution report, success included; the executor
misread it as a rejection, so each arb's first leg filled for real while the
bot recorded a failure, aborted the other legs, and retried later. Result: an
untracked 50-contract long ("NFC East Winner — PHI", $18.70) that appeared
nowhere on the dashboard. Resolution: parsing fixed (only
`EXECUTION_TYPE_REJECTED` counts, real reason read from the `text` field,
commit `59a0d71`), position sold back at $0.35 (≈ $1.90 loss), and a
**reconciliation guard** added: every 10 minutes and after every live trade
the engine compares exchange positions against the ledger's net live fills and
exposes the result as `reconciliation` in `/api/status` (warn-only — Cesar
trading manually in the same account also shows up here). If `ok: false`
appears, find out why before trusting anything else the dashboard says.

## Stage 3 — scale (gradual)

- [ ] 3–5 clean, reconciled fills at $10 before any increase.
- [ ] Raise max trade size stepwise: $25 → $50 → $100. Reconcile at each step.
- [ ] Raise daily exposure in proportion (5× trade size is a sane ratio).

## Controls reference

- **Kill switch (dashboard)** — halts all trading instantly. Never needs a token.
  Resuming does.
- **Limit changes / start / stop / resume** — need the control token (Controls page).
- **`EXECUTION_DRY_RUN=true` in Railway** — the hard off-switch for real orders,
  independent of everything else.

## Known limitations (accepted at handover)

1. **P&L is booked at entry.** When a pair fills, the dashboard books the locked
   edge immediately, but the **cash stays in Polymarket until the market resolves**
   (possibly weeks/months). Dashboard P&L is locked value, not withdrawable cash.
2. **No automated test suite.** The code is typechecked and was manually verified
   end-to-end; regressions rely on the dry-run stage catching them.
3. **Repo location**: code lives in `vaughanf1/ArbitrageBot` (Vaughan's GitHub);
   Railway deploys from it. Transferring the repo to Cesar's GitHub is an open
   handover item — everything else already runs in Cesar's Railway.
4. **Read endpoints are public**: anyone with the engine URL can see status/trades
   (not change anything). Acceptable for now; say the word if you want reads locked.
