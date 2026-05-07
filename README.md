# Cesar Arb Bot

Multi-venue arbitrage bot built for Cesar. v1 ships **paper-trading** mode: scanners read live market data from real venues, but fills are simulated against the live tape so reported P&L reflects what would actually happen.

## What it does

Two strategies in v1:

1. **Triangular crypto arb on BitGet** — single-venue, no transfer risk. Scans loops like USDT → BTC → ETH → USDT continuously and fires when the implied cross diverges from the direct rate enough to clear fees.
2. **Polymarket ↔ Kalshi prediction-pair arb** — when the same event is listed on both venues at prices that sum to less than $1 per $1 payoff, buy YES on one and NO on the other to lock the spread.

Risk module enforces hard caps: per-trade size, daily exposure, daily loss kill-switch, trailing stops on open positions.

A Next.js dashboard (Apple-style, `#0A84FF`) shows live opportunities, recent trades, and exposes the kill switch.

## Architecture

```
apps/
  engine/       — Node service: scan loop + risk + executors + HTTP API
  dashboard/    — Next.js 15 dashboard
packages/
  shared/       — domain types shared engine ↔ dashboard
  executors/    — venue clients (BitGet / Polymarket / Kalshi) + PaperExecutor
  scanners/     — TriangularScanner + PredictionScanner
  risk/         — caps, kill switch, trailing stop
  reporting/    — daily report builder + HTML renderer
tools/
  setup-bot/    — conversational CLI that writes .env
```

## Getting started

```bash
pnpm install
pnpm setup            # walks through API keys, risk limits, etc → writes .env
pnpm dev              # runs engine + dashboard in parallel
```

Then open http://localhost:3000.

You can also run them separately:

```bash
pnpm dev:engine       # http://localhost:4000
pnpm dev:dashboard    # http://localhost:3000
```

## Configuration

All settings live in `.env` (copy from `.env.example`). The setup bot generates this for you. Highlights:

| Variable | Default | Notes |
|---|---|---|
| `TRADING_MODE` | `paper` | `live` only meaningful once v2 wires real order placement |
| `MAX_TRADE_SIZE_USD` | `100` | per the spec |
| `MAX_DAILY_EXPOSURE_USD` | `500` | per the spec |
| `MAX_DAILY_LOSS_PCT` | `5` | trips kill switch when hit |
| `TRAILING_STOP_PCT` | `5` | per the spec |
| `MIN_SPREAD_PCT` | `1.0` | minimum edge to fire a trade |

## Deploying to Railway

1. Push this repo to GitHub.
2. In Railway, create a new project from the repo.
3. Add **two services** pointing at the same repo:
   - **engine** → root `apps/engine`, attach a 1 GB volume mounted at `/data`, set `SQLITE_PATH=/data/cesar-arb.db`.
   - **dashboard** → root `apps/dashboard`, set `NEXT_PUBLIC_ENGINE_URL` to the engine service's public URL.
4. Add the same env vars from `.env` to both services.

`railway.toml` and `nixpacks.toml` at repo root drive the builds.

## Going live (v2 work)

v1 is paper-only by design. The order-placement methods on each venue executor return `not yet implemented` errors. To go live we will:

1. Wire BitGet HMAC-signed `POST /api/v2/spot/trade/place-order`.
2. Wire Polymarket EIP-712 signed orders against the CLOB.
3. Wire Kalshi RSA-signed `POST /trade-api/v2/portfolio/orders`.
4. Add settlement accrual (prediction markets pay out at resolution, not at fill).
5. Add a multi-strategy ranker that uprank/downranks scanners based on rolling realized edge.

The plan is to ship those after Cesar has watched paper-trading run for a week and we're confident in the spread thresholds, slippage assumptions, and kill-switch behavior.

## API

The engine exposes a small HTTP API on port `ENGINE_PORT` (default 4000):

- `GET /api/status` — engine status, today's exposure & P&L, limits
- `GET /api/opportunities` — live + recent opportunities
- `GET /api/trades?limit=N` — recent trades
- `GET /api/report?date=YYYY-MM-DD` — daily report JSON
- `GET /api/report/html?date=YYYY-MM-DD` — daily report rendered as HTML
- `POST /api/kill-switch` `{active: bool}` — toggle the kill switch
- `POST /api/start` / `POST /api/stop` — start/stop the scan loop

## Honest caveats

- **Crypto arb at retail size is hard.** The triangular scanner finds real opportunities, but the 1% default `MIN_SPREAD_PCT` is generous — most days you will see few or zero. Lower it to `0.3` to see more candidates (after fees most will still be unprofitable). This is the truth of crypto arb, not a bug.
- **Prediction-market matching uses fuzzy text similarity.** Some matches will be wrong (e.g. Polymarket "Will X win primary" vs Kalshi "Will X win general"). v2 work: a curated mapping table for the top events.
- **Polymarket/Kalshi fees.** Polymarket charges no maker/taker but you pay gas for the matic tx; Kalshi has fees that depend on payoff. Default fee assumption is 0.5% round-trip, which is usually conservative. Tune in `prediction.ts` if needed.
- **No live execution in v1.** Paper-trade only. Don't ship money to BitGet/Poly/Kalshi expecting v1 to trade it.
