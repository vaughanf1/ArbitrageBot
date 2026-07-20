import type {
  EngineStatus,
  Fill,
  Opportunity,
  OpportunityLeg,
  RiskLimits,
  Trade,
  TradingMode,
  Venue,
} from '@cesar-arb/shared';
import {
  BitgetExecutor,
  KalshiExecutor,
  PaperExecutor,
  PolymarketExecutor,
  CexSpotExecutor,
  makeCexSpotExecutor,
  CEX_SPOT_VENUES,
  type Executor,
} from '@cesar-arb/executors';
import {
  PredictionScanner,
  TriangularScanner,
  CrossExchangeScanner,
  PolyIntraMarketScanner,
  DEFAULT_TRIANGLES,
  type Scanner,
} from '@cesar-arb/scanners';

/** Canonical assets compared across spot venues by the cross-exchange scanner. */
const CROSS_EXCHANGE_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'AVAX', 'LTC', 'BCH'];
import { freshState, maybeResetForNewDay, RiskGuard, ymdUtc } from '@cesar-arb/risk';
import { buildDailyReport, sendDailyReportEmail } from '@cesar-arb/reporting';
import type { EngineConfig } from './config.js';
import type { Storage } from './storage.js';
import type { Logger } from 'pino';

let tradeCounter = 0;
function newTradeId(): string {
  tradeCounter = (tradeCounter + 1) % 1_000_000;
  return `trade-${Date.now().toString(36)}-${tradeCounter.toString(36)}`;
}

export interface EngineDeps {
  config: EngineConfig;
  storage: Storage;
  logger: Logger;
}

/**
 * The Engine ties scanners → risk → executor → storage in a loop.
 *
 * Default mode is `paper`: scanners read live market data from real venues,
 * but fills are simulated by PaperExecutor. Live mode is only enabled when
 * config.mode === 'live' AND the executor's enableLive flag is set — for v1
 * the live order placement methods all return errors by design.
 */
export class Engine {
  private readonly config: EngineConfig;
  private readonly storage: Storage;
  private readonly logger: Logger;

  private mode: TradingMode;
  private running = false;
  private killSwitch = false;
  private startedAt: number | null = null;
  private scannedCount = 0;
  private candidateCount = 0;
  private tradedCount = 0;
  private lastScanAt: number | null = null;
  private lastScanMs = 0;
  private marketCounts: Record<string, number> = { bitget: 0, polymarket: 0, kalshi: 0 };

  private bitget!: BitgetExecutor;
  private polymarket!: PolymarketExecutor;
  private kalshi!: KalshiExecutor;
  private paperBitget!: PaperExecutor;
  private paperPoly!: PaperExecutor;
  private paperKalshi!: PaperExecutor;
  /** Read-only spot data sources for the cross-exchange scanner. */
  private cexSpot: CexSpotExecutor[] = [];

  private scanners: Scanner[] = [];
  private executorByVenue: Map<string, Executor> = new Map();

  private guard: RiskGuard;
  private state: ReturnType<typeof freshState>;

  private currentOpportunities: Opportunity[] = [];
  private currentCandidates: Opportunity[] = [];
  private loopHandle: NodeJS.Timeout | null = null;

  /**
   * Recently-fired opportunity fingerprints with the timestamp of the most
   * recent fire. Two ticks that produce structurally identical opportunities
   * (same legs, same sides) won't both auto-trade — the second one is
   * skipped until DEDUPE_WINDOW_MS elapses. This kills the "cache-window
   * re-fire" bug where the engine paper-trades the same arb every tick for
   * 30s before the market-data cache refreshes.
   */
  private recentFires: Map<string, number> = new Map();
  private readonly DEDUPE_WINDOW_MS = 10 * 60 * 1000;

  private reportHandle: NodeJS.Timeout | null = null;

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.storage = deps.storage;
    this.logger = deps.logger;
    this.mode = this.config.mode;
    this.guard = new RiskGuard(this.config.limits);

    // Cesar's dashboard edits are persisted and take precedence over the
    // .env defaults on restart.
    const savedLimits = this.storage.loadLimits();
    if (savedLimits) {
      this.config.limits = sanitizeLimits({ ...this.config.limits, ...savedLimits });
      this.guard.setLimits(this.config.limits);
      this.logger.info({ limits: this.config.limits }, 'loaded persisted risk limits (override .env)');
    }

    const today = ymdUtc(new Date());
    const persisted = this.storage.loadDailyState(today);
    if (persisted) {
      this.state = {
        date: today,
        startingEquityUsd: persisted.startingEquityUsd,
        exposureTodayUsd: persisted.exposureUsd,
        realizedPnlTodayUsd: persisted.realizedPnlUsd,
        killSwitch: persisted.killSwitch,
      };
      this.killSwitch = persisted.killSwitch;
    } else {
      this.state = freshState(this.config.startingEquityUsd);
    }

    this.buildVenues();
    this.buildScanners();
  }

  private buildVenues() {
    // A venue may place real orders only when the global mode is 'live' AND
    // it is named in LIVE_VENUES. Anything else stays on the paper executor.
    // Even when live, the executor's own `dryRun` (default ON) signs but does
    // not transmit until EXECUTION_DRY_RUN=false. Two gates, fail-safe.
    const liveFor = (v: Venue): boolean =>
      this.config.mode === 'live' && this.config.execution.liveVenues.includes(v);
    const dryRun = this.config.execution.dryRun;

    this.bitget = new BitgetExecutor({
      apiKey: this.config.bitget.apiKey || undefined,
      apiSecret: this.config.bitget.apiSecret || undefined,
      passphrase: this.config.bitget.passphrase || undefined,
      enableLive: false, // BitGet is not US-available; never live for this client.
    });
    this.polymarket = new PolymarketExecutor({
      privateKey: this.config.polymarket.privateKey || undefined,
      funderAddress: this.config.polymarket.funderAddress || undefined,
      apiKey: this.config.polymarket.apiKey || undefined,
      apiSecret: this.config.polymarket.apiSecret || undefined,
      apiPassphrase: this.config.polymarket.apiPassphrase || undefined,
      enableLive: liveFor('polymarket'),
      dryRun,
    });
    this.kalshi = new KalshiExecutor({
      apiKeyId: this.config.kalshi.apiKeyId || undefined,
      privateKeyPath: this.config.kalshi.privateKeyPath || undefined,
      enableLive: liveFor('kalshi'),
      dryRun,
    });

    this.paperBitget = new PaperExecutor({ dataSource: this.bitget, feeBps: 10, slippageBps: 5 });
    this.paperPoly = new PaperExecutor({ dataSource: this.polymarket, feeBps: 0, slippageBps: 50 });
    this.paperKalshi = new PaperExecutor({ dataSource: this.kalshi, feeBps: 50, slippageBps: 0 });

    // Route each prediction venue to its real executor only when live-enabled;
    // otherwise the paper wrapper. The real executor still respects dryRun.
    this.executorByVenue.set('bitget', this.paperBitget);
    this.executorByVenue.set('polymarket', liveFor('polymarket') ? this.polymarket : this.paperPoly);
    this.executorByVenue.set('kalshi', liveFor('kalshi') ? this.kalshi : this.paperKalshi);
    if (liveFor('kalshi') || liveFor('polymarket')) {
      this.logger.warn(
        { liveVenues: this.config.execution.liveVenues, dryRun },
        dryRun
          ? 'LIVE venues enabled in DRY-RUN: orders will be signed but NOT sent'
          : '*** LIVE venues enabled and DRY-RUN OFF: real orders will be transmitted ***',
      );
    }

    // Public spot data sources (no API keys). Each is paper-wrapped so a
    // cross-exchange opportunity's legs can still simulate fills.
    for (const name of CEX_SPOT_VENUES) {
      const exec = makeCexSpotExecutor(name);
      this.cexSpot.push(exec);
      this.executorByVenue.set(
        name,
        new PaperExecutor({ dataSource: exec, feeBps: 10, slippageBps: 5 }),
      );
      this.marketCounts[name] = 0;
    }
  }

  private buildScanners() {
    this.scanners = [
      new TriangularScanner({
        executor: this.bitget,
        venue: 'bitget',
        feeBps: 10,
        minEdgePct: this.config.limits.minSpreadPct,
        sizeUsd: Math.min(this.config.limits.maxTradeSizeUsd, 100),
      }),
      new PredictionScanner({
        polymarket: this.polymarket,
        kalshi: this.kalshi,
        minEdgePct: this.config.limits.minSpreadPct,
        sizeUsd: Math.min(this.config.limits.maxTradeSizeUsd, 100),
        matchMode: this.config.predictionMatchMode,
      }),
      new CrossExchangeScanner({
        venues: this.cexSpot.map((e) => ({
          venue: e.venue,
          executor: e,
          quoteCcy: e.quoteCcy,
        })),
        assets: CROSS_EXCHANGE_ASSETS,
        minEdgePct: this.config.limits.minSpreadPct,
        sizeUsd: Math.min(this.config.limits.maxTradeSizeUsd, 100),
        feeBps: 10,
      }),
      // Single-venue Polymarket YES+NO arb. The one strategy that runs on the
      // funds Cesar actually holds (Polymarket only) now that the Poly↔Kalshi
      // pair is retired. Reads the live CLOB book; legs route to the same
      // Polymarket executor used by the prediction scanner, so it inherits the
      // live/dry-run safety gates with no extra wiring.
      new PolyIntraMarketScanner({
        polymarket: this.polymarket,
        minEdgePct: this.config.limits.minSpreadPct,
        sizeUsd: Math.min(this.config.limits.maxTradeSizeUsd, 100),
      }),
    ];
  }

  /** Start the scan loop. Returns immediately. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.logger.info({ mode: this.mode }, 'engine started');
    this.loopHandle = setTimeout(() => this.tick().catch((e) => this.logger.error(e)), 0);
    this.scheduleNextDailyReport();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopHandle) clearTimeout(this.loopHandle);
    this.loopHandle = null;
    if (this.reportHandle) clearTimeout(this.reportHandle);
    this.reportHandle = null;
    this.logger.info('engine stopped');
  }

  /**
   * Schedule the daily report send for 23:55 UTC. We fire just before
   * midnight (rather than at midnight) so that all of today's trades are
   * included before the daily state resets at 00:00 UTC. If the email
   * config isn't set, the send is a no-op — the function will log that
   * and re-arm itself for the next day.
   */
  private scheduleNextDailyReport(): void {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 55, 0));
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    const delayMs = next.getTime() - now.getTime();
    this.logger.info({ nextReportAt: next.toISOString(), delayMs }, 'scheduled daily report');
    this.reportHandle = setTimeout(() => {
      this.sendDailyReport().catch((e) => this.logger.error({ err: (e as Error).message }, 'daily report failed'));
      // Always re-arm even if this fire failed.
      if (this.running) this.scheduleNextDailyReport();
    }, delayMs);
  }

  private async sendDailyReport(): Promise<void> {
    const date = ymdUtc(new Date());
    const trades = this.storage.tradesForDate(date);
    const report = buildDailyReport(date, trades);
    const result = await sendDailyReportEmail({
      report,
      resendKey: this.config.report.resendKey,
      from: this.config.report.from,
      to: this.config.report.to,
    });
    if (result.sent) {
      this.logger.info({ date, trades: trades.length, emailId: result.id }, 'daily report sent');
    } else {
      this.logger.warn({ date, reason: result.reason }, 'daily report not sent');
    }
  }

  /**
   * Apply a (partial) risk-limits edit from the dashboard. Sanitises the
   * input, hot-swaps the guard, rebuilds scanners so the new min-spread /
   * trade-size take effect immediately, and persists so it survives a
   * restart. Returns the limits actually applied.
   */
  updateLimits(patch: Partial<RiskLimits>): RiskLimits {
    const merged = sanitizeLimits({ ...this.config.limits, ...patch });
    this.config.limits = merged;
    this.guard.setLimits(merged);
    this.buildScanners(); // propagate new minSpreadPct / sizeUsd
    this.storage.saveLimits(merged);
    this.logger.warn({ limits: merged }, 'risk limits updated from dashboard');
    return merged;
  }

  setKillSwitch(active: boolean): void {
    this.killSwitch = active;
    this.state.killSwitch = active;
    this.persistState();
    this.logger.warn({ active }, 'kill switch toggled');
  }

  status(): EngineStatus {
    return {
      mode: this.mode,
      running: this.running,
      killSwitch: this.killSwitch,
      startedAt: this.startedAt,
      scannedCount: this.scannedCount,
      candidateCount: this.candidateCount,
      tradedCount: this.tradedCount,
      realizedPnlTodayUsd: this.state.realizedPnlTodayUsd,
      exposureTodayUsd: this.state.exposureTodayUsd,
      limits: this.config.limits,
      lastScanAt: this.lastScanAt,
      lastScanMs: this.lastScanMs,
      marketCounts: this.marketCounts,
    };
  }

  liveOpportunities(): Opportunity[] {
    const now = Date.now();
    return this.currentOpportunities.filter((o) => o.expiresAt > now);
  }

  liveCandidates(): Opportunity[] {
    const now = Date.now();
    return this.currentCandidates.filter((o) => o.expiresAt > now);
  }

  /**
   * Manually trigger the daily report send. Used to verify Resend wiring
   * end-to-end without waiting for 23:55 UTC.
   */
  async triggerDailyReport(): Promise<{ sent: boolean; reason?: string }> {
    const date = ymdUtc(new Date());
    const trades = this.storage.tradesForDate(date);
    const report = buildDailyReport(date, trades);
    const r = await sendDailyReportEmail({
      report,
      resendKey: this.config.report.resendKey,
      from: this.config.report.from,
      to: this.config.report.to,
    });
    if (r.sent) return { sent: true };
    return { sent: false, reason: r.reason };
  }

  /**
   * Wipe trade history + reset session counters. Used to start fresh
   * after fixing a bug that produced inflated paper-trade results.
   */
  resetForDemo(): void {
    this.storage.resetTradeHistory();
    this.recentFires.clear();
    this.state = freshState(this.config.startingEquityUsd);
    this.tradedCount = 0;
    this.scannedCount = 0;
    this.candidateCount = 0;
    this.persistState();
    this.logger.warn('demo state reset — trade history wiped');
  }

  private gcRecentFires(): void {
    const cutoff = Date.now() - this.DEDUPE_WINDOW_MS;
    for (const [fp, ts] of this.recentFires) {
      if (ts < cutoff) this.recentFires.delete(fp);
    }
  }

  private async tick(): Promise<void> {
    const tickStart = Date.now();
    try {
      this.state = maybeResetForNewDay(this.state, this.config.startingEquityUsd);
      this.state.killSwitch = this.killSwitch;

      const candidates: Opportunity[] = [];
      for (const scanner of this.scanners) {
        try {
          const opps = await scanner.scan();
          for (const o of opps) candidates.push(o);
        } catch (err) {
          this.logger.warn({ err: (err as Error).message, scanner: scanner.name }, 'scanner failed');
        }
      }

      const minEdge = this.config.limits.minSpreadPct;
      // Auto-trade only opportunities that:
      //   1. clear the spread threshold, AND
      //   2. don't require human review (heuristic cross-venue matches do —
      //      a fuzzy title match can't verify the two markets settle on the
      //      same resolution criteria, so the bot shouldn't book P&L on them)
      const tradable = candidates.filter((o) => o.edgePct >= minEdge && !o.requiresReview);
      candidates.sort((a, b) => b.edgePct - a.edgePct);
      tradable.sort((a, b) => b.edgePct - a.edgePct);

      for (const o of candidates) {
        this.storage.recordOpportunity(o, o.edgePct >= minEdge);
      }

      this.candidateCount += candidates.length;
      this.scannedCount += tradable.length;
      this.currentCandidates = candidates;
      this.currentOpportunities = tradable;

      await this.refreshMarketCounts();

      // Try to execute the best tradable opportunity (if any).
      this.gcRecentFires();
      for (const opp of this.currentOpportunities) {
        const decision = this.guard.evaluate(opp, this.state);
        if (!decision.allowed) {
          this.logger.debug({ opp: opp.id, reason: decision.reason }, 'skip');
          continue;
        }
        const fp = fingerprint(opp);
        const firedAt = this.recentFires.get(fp);
        if (firedAt && Date.now() - firedAt < this.DEDUPE_WINDOW_MS) {
          this.logger.debug({ opp: opp.id, fp, ageMs: Date.now() - firedAt }, 'skip duplicate');
          continue;
        }
        this.recentFires.set(fp, Date.now());
        await this.executeOpportunity(opp);
        break; // one trade per tick keeps things tidy in v1
      }
      this.persistState();
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'tick failed');
    } finally {
      this.lastScanAt = Date.now();
      this.lastScanMs = this.lastScanAt - tickStart;
      if (this.running) {
        // Triangular needs fast cycling; prediction can be slower. Use a moderate cadence.
        this.loopHandle = setTimeout(() => this.tick().catch((e) => this.logger.error(e)), 5_000);
      }
    }
  }

  /**
   * Pull live counts from each venue. Executors cache for 30s so this is
   * effectively free after the first tick — but it lets the dashboard
   * prove that real market data is flowing in even when no edge clears
   * the threshold.
   */
  private async refreshMarketCounts(): Promise<void> {
    const triangleSymbols = new Set<string>();
    for (const t of DEFAULT_TRIANGLES) {
      triangleSymbols.add(t.pairs.quoteMid);
      triangleSymbols.add(t.pairs.quoteOther);
      triangleSymbols.add(t.pairs.midOther);
    }
    const [bitgetTickers, polyMarkets, kalshiMarkets, ...spot] = await Promise.allSettled([
      this.bitget.tickers([...triangleSymbols]),
      this.polymarket.listActiveMarkets(),
      this.kalshi.listActiveMarkets(),
      ...this.cexSpot.map((e) => e.tickers(CROSS_EXCHANGE_ASSETS)),
    ]);
    const next = { ...this.marketCounts };
    if (bitgetTickers.status === 'fulfilled') next.bitget = bitgetTickers.value.length;
    if (polyMarkets.status === 'fulfilled') next.polymarket = polyMarkets.value.length;
    if (kalshiMarkets.status === 'fulfilled') next.kalshi = kalshiMarkets.value.length;
    this.cexSpot.forEach((e, i) => {
      const r = spot[i];
      if (r && r.status === 'fulfilled') next[e.venue] = r.value.length;
    });
    this.marketCounts = next;
  }

  private async executeOpportunity(opp: Opportunity): Promise<void> {
    const sizeUsd = this.guard.sizeFor(opp, this.state);
    const trade: Trade = {
      id: newTradeId(),
      opportunityId: opp.id,
      strategy: opp.strategy,
      assetClass: opp.assetClass,
      mode: this.mode,
      status: 'open',
      fills: [],
      notionalUsd: 0,
      pnlUsd: null,
      reasoning: opp.reasoning,
      openedAt: Date.now(),
      closedAt: null,
    };
    this.storage.recordTrade(trade);
    this.logger.info({ opp: opp.id, edgePct: opp.edgePct, sizeUsd }, 'placing trade');

    const fills: Fill[] = [];
    let scaleFactor = sizeUsd / opp.sizeUsd;
    if (scaleFactor <= 0 || !isFinite(scaleFactor)) scaleFactor = 1;

    let succeeded = true;
    let failReason = '';
    // Legs that actually filled, so we can unwind them if a later leg fails.
    const filledLegs: OpportunityLeg[] = [];
    for (const leg of opp.legs) {
      const exec = this.executorByVenue.get(leg.venue);
      if (!exec) {
        failReason = `no executor for venue ${leg.venue}`;
        this.logger.error({ venue: leg.venue }, 'no executor for venue');
        succeeded = false;
        break;
      }
      const scaledLeg: OpportunityLeg = { ...leg, qty: leg.qty * scaleFactor };
      const res = await exec.placeMarketOrder(scaledLeg);
      if (!res.ok || !res.fill) {
        failReason = res.error ?? 'leg failed';
        this.logger.error({ leg: leg.symbol, error: res.error }, 'leg failed');
        succeeded = false;
        break;
      }
      fills.push(res.fill);
      filledLegs.push(scaledLeg);
    }

    if (!succeeded) {
      // PARTIAL-FILL SAFETY: a multi-leg arb where some legs filled and a later
      // one didn't leaves a naked, unhedged position. Unwind everything that
      // did fill before giving up.
      if (filledLegs.length > 0) {
        await this.unwindLegs(filledLegs, trade);
      }
      trade.fills = fills;
      trade.notionalUsd = fills.reduce((s, f) => s + f.price * f.qty, 0);
      trade.status = 'failed';
      trade.reasoning = `${trade.reasoning} | ABORTED: ${failReason}`;
      trade.closedAt = Date.now();
      this.storage.recordTrade(trade);
      this.tradedCount += 1;
      return;
    }

    trade.fills = fills;
    trade.notionalUsd = fills.reduce((s, f) => s + f.price * f.qty, 0);

    // For both triangular and prediction-pair the trade closes immediately
    // in v1: triangular returns to the quote currency in a single tick, and
    // prediction-pair locks payout = $1 regardless of resolution → we book the
    // realized edge now and treat resolution as a separate accrual job (v2).
    const pnl = computeRealizedPnl(opp, fills);
    trade.pnlUsd = pnl;
    trade.status = 'closed';
    trade.closedAt = Date.now();

    this.state.exposureTodayUsd += sizeUsd;
    this.state.realizedPnlTodayUsd += pnl;

    // Trip kill switch if daily loss cap hit.
    const lossPct = (-this.state.realizedPnlTodayUsd / Math.max(this.state.startingEquityUsd, 1)) * 100;
    if (lossPct >= this.config.limits.maxDailyLossPct) {
      this.setKillSwitch(true);
      this.logger.error({ lossPct }, 'daily loss cap hit, kill switch engaged');
    }

    this.storage.recordTrade(trade);
    this.tradedCount += 1;
    this.logger.info({ trade: trade.id, pnl: pnl.toFixed(2) }, 'trade closed');
  }

  /**
   * Unwind already-filled legs after a later leg failed, by placing the
   * opposite market order on each. Best-effort: if an unwind ITSELF fails the
   * position is genuinely naked — we trip the kill-switch and log CRITICAL so
   * a human reconciles it. The unwind fills are appended to the trade record.
   */
  private async unwindLegs(filledLegs: OpportunityLeg[], trade: Trade): Promise<void> {
    this.logger.error(
      { trade: trade.id, legs: filledLegs.length },
      'partial fill detected — unwinding filled legs to avoid a naked position',
    );
    for (const leg of filledLegs) {
      const exec = this.executorByVenue.get(leg.venue);
      if (!exec) {
        this.flagNakedPosition(trade, leg, 'no executor available to unwind');
        continue;
      }
      const opposite: OpportunityLeg = { ...leg, side: leg.side === 'buy' ? 'sell' : 'buy' };
      try {
        const res = await exec.placeMarketOrder(opposite);
        if (!res.ok || !res.fill) {
          this.flagNakedPosition(trade, leg, res.error ?? 'unwind order rejected');
          continue;
        }
        trade.fills.push(res.fill);
        this.logger.warn({ trade: trade.id, leg: leg.symbol, venue: leg.venue }, 'leg unwound');
      } catch (err) {
        this.flagNakedPosition(trade, leg, (err as Error).message);
      }
    }
  }

  /** A leg could not be unwound → real exposure. Halt trading, alert loudly. */
  private flagNakedPosition(trade: Trade, leg: OpportunityLeg, why: string): void {
    this.setKillSwitch(true);
    this.logger.error(
      { trade: trade.id, venue: leg.venue, symbol: leg.symbol, qty: leg.qty, why },
      'CRITICAL: NAKED POSITION — unwind failed; kill-switch engaged; manual reconciliation required',
    );
  }

  private persistState(): void {
    this.storage.saveDailyState(this.state.date, {
      startingEquityUsd: this.state.startingEquityUsd,
      exposureUsd: this.state.exposureTodayUsd,
      realizedPnlUsd: this.state.realizedPnlTodayUsd,
      killSwitch: this.state.killSwitch,
    });
  }
}

/**
 * Clamp dashboard-supplied limits to sane bounds. A bad field falls back
 * to its current value rather than rejecting the whole edit, so a typo in
 * one box doesn't wipe the rest.
 */
function sanitizeLimits(l: RiskLimits): RiskLimits {
  const pos = (v: number, fallback: number) =>
    Number.isFinite(v) && v > 0 ? v : fallback;
  const pct = (v: number, fallback: number) =>
    Number.isFinite(v) && v >= 0 && v <= 100 ? v : fallback;
  return {
    maxTradeSizeUsd: pos(l.maxTradeSizeUsd, 100),
    maxDailyExposureUsd: pos(l.maxDailyExposureUsd, 500),
    maxDailyLossPct: pct(l.maxDailyLossPct, 5),
    trailingStopPct: pct(l.trailingStopPct, 5),
    // min spread can legitimately be 0 (take any positive edge); cap at 100%.
    minSpreadPct: pct(l.minSpreadPct, 1),
  };
}

function computeRealizedPnl(opp: Opportunity, fills: Fill[]): number {
  if (opp.strategy === 'triangular') {
    // Cycle returns USD-equivalent at the end. Ledger across legs:
    //   leg 1 (buy): pay quote = price * qty (+ fee)
    //   leg 2 (buy in non-quote): no quote impact
    //   leg 3 (sell): receive quote = price * qty (- fee)
    // Net PnL = (final receive) - (initial pay) - sum(fees).
    const first = fills[0];
    const last = fills[fills.length - 1];
    if (!first || !last) return 0;
    const initialOutlay = first.price * first.qty;
    const finalReceive = last.price * last.qty;
    const totalFees = fills.reduce((s, f) => s + f.feeUsd, 0);
    return finalReceive - initialOutlay - totalFees;
  }
  if (opp.strategy === 'cross-exchange') {
    // Two simultaneous legs: buy the cheap venue, sell the rich one. P&L is
    // sell proceeds − buy outlay − both legs' fees (paper books both now;
    // real execution assumes pre-positioned inventory on each venue).
    const buy = fills.find((f) => f.side === 'buy');
    const sell = fills.find((f) => f.side === 'sell');
    if (!buy || !sell) return 0;
    const outlay = buy.price * buy.qty + buy.feeUsd;
    const proceeds = sell.price * sell.qty - sell.feeUsd;
    return proceeds - outlay;
  }
  if (opp.strategy === 'prediction-pair') {
    // Pay (price_a * qty_a) + (price_b * qty_b) for $1 payoff per pair.
    const cost = fills.reduce((s, f) => s + f.price * f.qty + f.feeUsd, 0);
    // qty represents number of $1-payoff contracts on each side; one side will pay.
    const payoff = Math.min(fills[0]?.qty ?? 0, fills[1]?.qty ?? 0);
    return payoff - cost;
  }
  return 0;
}

/**
 * Structural identity of an opportunity for dedupe. Two scans that produce
 * the same legs (same venue + symbol + side) are the same arb regardless
 * of small price drift, so we suppress re-fire within the dedupe window.
 */
function fingerprint(opp: Opportunity): string {
  const legs = opp.legs
    .map((l) => `${l.venue}:${l.symbol}:${l.side}`)
    .sort()
    .join('|');
  return `${opp.strategy}/${legs}`;
}
