/**
 * Shared domain types for the Cesar arb bot.
 * Both the engine and the dashboard import from here so opportunity/trade
 * shapes stay in sync across the wire.
 */

export type Venue = 'bitget' | 'polymarket' | 'kalshi' | 'paper';

export type AssetClass = 'crypto' | 'prediction' | 'forex' | 'equity' | 'commodity';

export type StrategyKind = 'triangular' | 'prediction-pair';

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
  /** Number of opportunities scanned in current session. */
  scannedCount: number;
  /** Number of trades attempted in current session. */
  tradedCount: number;
  /** Today's realized P&L in USD. */
  realizedPnlTodayUsd: number;
  /** Today's deployed exposure in USD. */
  exposureTodayUsd: number;
  limits: RiskLimits;
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
