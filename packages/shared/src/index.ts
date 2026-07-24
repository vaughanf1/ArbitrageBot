/**
 * Shared domain types for the Cesar arb bot.
 * Both the engine and the dashboard import from here so opportunity/trade
 * shapes stay in sync across the wire.
 */

export type Venue =
  | 'bitget'
  | 'binance'
  | 'coinbase'
  | 'kraken'
  | 'okx'
  | 'bybit'
  | 'polymarket'
  | 'polymarket-us'
  | 'kalshi'
  | 'paper';

/** Crypto spot venues that quote against USD/USDT and are comparable cross-venue. */
export const CRYPTO_SPOT_VENUES: Venue[] = [
  'binance',
  'coinbase',
  'kraken',
  'okx',
  'bybit',
  'bitget',
];

export type AssetClass = 'crypto' | 'prediction' | 'forex' | 'equity' | 'commodity';

export type StrategyKind = 'triangular' | 'prediction-pair' | 'cross-exchange';

export type TradingMode = 'paper' | 'live';

export type Side = 'buy' | 'sell';

export interface Opportunity {
  id: string;
  strategy: StrategyKind;
  assetClass: AssetClass;
  /** Venues involved (1 for triangular, 2 for prediction-pair). */
  venues: Venue[];
  /** Human-readable description, e.g. "BTC→ETH→USDT→BTC on BitGet" */
  description: string;
  /** Estimated edge in percent (e.g. 1.4 = 1.4%). After fees. */
  edgePct: number;
  /** Estimated USD profit at MAX_TRADE_SIZE_USD. */
  estProfitUsd: number;
  /** Recommended trade size in USD. */
  sizeUsd: number;
  /** Underlying legs for execution. */
  legs: OpportunityLeg[];
  /** Strategy-specific reasoning to show on the dashboard. */
  reasoning: string;
  /** Unix ms when this snapshot was taken. */
  detectedAt: number;
  /** Unix ms after which the opportunity is presumed stale. */
  expiresAt: number;
  /**
   * How this pair was identified:
   *   - 'confirmed': from PREDICTION_PAIRS allowlist or triangular arb on
   *     a single venue (same-venue → no resolution-criteria risk). Safe to
   *     auto-trade.
   *   - 'heuristic': fuzzy text-matched across venues (Polymarket ↔ Kalshi
   *     strict mode). The matcher cannot verify resolution criteria —
   *     two markets with similar titles can settle on different
   *     timestamps or rules. Surfaces for human review only; the engine
   *     will not auto-fire on these.
   */
  source: 'confirmed' | 'heuristic';
  /**
   * If true, this opportunity is shown for review but never auto-traded.
   * Heuristic cross-venue pairs flip this on so the bot doesn't book P&L
   * on fictional arbs (e.g. two BTC daily strikes with different
   * resolution timestamps).
   */
  requiresReview: boolean;
}

export interface OpportunityLeg {
  venue: Venue;
  symbol: string;
  side: Side;
  /** Reference price for the leg at detection time. */
  price: number;
  /** Quantity in base units (or contracts for prediction markets). */
  qty: number;
  /** Free-form note, e.g. "buy YES on Polymarket". */
  note?: string;
}

export interface Trade {
  id: string;
  opportunityId: string;
  strategy: StrategyKind;
  assetClass: AssetClass;
  mode: TradingMode;
  status: TradeStatus;
  /** Filled legs, in order of execution. */
  fills: Fill[];
  /** Sum of legs in USD (notional). */
  notionalUsd: number;
  /** Realized P&L in USD once closed. Null while open. */
  pnlUsd: number | null;
  reasoning: string;
  openedAt: number;
  closedAt: number | null;
}

export type TradeStatus = 'open' | 'closed' | 'failed' | 'cancelled';

export interface Fill {
  venue: Venue;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  feeUsd: number;
  /** Trailing stop price (for one-sided positions). */
  trailingStop?: number;
  filledAt: number;
}

export interface Position {
  id: string;
  tradeId: string;
  venue: Venue;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  /** Live mark price; updated by the engine. */
  markPrice: number;
  /** Highest mark seen since entry — used for trailing stop. */
  highWaterMark: number;
  trailingStopPrice: number;
  unrealizedPnlUsd: number;
  openedAt: number;
}

export interface RiskLimits {
  maxTradeSizeUsd: number;
  maxDailyExposureUsd: number;
  maxDailyLossPct: number;
  trailingStopPct: number;
  minSpreadPct: number;
}

export interface EngineStatus {
  mode: TradingMode;
  running: boolean;
  killSwitch: boolean;
  startedAt: number | null;
  /** Number of tradable opportunities (above min-spread) seen this session. */
  scannedCount: number;
  /** Total candidates evaluated this session — includes sub-threshold edges. */
  candidateCount: number;
  /** Number of trades attempted in current session. */
  tradedCount: number;
  /** Today's realized P&L in USD. */
  realizedPnlTodayUsd: number;
  /** Today's deployed exposure in USD. */
  exposureTodayUsd: number;
  limits: RiskLimits;
  /** Unix ms of last completed scan. Null until first scan finishes. */
  lastScanAt: number | null;
  /** Wall-clock ms of last scan loop. */
  lastScanMs: number;
  /**
   * Markets currently being monitored, keyed by venue name. Open-ended so
   * new venues surface on the dashboard without a type/engine change.
   * Always includes at least bitget / polymarket / kalshi.
   */
  marketCounts: Record<string, number>;
}

export interface DailyReport {
  date: string; // YYYY-MM-DD
  trades: Trade[];
  totalPnlUsd: number;
  winRate: number; // 0..1
  bestTrade: Trade | null;
  worstTrade: Trade | null;
  byStrategy: Array<{ strategy: StrategyKind; trades: number; pnlUsd: number }>;
}

/** Helper: an opportunity is fresh if we haven't passed `expiresAt`. */
export function isFresh(o: Opportunity, now: number = Date.now()): boolean {
  return now < o.expiresAt;
}
