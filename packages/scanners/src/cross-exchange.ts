import type {
  AssetClass,
  Opportunity,
  OpportunityLeg,
  StrategyKind,
  Venue,
} from '@cesar-arb/shared';
import type { Executor, MarketTicker } from '@cesar-arb/executors';
import { newOpportunityId, type Scanner } from './base.js';

/**
 * Cross-exchange spot scanner.
 *
 * The most intuitive, independently-verifiable arbitrage there is: the
 * same asset (BTC, ETH, …) quoted against USD/USDT on several venues at
 * the same instant. If the best bid on one venue exceeds the best ask on
 * another by more than round-trip fees, buying the cheap book and selling
 * the rich one locks the difference (assuming pre-positioned inventory on
 * both venues — there is no on-chain transfer in the loop; that's stated
 * in the opportunity reasoning rather than hidden).
 *
 * Per the Scanner contract this emits ONE candidate per asset every scan —
 * including negative-edge ones — so the dashboard always has live,
 * cross-checkable numbers even when nothing clears the threshold (the
 * common case: spot books are tight and efficient).
 */

export interface CrossExchangeVenue {
  venue: Venue;
  executor: Executor;
  /** What these prices are quoted against — disclosed when venues differ. */
  quoteCcy: 'USDT' | 'USD';
}

export interface CrossExchangeScannerOptions {
  venues: CrossExchangeVenue[];
  /** Canonical asset codes to compare, e.g. ['BTC','ETH','SOL']. */
  assets: string[];
  minEdgePct: number;
  sizeUsd: number;
  /** Per-leg taker fee in bps (round-trip = 2×). Default ~10bps/side. */
  feeBps?: number;
  ttlMs?: number;
}

function valid(t: MarketTicker | undefined): t is MarketTicker {
  return !!t && t.bid > 0 && t.ask > 0 && Number.isFinite(t.bid) && Number.isFinite(t.ask);
}

export class CrossExchangeScanner implements Scanner {
  readonly name = 'cross-exchange';
  private readonly venues: CrossExchangeVenue[];
  private readonly assets: string[];
  private readonly minEdgePct: number;
  private readonly sizeUsd: number;
  private readonly feeBps: number;
  private readonly ttlMs: number;

  constructor(opts: CrossExchangeScannerOptions) {
    this.venues = opts.venues;
    this.assets = opts.assets;
    this.minEdgePct = opts.minEdgePct;
    this.sizeUsd = opts.sizeUsd;
    this.feeBps = opts.feeBps ?? 10;
    this.ttlMs = opts.ttlMs ?? 4_000;
  }

  async scan(): Promise<Opportunity[]> {
    // One batched fetch per venue; a failing venue just drops out this tick.
    const perVenue = await Promise.all(
      this.venues.map(async (v) => {
        try {
          const tickers = await v.executor.tickers(this.assets);
          return { v, bySymbol: new Map(tickers.map((t) => [t.symbol, t])) };
        } catch {
          return { v, bySymbol: new Map<string, MarketTicker>() };
        }
      }),
    );

    const now = Date.now();
    const out: Opportunity[] = [];

    for (const asset of this.assets) {
      // Best ask = cheapest place to BUY; best bid = richest place to SELL.
      let buy: { v: CrossExchangeVenue; t: MarketTicker } | null = null;
      let sell: { v: CrossExchangeVenue; t: MarketTicker } | null = null;
      for (const { v, bySymbol } of perVenue) {
        const t = bySymbol.get(asset);
        if (!valid(t)) continue;
        if (!buy || t.ask < buy.t.ask) buy = { v, t };
        if (!sell || t.bid > sell.t.bid) sell = { v, t };
      }
      if (!buy || !sell || buy.v.venue === sell.v.venue) continue;

      const roundTripFeePct = (this.feeBps * 2) / 100;
      const grossPct = ((sell.t.bid - buy.t.ask) / buy.t.ask) * 100;
      const edgePct = grossPct - roundTripFeePct;
      const profitUsd = (this.sizeUsd * edgePct) / 100;
      const qty = this.sizeUsd / buy.t.ask;

      const legs: OpportunityLeg[] = [
        {
          venue: buy.v.venue,
          symbol: asset,
          side: 'buy',
          price: buy.t.ask,
          qty,
          note: `buy ${asset} on ${buy.v.venue} @ ${buy.t.ask}`,
        },
        {
          venue: sell.v.venue,
          symbol: asset,
          side: 'sell',
          price: sell.t.bid,
          qty,
          note: `sell ${asset} on ${sell.v.venue} @ ${sell.t.bid}`,
        },
      ];

      const basisNote =
        buy.v.quoteCcy !== sell.v.quoteCcy
          ? ` Note: ${buy.v.venue} quotes ${buy.v.quoteCcy}, ${sell.v.venue} quotes ${sell.v.quoteCcy} — small stablecoin basis applies.`
          : '';

      out.push({
        id: newOpportunityId('cx'),
        strategy: 'cross-exchange' as StrategyKind,
        assetClass: 'crypto' as AssetClass,
        venues: [buy.v.venue, sell.v.venue],
        description: `${asset}: buy ${buy.v.venue} / sell ${sell.v.venue}`,
        edgePct,
        estProfitUsd: profitUsd,
        sizeUsd: this.sizeUsd,
        legs,
        reasoning:
          `${asset} best ask ${buy.t.ask} on ${buy.v.venue} vs best bid ${sell.t.bid} on ${sell.v.venue}. ` +
          `Gross ${grossPct.toFixed(3)}%, edge ${edgePct.toFixed(3)}% after ${roundTripFeePct.toFixed(2)}% round-trip fees. ` +
          `Requires pre-funded inventory on both venues (no on-chain transfer in the loop).${basisNote}`,
        detectedAt: now,
        expiresAt: now + this.ttlMs,
        // Same asset, same instant, real books — not a fuzzy/fictional pair.
        source: 'confirmed',
        requiresReview: false,
      });
    }

    // Surface the strongest first; the engine still filters by threshold.
    out.sort((a, b) => b.edgePct - a.edgePct);
    return out;
  }
}
