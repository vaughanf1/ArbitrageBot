# Going live — runbook

**Status at handover (2026-07-20):** live order placement is **built, safety-gated,
and verified up to (but not including) transmitting a real order.** The final switch
is deliberately left to you, following the procedure below. Do not skip stages.

## What the bot trades now

One strategy: **single-market Polymarket arbitrage.** A binary market has a YES and
a NO token; exactly one pays $1 at resolution. If YES + NO can be **bought together
for less than $1**, the difference is locked-in profit with no prediction involved.
The bot reads the live order book (not indicative prices), sizes to the depth
actually available, and only fires when the combined cost is under $1 after fees.

**Set your expectations accordingly:** on liquid markets this window is rare —
market makers keep YES+NO at or above $1.00 nearly all the time (at handover the
tightest book across the top markets was $1.001). The bot's job is to be there in
the seconds when someone leaves money on the table. It may find nothing for days.
That is the market being efficient, not the bot being broken.

Kalshi and BitGet integrations remain in the code but are retired from live use.

## The three switches

A real order leaves the engine only when ALL THREE are set in Railway
(engine service → Variables):

| Variable | Live value | What it does |
|---|---|---|
| `TRADING_MODE` | `live` | Global paper/live switch |
| `LIVE_VENUES` | `polymarket` | Only listed venues may trade for real |
| `EXECUTION_DRY_RUN` | `false` | While `true` (default): orders are built and signed but **never sent** |

Anything else = simulation. If in doubt, set `EXECUTION_DRY_RUN=true` — that is
always safe.

## Stage 0 — prerequisites (once)

> **Checked at handover (2026-07-20):** the account behind the wallet key holds
> **$0 USDC with no exchange allowances** (confirmed via the Polymarket CLOB API).
> Until it is funded, flipping every switch below produces exactly nothing —
> funding is the first real blocker, and only Cesar can clear it.

- [ ] **Verify the deployment is up**: the dashboard URL in this repo's history
      returned 404 at handover. Open Cesar's Railway, confirm the engine +
      dashboard services exist and are deployed from `vaughanf1/ArbitrageBot@main`,
      and note the current public URLs.
- [ ] **Fund Polymarket**: deposit USDC in the Polymarket app (start small:
      $200–500). Trading through the app once also sets the exchange allowances.
- [ ] **Confirm the funder address**: `POLYMARKET_FUNDER_ADDRESS` must be the
      deposit/proxy address shown in your Polymarket profile — copy it fresh from
      the app, don't trust old notes. A wrong funder is caught safely (the first
      real order is rejected, nothing fills) but it will stall go-live.
- [ ] **Rotate your wallet key**: the current key was shared over chat during the
      build. Export a fresh one at `reveal.magic.link/polymarket` *after* changing
      account credentials, or accept the risk knowingly (your call — it holds your
      trading funds).
- [ ] **Railway engine variables set**:
  - `POLYMARKET_PRIVATE_KEY` — exported wallet key
  - `POLYMARKET_FUNDER_ADDRESS` — your proxy wallet address (Polymarket profile)
  - `CONTROL_TOKEN` — a long random string (e.g. from a password generator).
    Without it, limits/start/stop/resume are **locked** (kill switch always works).
- [ ] **Dashboard**: Controls page → paste the same `CONTROL_TOKEN` value into the
      Control token field → Save. This authorises your browser.
- [ ] **Risk limits for the trial** (Controls page): Max trade size **$10**,
      Max daily exposure **$50**, Min spread **0.5%**.

## Stage 1 — dry run (mandatory, ≥ 1 trading day)

Set `TRADING_MODE=live`, `LIVE_VENUES=polymarket`, keep `EXECUTION_DRY_RUN=true`.

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
