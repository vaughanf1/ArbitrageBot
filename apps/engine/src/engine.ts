import type {
  EngineStatus,
  Fill,
  Opportunity,
  Trade,
  TradingMode,
} from '@cesar-arb/shared';
import {
  BitgetExecutor,
  KalshiExecutor,
  PaperExecutor,
  PolymarketExecutor,
  type Executor,
} from '@cesar-arb/executors';
import {
  PredictionScanner,
  TriangularScanner,
  DEFAULT_TRIANGLES,
  type Scanner,
} from '@cesar-arb/scanners';
import { freshState, maybeResetForNewDay, RiskGuard, ymdUtc } from '@cesar-arb/risk';
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
  private marketCounts = { bitget: 0, polymarket: 0, kalshi: 0 };

  private bitget!: BitgetExecutor;
  private polymarket!: PolymarketExecutor;
  private kalshi!: KalshiExecutor;
  private paperBitget!: PaperExecutor;
  private paperPoly!: PaperExecutor;
  private paperKalshi!: PaperExecutor;

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

  constructor(deps: EngineDeps) {
    this.config = deps.config;
    this.storage = deps.storage;
    this.logger = deps.logger;
    this.mode = this.config.mode;
    this.guard = new RiskGuard(this.config.limits);

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
    this.bitget = new BitgetExecutor({
      apiKey: this.config.bitget.apiKey || undefined,
      apiSecret: this.config.bitget.apiSecret || undefined,
      passphrase: this.config.bitget.passphrase || undefined,
      enableLive: false, // v1: never live; live placement is unimplemented anyway
    });
    this.polymarket = new PolymarketExecutor({
      privateKey: this.config.polymarket.privateKey || undefined,
      enableLive: false,
    });
    this.kalshi = new KalshiExecutor({
      apiKeyId: this.config.kalshi.apiKeyId || undefined,
      privateKeyPath: this.config.kalshi.privateKeyPath || undefined,
      enableLive: false,
    });

    this.paperBitget = new PaperExecutor({ dataSource: this.bitget, feeBps: 10, slippageBps: 5 });
    this.paperPoly = new PaperExecutor({ dataSource: this.polymarket, feeBps: 0, slippageBps: 50 });
    this.paperKalshi = new PaperExecutor({ dataSource: this.kalshi, feeBps: 50, slippageBps: 0 });

    this.executorByVenue.set('bitget', this.paperBitget);
    this.executorByVenue.set('polymarket', this.paperPoly);
    this.executorByVenue.set('kalshi', this.paperKalshi);
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
    ];
  }

  /** Start the scan loop. Returns immediately. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.logger.info({ mode: this.mode }, 'engine started');
    this.loopHandle = setTimeout(() => this.tick().catch((e) => this.logger.error(e)), 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopHandle) clearTimeout(this.loopHandle);
    this.loopHandle = null;
    this.logger.info('engine stopped');
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
    const [bitgetTickers, polyMarkets, kalshiMarkets] = await Promise.allSettled([
      this.bitget.tickers([...triangleSymbols]),
      this.polymarket.listActiveMarkets(),
      this.kalshi.listActiveMarkets(),
    ]);
    this.marketCounts = {
      bitget: bitgetTickers.status === 'fulfilled' ? bitgetTickers.value.length : this.marketCounts.bitget,
      polymarket: polyMarkets.status === 'fulfilled' ? polyMarkets.value.length : this.marketCounts.polymarket,
      kalshi: kalshiMarkets.status === 'fulfilled' ? kalshiMarkets.value.length : this.marketCounts.kalshi,
    };
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
    for (const leg of opp.legs) {
      const exec = this.executorByVenue.get(leg.venue);
      if (!exec) {
        this.logger.error({ venue: leg.venue }, 'no executor for venue');
        succeeded = false;
        break;
      }
      const scaledLeg = { ...leg, qty: leg.qty * scaleFactor };
      const res = await exec.placeMarketOrder(scaledLeg);
      if (!res.ok || !res.fill) {
        this.logger.error({ leg: leg.symbol, error: res.error }, 'leg failed');
        succeeded = false;
        break;
      }
      fills.push(res.fill);
    }

    trade.fills = fills;
    trade.notionalUsd = fills.reduce((s, f) => s + f.price * f.qty, 0);

    if (!succeeded) {
      trade.status = 'failed';
      trade.closedAt = Date.now();
      this.storage.recordTrade(trade);
      this.tradedCount += 1;
      return;
    }

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

  private persistState(): void {
    this.storage.saveDailyState(this.state.date, {
      startingEquityUsd: this.state.startingEquityUsd,
      exposureUsd: this.state.exposureTodayUsd,
      realizedPnlUsd: this.state.realizedPnlTodayUsd,
      killSwitch: this.state.killSwitch,
    });
  }
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
