# Cesar Arb Bot — Operating Guide

Short, practical reference for running and reviewing the bot day to day.

## URLs

- **Dashboard (bookmark this):** https://dashboard-production-0d5f.up.railway.app
- **Engine API (programmatic):** https://engine-production-d738.up.railway.app
- **Railway project:** `cesar-arb-bot` (in your account, mcdeglialbizi@gmail.com)

The bot runs 24/7 — close your browser and walk away, it keeps scanning.

---

## What the bot does

Every ~5 seconds the engine:

1. Pulls live prices from Polymarket US (QCEX) — the exchange holding Cesar's funds — and from global Polymarket as a data source.
2. Runs two strategies:
   - **US event arb** on Polymarket US — buys every outcome of a multi-outcome event when the basket costs less than the $1 guaranteed payout, net of QCEX fees. This is the only strategy that trades real money.
   - **Intra-market YES+NO** on global Polymarket — same idea on a single two-sided market. Data-only: global Polymarket is not in `LIVE_VENUES`, so these can be watched but not traded.
3. Trades any opportunity that clears the spread threshold (`MIN_SPREAD_PCT`) **and** routes entirely to live venues. An opportunity whose venues aren't live-routed is skipped, not simulated — see below.
4. Persists trades, opportunities, and daily P&L to SQLite on the mounted volume.

**Retired 2026-07-31:** BitGet triangular, Poly↔Kalshi prediction pairs, and cross-exchange spot. None of those venues are tradeable for a US client, so their "fills" were simulations that nonetheless consumed the real daily exposure cap and booked fake profit. Three independent guards now prevent a repeat: the scanners are unregistered, paper-routed opportunities are skipped whenever any venue is live, and simulated fills track their own exposure/P&L counters instead of the real ones.

---

## Dashboard, page by page

### Overview (`/`)
- **Stat strip:** today's P&L, exposure (deployed capital vs daily cap), trades count, current min-spread threshold.
- **Markets monitored:** real-time counts of pairs/markets being scanned on each venue, plus age and duration of the last scan. If this stops updating, the engine is down.
- **Live opportunities:** opportunities right now that clear the spread threshold AND are safe to auto-trade.
- **Live scan feed:** every candidate from the most recent scans, including sub-threshold edges. Three pill states on the right:
  - **`tradable`** (green) — clears threshold and is safe to auto-trade.
  - **`below X%`** (grey) — real signal but edge too small to pay fees + risk.
  - **`review only`** (amber) — heuristic cross-venue match that hasn't been human-verified. Won't auto-trade until you add it to the allowlist (see "Curating pairs" below).
- **Recent trades:** last few paper fills.

### Opportunities (`/opportunities`)
Full live scan feed + tradable history. Useful for spotting recurring near-miss edges that might be worth tightening fees for.

### Trades (`/trades`)
All paper trades with their P&L. Click into a trade to see leg-level fills.

### Settings (`/settings`)
- Kill switch toggle.
- Read-only view of current risk caps.

---

## Kill switch

Big red button on the Overview header. Click it once → engine stops firing trades immediately (scanning continues so you can still see opportunities, but nothing executes). Click again to resume.

The kill switch also auto-engages if today's P&L hits −5% of starting equity. The engine logs it and reports back via the daily report.

---

## Risk caps (Railway env vars)

| Var | Current value | What it does |
|---|---|---|
| `MAX_TRADE_SIZE_USD` | 100 | Max notional per single trade |
| `MAX_DAILY_EXPOSURE_USD` | 500 | Max total notional deployed in one UTC day |
| `MAX_DAILY_LOSS_PCT` | 5 | Auto-engages kill switch if hit |
| `TRAILING_STOP_PCT` | 5 | Trailing stop (unused in v1 — both strategies close in one tick) |
| `MIN_SPREAD_PCT` | 0.05 | Minimum edge for auto-trade |
| `MAX_SETTLEMENT_DAYS` | 14 | Maximum time live capital may be locked; longer/unknown maturities are review-only |
| `PREDICTION_MATCH_MODE` | `strict` | `allowlist` = only curated pairs auto-trade; `strict` = also surface heuristic matches for review (but they never auto-trade) |
| `STARTING_EQUITY_USD` | 10000 | Used as base for daily loss-cap calculation |

Change any of these in the Railway dashboard → engine service → variables, then re-deploy.

---

## Curating new prediction pairs (the main lever)

The bot only auto-trades Polymarket↔Kalshi pairs that have been human-verified to have **identical resolution criteria**. The curated list lives in:

```
packages/scanners/src/prediction-pairs.ts
```

To add a pair:

1. Find a Polymarket market — note its `slug` (the URL path after `/event/`).
2. Find the equivalent Kalshi market — note its `eventTicker` and (if the event has multiple sub-markets) the specific `ticker`.
3. **Read both resolution sections carefully.** The two markets must settle on the same outcome of the same event:
   - same resolution date / timestamp
   - same authoritative source (e.g., Senate confirmation vote, party convention nominee, AP race call)
   - same edge cases (e.g., does "by May 31" include May 31 23:59 UTC on both sides?)
4. Append to `PREDICTION_PAIRS`:
   ```ts
   {
     polymarketSlug: '...',
     kalshiEventTicker: '...',
     kalshiTicker: '...',
     note: 'Resolution: <source>. Verified <date>.',
   }
   ```
5. Commit + deploy: `railway up --service engine --ci`.

**Don't auto-trade what you haven't verified.** A pair with slightly different resolution timestamps (e.g., "BTC above $X on May 11" vs "BTC at 5pm EDT on May 11") can lose both legs. The bot's earlier inflated paper-P&L came from exactly this kind of false-positive.

Pairs currently in the allowlist (as of handover):
- Judy Shelton — Fed Chair confirmation
- Kevin Warsh — Fed Chair confirmation
- Ted Cruz — 2028 GOP nomination
- JD Vance — 2028 GOP nomination ← the workhorse: ~1% live edge right now
- Kamala Harris — 2028 Dem nomination
- Josh Shapiro — 2028 Dem nomination
- Mark Kelly — 2028 Dem nomination

Most of these are very-skewed markets where one side trades near $0.01 — the bot correctly won't fire on those because the liquidity floor (`MIN_LEG_PRICE = 0.03`) blocks fills you couldn't actually get. JD Vance is the one with mid-probability legs on both venues, so it's the one currently producing real trades. The list grows as you add more mid-probability pairs.

---

## Daily report email

The engine builds a daily report at **23:55 UTC** and emails it to `REPORT_EMAIL_TO` via Resend. Subject line includes date + P&L summary.

To enable, set on Railway:
- `RESEND_API_KEY` — from your Resend dashboard
- `REPORT_EMAIL_FROM` — must be a verified sender domain on Resend
- `REPORT_EMAIL_TO` — Cesar's address

If any of the three is blank, the report is built but no email is sent (no crash — just a warning in the logs).

To test immediately without waiting for 23:55:
```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  https://engine-production-d738.up.railway.app/api/admin/send-report
```

You can also view the live HTML report any time at:
- https://engine-production-d738.up.railway.app/api/report/html
- https://engine-production-d738.up.railway.app/api/report/html?date=2026-05-10

---

## Common operations

### Wipe trade history and start fresh
```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  https://engine-production-d738.up.railway.app/api/admin/reset
```

### Check engine health
```bash
curl https://engine-production-d738.up.railway.app/api/status | jq
```

### Tail logs
```bash
railway logs --service engine
```

### Redeploy after a code change
```bash
railway up --service engine --ci    # or --service dashboard
```

---

## What's v2 (out of scope for v1)

When you want to move from paper to live trading:

1. **Live order placement** — wire BitGet HMAC, Polymarket EIP-712, Kalshi RSA signing. The scaffolds exist (`packages/executors/src/*.ts` placeMarketOrder methods return `error: '... not yet implemented'`). Set each executor's `enableLive: true` and add the signing logic.
2. **Larger curated pair library** — populate `PREDICTION_PAIRS` with 20+ verified pairs across politics, sports, crypto.
3. **Order-book depth** — currently the scanner uses top-of-book. Live trading needs depth analysis to size positions to fillable quantity.
4. **Settlement accrual for prediction markets** — currently paper bookings realize P&L immediately on entry. Real settlement requires waiting for the market to resolve, then crediting the winning leg.
5. **More venues** — adding Coinbase, Binance, OKX would significantly increase cross-exchange spot-arb opportunities (which are far more frequent than triangular at retail).

---

## Troubleshooting

**Dashboard shows "Engine unreachable"** — engine service is down. `railway logs --service engine` to see why; usually a deploy that failed health-check.

**P&L stuck at $0 for hours** — check the Live scan feed. If candidates are flowing but all are below threshold, that's the market being efficient; not a bug. If the feed is empty, check engine logs.

**A trade looks wrong (suspicious edge, weird pair)** — flip the kill switch first, then look at the trade's `reasoning` field. If it was a heuristic match that snuck through, the gating is broken — open an issue. Allowlist trades should always have clear resolution criteria.

**Need to roll back a deploy** — Railway → engine service → Deployments → click the prior successful deployment → "Redeploy."

---

## Hand-back details

- Repo location (Vaughan's machine): `~/Cesar Arbitrage bot/`
- Railway project ID: `332eb591-1bc7-4374-836f-5e8ed87ac260`
- Engine service ID: `9129a20b-b4f8-4184-87d0-8163cc701447`
- Dashboard service ID: `a3bab4b7-4fdd-4e39-8214-cab8d2cb517c`
- SQLite volume mount on engine: `/data` → `cesar-arb.db`
- `ADMIN_TOKEN` env var on engine (for the admin endpoints): get from Vaughan or rotate via the Railway dashboard.
