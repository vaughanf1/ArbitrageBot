import type { Fill, OpportunityLeg, Venue } from '@cesar-arb/shared';

export interface PlaceOrderResult {
  ok: boolean;
  fill?: Fill;
  error?: string;
}

export interface MarketTicker {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  ts: number;
}

/**
 * An Executor knows how to read prices from a venue and place market orders.
 * Implementations either talk to a real venue API or simulate fills (paper mode).
 */
export interface Executor {
  readonly venue: Venue;
  /** Pull a ticker snapshot for the given symbol. */
  ticker(symbol: string): Promise<MarketTicker>;
  /** Pull tickers for many symbols at once (faster than N calls). */
  tickers(symbols: string[]): Promise<MarketTicker[]>;
  /** Execute one leg of an opportunity. */
  placeMarketOrder(leg: OpportunityLeg): Promise<PlaceOrderResult>;
}
