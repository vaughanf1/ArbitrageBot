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
  private tradedCount = 0;

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
  private loopHandle: NodeJS.Timeout | null = null;

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
      tradedCount: this.tradedCount,
      realizedPnlTodayUsd: this.state.realizedPnlTodayUsd,
      exposureTodayUsd: this.state.exposureTodayUsd,
      limits: this.config.limits,
    };
  }

  liveOpportunities(): Opportunity[] {
    const now = Date.now();
    return this.currentOpportunities.filter((o) => o.expiresAt > now);
  }

  private async tick(): Promise<void> {
    try {
      this.state = maybeResetForNewDay(this.state, this.config.startingEquityUsd);
      this.state.killSwitch = this.killSwitch;

      const found: Opportunity[] = [];
      for (const scanner of this.scanners) {
        try {
          const opps = await scanner.scan();
          for (const o of opps) {
            this.storage.recordOpportunity(o);
            found.push(o);
          }
        } catch (err) {
          this.logger.warn({ err: (err as Error).message, scanner: scanner.name }, 'scanner failed');
        }
      }
      this.scannedCount += found.length;
      this.currentOpportunities = found.sort((a, b) => b.edgePct - a.edgePct);

      // Try to execute the best opportunity (if any).
      for (const opp of this.currentOpportunities) {
        const decision = this.guard.evaluate(opp, this.state);
        if (!decision.allowed) {
          this.logger.debug({ opp: opp.id, reason: decision.reason }, 'skip');
          continue;
        }
        await this.executeOpportunity(opp);
        break; // one trade per tick keeps things tidy in v1
      }
      this.persistState();
    } catch (err) {
      this.logger.error({ err: (err as Error).message }, 'tick failed');
    } finally {
      if (this.running) {
        // Triangular needs fast cycling; prediction can be slower. Use a moderate cadence.
        this.loopHandle = setTimeout(() => this.tick().catch((e) => this.logger.error(e)), 5_000);
      }
    }
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
