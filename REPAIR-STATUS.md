# Execution repair — 20 October 2026

This branch repairs reproducible execution and reporting defects. It does not
establish profitability, reconcile historical transactions, or prove that Cesar's
deployment is running the repaired code. No money-moving requests were made.

## Changes

- US entries use fill-or-kill limits at the detected price, without the old
  implicit 1% allowance. Separate leg orders are still not an atomic basket.
- Any partial entry aborts the basket. Recovery uses actual filled quantities
  (including fractions) and current executable quotes. Partial/failed recovery
  halts trading; it cannot be labelled a complete hedge.
- Confirmed fills are saved before the next order. A pending-submission marker
  and durable kill switch protect restart after an unknown order outcome.
- Unreadable balances block entries; buying-power estimates include fees.
  Live entries require a fresh successful position reconciliation, and existing
  holdings block repeat entry. Missing active listings no longer imply settlement.
- Prediction holdings stay open with null realised P&L. Failed, fully unwound
  attempts contribute actual cash losses and deployed exposure. Reports exclude
  simulated profits and include realised failed-attempt losses.
- Scanner uses current market fee coefficients and rounded commissions. Missing
  fee metadata is review-only. Sports futures are review-only because category
  does not prove exhaustiveness. Inactive siblings are retained in market data
  and prevent an incomplete basket being treated as complete.
- US-only runs no longer wait on retired exchange feeds. Public requests have
  timeouts; books are batched with pacing; event pagination fails explicitly if
  the complete listing exceeds its bound. Positions are paginated too.

## Validation

Run `corepack pnpm test`, `corepack pnpm -r typecheck`, and
`corepack pnpm --filter @cesar-arb/dashboard build`.
All 27 tests, workspace type checks and the dashboard production build passed.
An in-memory, paper-mode engine with its kill switch engaged completed a public
market scan, returned a healthy status API, listed 26,045 market records and
recorded zero trades. A sampled 12-book scan found no candidate; this is not a
strategy-performance study.

Tests use synthetic executor responses and an in-memory database; no real orders.
The public US gateway was readable during the repair. Sample market metadata
reported feeCoefficient 0.0695, rather than the old 0.06 approximation.

Official SDK reference for order types, execution responses and position pagination:
https://github.com/Polymarket/polymarket-us-typescript/tree/main/src/types

## Required before restoring live service

1. Obtain current Railway project access and inspect deployed revision, volume,
   configuration and logs. All four documented historical URLs return 404.
2. Back up the production database. Keep live transmission disabled during deploy.
3. Read actual exchange cash, paginated positions, orders and account activities.
   Reconcile missing historic sells, manual trades and settlements. Do not use
   the quantity-adjustment endpoint as a substitute for proving historical P&L.
4. Resolve any pending-submission markers against exchange order records.
5. Set daily starting equity to the verified account value, not the example
   $10,000 default. Confirm per-trade and daily limits against available funds.
6. Validate current fee calculation and quantity/tick rules with authenticated
   order previews. Regression tests and public metadata do not replace this.
7. Observe the deployed scanner and paper/dry-run behaviour before live trading.
   A working scanner may correctly find no eligible opportunities.

## Remaining limitations

- Settlement cashflows are not automatically imported. Pending positions are
  deliberately not reported as realised profit. A settled-position discrepancy
  blocks new trading until reconciled; it is never silently assumed resolved.
- Historical profit rows remain unchanged and may be wrong. Correct historical
  P&L requires exchange activity, which is unavailable in this session.
- A network timeout can leave an order outcome unknown. The engine halts for
  account reconciliation rather than retrying and risking duplicate exposure.
- Paper fills remain simulations; they are not evidence of executable live edge.
- There is no proof of recurring net profitability or a functioning current
  client deployment without account access and observation.
