import type { Fill, OpportunityLeg, Venue } from '@cesar-arb/shared';
import type { Executor, MarketTicker, PlaceOrderResult } from './base.js';

/**
 * PaperExecutor wraps a real "data" executor and simulates fills against the
 * live ticker. We use the live mid-price plus a slippage assumption so paper
 * P&L reflects what would actually happen.
 *
 * Slippage model: market orders cross the spread → buyer pays ask, seller
 * gets bid. We add an additional `slippageBps` on top of that to account for
 * book depth at our trade size.
 */
export class PaperExecutor implements Executor {
  readonly venue: Venue;
  private readonly dataSource: Executor;
  private readonly feeBps: number;
  private readonly slippageBps: number;

  constructor(opts: {
    /** The executor we read prices from. Usually a real-venue executor in read-only mode. */
    dataSource: Executor;
    /** Round-trip fee in basis points, e.g. 10 = 0.1%. */
    feeBps?: number;
    /** Extra slippage in basis points beyond the bid/ask cross. */
    slippageBps?: number;
  }) {
    this.dataSource = opts.dataSource;
    this.venue = opts.dataSource.venue;
    this.feeBps = opts.feeBps ?? 10;
    this.slippageBps = opts.slippageBps ?? 5;
  }

  ticker(symbol: string) {
    return this.dataSource.ticker(symbol);
  }

  tickers(symbols: string[]) {
    return this.dataSource.tickers(symbols);
  }

  async placeMarketOrder(leg: OpportunityLeg): Promise<PlaceOrderResult> {
    let ticker: MarketTicker;
    try {
      ticker = await this.dataSource.ticker(leg.symbol);
    } catch (err) {
      return { ok: false, error: `paper: ticker fetch failed: ${(err as Error).message}` };
    }

    const slippageMult = this.slippageBps / 10_000;
    const fillPrice =
      leg.side === 'buy'
        ? ticker.ask * (1 + slippageMult)
        : ticker.bid * (1 - slippageMult);

    const notional = fillPrice * leg.qty;
    const feeUsd = notional * (this.feeBps / 10_000);

    const fill: Fill = {
      venue: this.venue,
      symbol: leg.symbol,
      side: leg.side,
      qty: leg.qty,
      price: fillPrice,
      feeUsd,
      filledAt: Date.now(),
    };
    return { ok: true, fill };
  }
}
