# Cesar Arbitrage Bot — Handover

**Project:** v1 paper-trading arbitrage bot
**Venues:** BitGet (crypto), Polymarket, Kalshi (prediction markets)
**Status:** Deployed, running 24/7 on your Railway account, auto-trading paper money

---

## What you're getting

A bot that runs around the clock on your Railway account, watching for price differences across three venues. When the same outcome is priced differently on Polymarket and Kalshi (or when BitGet's internal pricing has a triangular gap), the bot opens a paper trade and books the spread.

**Two important framings:**

1. **It's paper-mode.** No real money is at risk. Real order placement requires API keys to sign trades on each venue — that's v2 work, intentionally not enabled. You can leave this running indefinitely without spending a cent on losses.

2. **It's conservative on purpose.** The bot only auto-trades pairs that have been *manually verified* to have identical resolution criteria. There's a curated allowlist in the code (currently 6 pairs covering Fed Chair confirmation and 2028 nominations). Anything not in that list surfaces as a "review only" candidate but never auto-fires — because two markets with similar names but different resolution timestamps can both lose. That's not arb, that's gambling. The bot won't do that.

---

## Live numbers (as of handover)

In the ~20 hours since the last major deploy:

| Metric | Value |
|---|---|
| Trades fired | **14** |
| Cumulative paper P&L | **+$22.52** |
| Candidates evaluated | 85,269 |
| Signals above threshold | 4,334 |
| Markets being scanned right now | 8 BitGet pairs · 438 Polymarket · 5,327 Kalshi |

**By pair:**
- Marco Rubio @ 2028 GOP nomination: 8 trades · **+$19.85**
- JD Vance @ 2028 GOP nomination: 6 trades · +$2.67

The Marco Rubio market consistently has ~3–4% mispricing between Polymarket (currently ~25% YES) and Kalshi (~31% YES) — the bot captures that spread on each detection cycle.

The other 4 allowlist pairs (Shelton, Warsh, Cruz, DeSantis, Tucker Carlson, Shapiro, Harris, Kelly) are real verified pairs but currently sub-threshold or thin-book. They're sitting there ready to trade when prices diverge.

**Daily cap is doing its job:** today the bot deployed $500 of paper notional and stopped trading further — that's the `MAX_DAILY_EXPOSURE_USD` limit kicking in by design.

---

## Your URLs

| What | URL |
|---|---|
| **Dashboard** (bookmark this) | https://dashboard-production-0d5f.up.railway.app |
| Engine API (for the curious) | https://engine-production-d738.up.railway.app |
| Status JSON | https://engine-production-d738.up.railway.app/api/status |
| Daily report (HTML) | https://engine-production-d738.up.railway.app/api/report/html |

All hosted on your Railway account (mcdeglialbizi@gmail.com). You own the infrastructure. I can be removed as a collaborator whenever you're comfortable taking it over solo.

---

## How to read the dashboard

**Overview page:**
- **Top stats:** P&L today, exposure deployed today (vs the $500 cap), trades count, current spread threshold.
- **Markets monitored:** real-time count of pairs/markets the bot is watching. If these stop updating, the engine is down — check Railway.
- **Live opportunities:** opportunities clearing the spread threshold and safe to auto-trade *right now*.
- **Live scan feed:** every candidate from recent scans. Three pill colours on the right:
  - **`tradable`** (green) — clears threshold, auto-traded
  - **`below X%`** (grey) — real signal but too small to pay fees + risk
  - **`review only`** (amber) — heuristic match across venues, not human-verified, **never auto-fires**

**Opportunities page:** full live feed + tradable history. Useful for spotting recurring near-miss pairs that might be worth adding to the allowlist.

**Trades page:** all paper trades with their P&L. Click into one to see leg-level fills.

**Settings page:** the kill switch + read-only view of your risk caps.

---

## The kill switch

Big red button on the top-right of the Overview. Click it → the bot stops firing trades immediately. Scanning continues so you can still see what's happening, but nothing executes. Click again to resume.

It also engages **automatically** if today's P&L hits −5%. The bot stops itself.

---

## Risk caps (the safety rails)

| Setting | Value | What it does |
|---|---|---|
| Max trade size | $100 | Per-trade notional cap |
| Max daily exposure | $500 | Total daily paper notional cap |
| Max daily loss | 5% | Auto-kills if hit |
| Min spread | 0.05% | Minimum edge for auto-trade |

All adjustable via Railway env vars without a code change. See `OPERATING.md` in the repo for the exact variable names.

---

## What's automatic vs manual

**Automatic (the bot handles):**
- Scanning every 5 seconds, 24/7
- Pulling live prices from BitGet/Polymarket/Kalshi
- Computing arb edges after fees
- Firing paper trades when an allowlist pair clears the threshold
- Enforcing risk caps
- Resetting daily counters at 00:00 UTC

**Manual (you do):**
- Reviewing the "review only" amber-pill candidates and deciding whether to add any to the allowlist (see "How to add a new pair" below)
- Watching the daily report or dashboard to spot anomalies
- Flipping the kill switch if something looks off
- Eventually, commissioning v2 work (live trading)

---

## How to add a new pair to the allowlist

The allowlist is the single most important lever — it's what turns the bot from a scanner into a trader.

The file is `packages/scanners/src/prediction-pairs.ts` in the repo. Each entry has:
- A Polymarket slug
- A Kalshi event ticker + market ticker
- A human-readable note documenting the resolution source

**Before adding a pair**, verify by hand that both markets settle on the same outcome of the same event with the same resolution timestamp and source. The simplest test: would both markets resolve YES (or both NO) in every possible scenario? If yes, the pair is safe. If you can construct a scenario where one resolves YES and the other resolves NO, it is **not** a valid pair — adding it would book fictional P&L on a real bet that can lose both legs.

I've left 6 verified pairs to start. Add more as you find them — every additional pair increases the bot's chance of catching a real edge each scan.

---

## Daily email report

The engine builds a daily report at 23:55 UTC and (when configured) emails it via Resend. Subject line shows the date and P&L summary.

**To enable email**, set three env vars on the Railway engine service:
- `RESEND_API_KEY` — from your Resend account
- `REPORT_EMAIL_FROM` — a verified sender domain on Resend
- `REPORT_EMAIL_TO` — your address

Without those set, the report is built but no email is sent (no crash, just a warning in the logs). You can always view the live HTML report at the daily-report URL above.

---

## What v1 does NOT do (v2 work)

When you're ready to move from paper to live:

1. **Live order placement.** Wire up BitGet HMAC signing, Polymarket EIP-712 wallet signing, Kalshi RSA-key signing. The scaffolds are in `packages/executors/src/*.ts` — each `placeMarketOrder` currently returns `not yet implemented`. Flipping the `enableLive: true` flag and adding the signing code unlocks live trading.

2. **Larger curated pair library.** v1 ships with 6 pairs to prove the mechanism. A serious production bot wants 30–50 pairs across politics, sports, crypto, macro events — that's an ongoing curation task, not a one-time build.

3. **Order-book depth.** v1 prices fills at top-of-book. For meaningful position sizes, the bot needs to look at depth to size into thicker liquidity without slipping past the edge.

4. **Settlement accrual for prediction markets.** v1 books paper P&L on entry. Real settlement requires holding the position until the underlying market resolves, then crediting the winning side. This is mostly about state-tracking, not trading logic.

5. **More venues.** Adding Coinbase, Binance, OKX (or others) significantly increases the count of cross-exchange spot-arb opportunities — those tend to be more frequent than triangular at retail.

Each of these is a discrete chunk of work. Happy to scope and price separately when you're ready.

---

## Security housekeeping

One outstanding item I want to flag: a Railway API token (`a82a9842-…`) was pasted into the build chat early on. It turned out to be invalid so it never gave anyone real access, but the safest thing is to delete it from your Railway tokens page anyway: https://railway.com/account/tokens

I will not have any working credentials to your Railway account after that, except via the collaborator access you choose to grant or revoke.

---

## Where to look when something feels off

| Symptom | First thing to check |
|---|---|
| Dashboard shows "Engine unreachable" | Railway → engine service → was there a recent failed deploy? |
| P&L stuck at $0 for hours | Open the Live scan feed. If candidates are flowing but all below threshold, that's the market being efficient — not a bug. |
| A trade looks suspicious | Flip the kill switch first, then look at the trade's `reasoning` field. Allowlist trades say `Confirmed pair (allowlist).` Anything else means a bug. |
| Need to roll back a deploy | Railway → engine or dashboard service → Deployments → click a prior successful deployment → "Redeploy" |

`OPERATING.md` at the repo root has the full reference (env vars, admin endpoints, rollback procedure, how to wipe trade history if you ever want to start clean).

---

## Summary

- 24/7 paper-trading arbitrage bot, deployed to your Railway account
- 6 curated pairs auto-trading; ~14 trades in the last day at +$22.52 paper P&L
- Conservative by design — won't auto-fire on unverified pairs, won't exceed daily caps
- Clear path from here to v2 (live trading, more venues, deeper book) when you're ready

You own the infrastructure, the data, and the code. Everything is documented in this repo.
