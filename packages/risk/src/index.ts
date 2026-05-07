import type { Opportunity, Position, RiskLimits } from '@cesar-arb/shared';

export interface RiskState {
  /** Sum of notional USD deployed today (resets at UTC midnight). */
  exposureTodayUsd: number;
  /** Realized P&L USD today. Negative = loss. */
  realizedPnlTodayUsd: number;
  /** Total starting equity for the day, used to compute % daily loss. */
  startingEquityUsd: number;
  /** True once max-daily-loss tripped today. Blocks new trades. */
  killSwitch: boolean;
  /** UTC date this state corresponds to (YYYY-MM-DD). */
  date: string;
}

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Stateless risk evaluator. The engine owns RiskState and asks the
 * RiskGuard whether each candidate trade is allowed before placing it.
 */
export class RiskGuard {
  constructor(private readonly limits: RiskLimits) {}

  /** Returns the size we are willing to take, capped by trade-size limit. */
  sizeFor(opp: Opportunity, state: RiskState): number {
    const remainingDaily = Math.max(0, this.limits.maxDailyExposureUsd - state.exposureTodayUsd);
    const requested = Math.min(opp.sizeUsd, this.limits.maxTradeSizeUsd);
    return Math.min(requested, remainingDaily);
  }

  /** Decide whether to place an order for this opportunity given current state. */
  evaluate(opp: Opportunity, state: RiskState): RiskDecision {
    if (state.killSwitch) {
      return { allowed: false, reason: 'kill-switch active' };
    }
    if (opp.edgePct < this.limits.minSpreadPct) {
      return { allowed: false, reason: `edge ${opp.edgePct.toFixed(2)}% below min ${this.limits.minSpreadPct}%` };
    }
    if (state.exposureTodayUsd >= this.limits.maxDailyExposureUsd) {
      return { allowed: false, reason: 'daily exposure cap reached' };
    }
    if (this.sizeFor(opp, state) < 5) {
      return { allowed: false, reason: 'remaining size too small' };
    }
    const lossPct = (-state.realizedPnlTodayUsd / Math.max(state.startingEquityUsd, 1)) * 100;
    if (lossPct >= this.limits.maxDailyLossPct) {
      return { allowed: false, reason: `daily loss ${lossPct.toFixed(2)}% ≥ ${this.limits.maxDailyLossPct}% cap` };
    }
    return { allowed: true };
  }

  /**
   * Update the trailing stop for an open position. Returns the new stop price.
   * Stop only moves in the favorable direction (up for longs, down for shorts).
   */
  updateTrailingStop(pos: Position, currentPrice: number): { stop: number; high: number } {
    const pct = this.limits.trailingStopPct / 100;
    if (pos.side === 'buy') {
      const high = Math.max(pos.highWaterMark, currentPrice);
      const stop = Math.max(pos.trailingStopPrice, high * (1 - pct));
      return { stop, high };
    } else {
      const low = Math.min(pos.highWaterMark, currentPrice); // for shorts, "high water" = lowest price seen
      const stop = pos.trailingStopPrice === 0
        ? low * (1 + pct)
        : Math.min(pos.trailingStopPrice, low * (1 + pct));
      return { stop, high: low };
    }
  }

  /** Should we close this position because trailing stop hit? */
  shouldStop(pos: Position, currentPrice: number): boolean {
    if (pos.side === 'buy') return currentPrice <= pos.trailingStopPrice;
    return currentPrice >= pos.trailingStopPrice;
  }
}

export function freshState(startingEquityUsd: number, now: Date = new Date()): RiskState {
  return {
    exposureTodayUsd: 0,
    realizedPnlTodayUsd: 0,
    startingEquityUsd,
    killSwitch: false,
    date: ymdUtc(now),
  };
}

export function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Roll state forward at UTC midnight. */
export function maybeResetForNewDay(state: RiskState, startingEquityUsd: number, now: Date = new Date()): RiskState {
  const today = ymdUtc(now);
  if (state.date === today) return state;
  return freshState(startingEquityUsd, now);
}
