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
  PolymarketUsExecutor,
  CexSpotExecutor,
  makeCexSpotExecutor,
  CEX_SPOT_VENUES,
  type Executor,
} from '@cesar-arb/executors';
import {
  PolyIntraMarketScanner,
  UsEventArbScanner,
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
  private polymarketUs!: PolymarketUsExecutor;
  private kalshi!: KalshiExecutor;
  private paperBitget!: PaperExecutor;
  private paperPoly!: PaperExecutor;
  private paperKalshi!: PaperExecutor;
  /** Read-only spot data sources for the cross-exchange scanner. */
  private cexSpot: CexSpotExecutor[] = [];

  private scanners: Scanner[] = [];
  private executorByVenue: Map<string, Executor> = new Map();
  /**
   * Venues actually wired to a real (money-moving) executor this run. Populated
   * by buildVenues() at the exact point the real executor is chosen, so routing
   * decisions can never drift from how orders are really sent.
   */
  private liveRoutedVenues: Set<string> = new Set();

  private guard: RiskGuard;
  /** Risk counters for real, money-moving trades. This is what the dashboard shows. */
  private state: ReturnType<typeof freshState>;
  /**
   * Separate counters for simulated trades. Paper fills used to increment the
   * live exposure and P&L counters, so a simulation could exhaust the real
   * daily risk budget and inflate reported profit. They are still capped —
   * against the same limits — just out of the real money's way. In-memory
   * only: there is nothing to reconcile after a restart.
   */
  private paperState: ReturnType<typeof freshState>;
  /**
   * Set when simulated losses hit the daily loss cap. Held separately from
   * paperState.killSwitch because that field is rewritten every tick to
   * mirror Cesar's global switch — flipping his switch back off must not
   * silently resume paper trading that halted on its own limit.
   */
  private paperLossHalt = false;

  private currentOpportunities: Opportunity[] = [];
  private currentCandidates: Opportunity[] = [];
  private loopHandle: NodeJS.Timeout | null = null;
  private reconcileHandle: NodeJS.Timeout | null = null;
  private lastReconciliation: EngineStatus['reconciliation'] = null;
  /**
   * Market slugs we already hold on the exchange, refreshed by reconciliation.
   * A prediction position cannot be recycled — it pays out only when the event
   * resolves, which for the NFL markets is January 2027 — so re-entering an
   * event we already hold just concentrates the whole account in one bet. The
   * bot bought the same NFC East basket seven times over four days before this
   * guard existed, and that is what exhausted Cesar's buying power.
   */
  private heldUsSlugs: Set<string> = new Set();
  /** Buying power at the last check, surfaced in /api/status. null = unknown. */
  private buyingPowerUsd: number | null = null;

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
    this.paperState = freshState(this.config.startingEquityUsd);

    this.killSwitch = this.killSwitch || this.storage.loadKillSwitch();
    if (this.storage.liveTrades().some((t) => t.reasoning.includes('[ORDER_PENDING]') || (t.status === 'open' && !t.reasoning.includes('Awaiting settlement;')))) {
      this.killSwitch = true;
      this.storage.saveKillSwitch(true);
    }
    this.state.killSwitch = this.killSwitch;
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
    this.polymarketUs = new PolymarketUsExecutor({
      keyId: this.config.polymarketUs.keyId || undefined,
      secretKey: this.config.polymarketUs.secretKey || undefined,
      enableLive: liveFor('polymarket-us'),
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
    this.executorByVenue.set(
      'polymarket-us',
      liveFor('polymarket-us')
        ? this.polymarketUs
        : new PaperExecutor({ dataSource: this.polymarketUs, feeBps: 0, slippageBps: 50 }),
    );
    this.liveRoutedVenues = new Set(
      (['polymarket', 'polymarket-us', 'kalshi'] as Venue[]).filter((v) => liveFor(v)),
    );
    if (liveFor('kalshi') || liveFor('polymarket') || liveFor('polymarket-us')) {
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

  /**
   * Scanners that produce opportunities we could actually trade.
   *
   * Retired 2026-07-31 — BitGet triangular, Poly↔Kalshi prediction pairs, and
   * cross-exchange spot. Every one of them scans a venue Cesar cannot trade on
   * (BitGet/CEX spot are not US-available; the Kalshi pair was dropped
   * 2026-06-29), so their legs always routed to paper executors. The engine
   * then "filled" them for real in the ledger: on 2026-07-31 four simulated
   * Poly↔Kalshi trades consumed $40 of the $50 daily exposure cap in the first
   * ten minutes after the UTC reset, locking out live QCEX arbs for the rest
   * of the day and booking ~$0.92 of fictional profit. Deleting them removes
   * the candidate noise; the paper-routing gate in tick() and the split risk
   * counters are the two independent backstops that make a repeat impossible.
   *
   * To bring one back, re-register it here AND add its venue to LIVE_VENUES —
   * a scanner whose venues aren't live-routed can no longer trade at all.
   */
  private buildScanners() {
    this.scanners = [
      ...(this.config.execution.liveVenues.includes('polymarket') ? [new PolyIntraMarketScanner({
        polymarket: this.polymarket,
        minEdgePct: this.config.limits.minSpreadPct,
        sizeUsd: Math.min(this.config.limits.maxTradeSizeUsd, 100),
      })] : []),
      // Polymarket US (QCEX) multi-outcome event arb — the one strategy that
      // runs on the exchange where Cesar's funds actually are. Market data is
      // public, so it scans in paper mode too; live legs route to the
      // credentialed US executor behind the same three-switch gates.
      new UsEventArbScanner({
        executor: this.polymarketUs,
        minEdgePct: this.config.limits.minSpreadPct,
        sizeUsd: Math.min(this.config.limits.maxTradeSizeUsd, 100),
        maxSettlementDays: this.config.execution.maxSettlementDays,
      }),
    ];
  }

  /**
   * How an opportunity's legs would ACTUALLY route right now:
   *   'live'  — every leg goes to a real, money-moving executor
   *   'paper' — every leg is simulated
   *   'mixed' — some real, some simulated
   *
   * 'mixed' must never be traded. A cross-venue arb is only riskless because
   * both legs exist; if one leg is real and the hedge is simulated, the client
   * ends up holding a naked directional position while the dashboard books the
   * "locked" edge as if it were hedged. The partial-fill unwind cannot save us
   * here either — the paper leg always reports success, so nothing looks wrong.
   *
   * Concretely: with LIVE_VENUES=polymarket, a Polymarket↔Kalshi pair would buy
   * one side for real and pretend to buy the other. That is the failure this
   * gate exists to prevent.
   */
  private routingFor(opp: Opportunity): 'live' | 'paper' | 'mixed' {
    let anyLive = false;
    let anyPaper = false;
    for (const leg of opp.legs) {
      if (this.liveRoutedVenues.has(leg.venue)) anyLive = true;
      else anyPaper = true;
    }
    if (anyLive && anyPaper) return 'mixed';
    return anyLive ? 'live' : 'paper';
  }

  /**
   * How this trade must be recorded, which is also whether real money moves.
   * A live-routed trade under EXECUTION_DRY_RUN is signed but never sent, so
   * it is a paper trade in every sense that matters here.
   */
  private ledgerModeFor(routing: 'live' | 'paper'): TradingMode {
    return routing === 'live' && this.config.execution.dryRun ? 'paper' : routing;
  }

  /**
   * Can the US account actually fund this basket? Checks the exchange's own
   * buying power against what the legs will cost, so an underfunded account
   * reports one clear line instead of an opaque HTTP 400 per attempt.
   * Non-polymarket-us opportunities are always allowed through.
   */
  private async canAfford(opp: Opportunity): Promise<{ ok: boolean; reason?: string }> {
    if (!opp.legs.some((l) => l.venue === 'polymarket-us')) return { ok: true };
    let available: number;
    try {
      available = await this.polymarketUs.buyingPowerUsd();
    } catch (err) {
      // Missing account state must never authorize new exposure.
      this.logger.warn({ err: (err as Error).message }, 'buying power check failed');
      return { ok: false, reason: 'buying power unavailable; refusing new exposure' };
    }
    this.buyingPowerUsd = available;
    const cost = opp.legs
      .filter((l) => l.venue === 'polymarket-us' && l.side === 'buy')
      .reduce((s, l) => s + l.price * l.qty + Math.ceil((l.feeCoefficient ?? 0.06) * l.price * (1 - l.price) * l.qty * 100) / 100, 0);
    if (available < cost) {
      return {
        ok: false,
        reason: `buying power $${available.toFixed(2)} < basket cost $${cost.toFixed(2)} — deposit funds or wait for open positions to resolve`,
      };
    }
    return { ok: true };
  }

  /** Real-money counters for live trades, shadow counters for simulated ones. */
  private riskStateFor(mode: TradingMode): ReturnType<typeof freshState> {
    return mode === 'live' ? this.state : this.paperState;
  }

  /** Start the scan loop. Returns immediately. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.logger.info({ mode: this.mode }, 'engine started');
    this.loopHandle = setTimeout(() => this.tick().catch((e) => this.logger.error(e)), 0);
    this.scheduleNextDailyReport();
    this.scheduleReconciliation();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopHandle) clearTimeout(this.loopHandle);
    this.loopHandle = null;
    if (this.reportHandle) clearTimeout(this.reportHandle);
    this.reportHandle = null;
    if (this.reconcileHandle) clearInterval(this.reconcileHandle);
    this.reconcileHandle = null;
    this.logger.info('engine stopped');
  }

  /**
   * Every 10 minutes (and once at startup), compare the exchange's open
   * positions against the net of every live fill in the ledger. Exists
   * because of the 2026-07-29 incident: a response-parsing bug made real
   * fills look like rejections, and the account quietly accumulated a
   * one-sided position the ledger knew nothing about. Warn-only — a
   * mismatch can also be Cesar trading manually in the same account — but
   * it is surfaced in /api/status so it can never stay invisible.
   */
  private scheduleReconciliation(): void {
    if (!this.liveRoutedVenues.has('polymarket-us') || this.config.execution.dryRun) return;
    const run = () =>
      this.reconcileUsPositions().catch((e) =>
        this.logger.error({ err: (e as Error).message }, 'position reconciliation failed'),
      );
    run();
    this.reconcileHandle = setInterval(run, 10 * 60 * 1000);
  }

  private async reconcileUsPositions(): Promise<void> {
    // Ledger side: net contracts per market across every live fill ever.
    const ledgerNet = new Map<string, number>();
    for (const trade of this.storage.liveTrades()) {
      for (const fill of trade.fills) {
        if (fill.venue !== 'polymarket-us') continue;
        const slug = fill.symbol.split(':')[0] ?? fill.symbol;
        const signed = fill.side === 'buy' ? fill.qty : -fill.qty;
        ledgerNet.set(slug, (ledgerNet.get(slug) ?? 0) + signed);
      }
    }
    let exchange;
    try {
      exchange = await this.polymarketUs.openPositions();
    } catch (err) {
      this.lastReconciliation = {
        at: Date.now(),
        ok: false,
        error: `positions fetch failed: ${(err as Error).message}`,
        mismatches: [],
      };
      return;
    }
    const exchangeNet = new Map(exchange.map((p) => [p.marketSlug, p.netPosition]));
    const slugs = new Set([...ledgerNet.keys(), ...exchangeNet.keys()]);
    const mismatches: { marketSlug: string; ledgerNet: number; exchangeNet: number }[] = [];
    for (const slug of slugs) {
      const ledger = ledgerNet.get(slug) ?? 0;
      const actual = exchangeNet.get(slug) ?? 0;
      // Absence from an active listing is not proof of settlement. Compare all ledger positions.
      if (Math.abs(ledger - actual) > 1e-6) {
        mismatches.push({ marketSlug: slug, ledgerNet: ledger, exchangeNet: actual });
      }
    }
    // Markets we already hold. Feeds the concentration guard in tick().
    this.heldUsSlugs = new Set(exchange.map((p) => p.marketSlug));
    // Refresh buying power on the same cadence so the dashboard shows it even
    // when no opportunity fires — an account with no cash should say so.
    this.polymarketUs.invalidateBalance();
    try {
      this.buyingPowerUsd = await this.polymarketUs.buyingPowerUsd();
    } catch {
      /* leave the last known value; the next cycle retries */
    }
    this.lastReconciliation = { at: Date.now(), ok: mismatches.length === 0, mismatches };
    if (mismatches.length > 0) {
      this.logger.warn(
        { mismatches },
        'POSITION MISMATCH: exchange holdings differ from ledger — bot bug or manual trading; reconcile before trusting P&L',
      );
    }
  }

  /**
   * Write one bookkeeping entry that brings the ledger's net position in each
   * market to what the exchange actually holds.
   *
   * Append-only by design: no historical fill is edited, so the correction is
   * auditable and undone by deleting a single row. The entry carries
   * zero-price fills — it corrects quantities, never P&L, because the cash
   * effect of the missing sells already happened in the account.
   *
   * Needed because unwind sells were dropped from trade records (fixed in
   * executeOpportunity, but the old rows can't heal themselves): the exchange
   * executed 120 Philadelphia / 60 Dallas / 50 Giants sells the ledger never
   * saw, leaving reconciliation permanently red.
   */
  async applyReconciliationAdjustment(): Promise<{
    applied: boolean;
    entries: { marketSlug: string; ledgerNet: number; exchangeNet: number; correction: number }[];
  }> {
    const ledgerNet = new Map<string, number>();
    for (const t of this.storage.liveTrades()) {
      for (const f of t.fills) {
        if (f.venue !== 'polymarket-us') continue;
        const slug = f.symbol.split(':')[0] ?? f.symbol;
        ledgerNet.set(slug, (ledgerNet.get(slug) ?? 0) + (f.side === 'buy' ? f.qty : -f.qty));
      }
    }
    const exchange = await this.polymarketUs.openPositions();
    const exchangeNet = new Map(exchange.map((p) => [p.marketSlug, p.netPosition]));
    let activeSlugs: Set<string> | null = null;
    try {
      const events = await this.polymarketUs.listActiveEvents();
      activeSlugs = new Set(events.flatMap((e) => e.markets.map((m) => m.slug)));
    } catch {
      activeSlugs = null;
    }

    const entries: { marketSlug: string; ledgerNet: number; exchangeNet: number; correction: number }[] = [];
    const fills: Fill[] = [];
    for (const slug of new Set([...ledgerNet.keys(), ...exchangeNet.keys()])) {
      const ledger = ledgerNet.get(slug) ?? 0;
      const actual = exchangeNet.get(slug) ?? 0;
      // Settled markets vanish from the listing; their ledger rows are history,
      // not a discrepancy.
      // Absence from an active listing is not proof of settlement. Compare all ledger positions.
      const correction = actual - ledger;
      if (Math.abs(correction) < 1e-6) continue;
      entries.push({ marketSlug: slug, ledgerNet: ledger, exchangeNet: actual, correction });
      fills.push({
        venue: 'polymarket-us',
        symbol: `${slug}:LONG`,
        side: correction > 0 ? 'buy' : 'sell',
        qty: Math.abs(correction),
        price: 0,
        feeUsd: 0,
        filledAt: Date.now(),
      });
    }
    if (entries.length === 0) return { applied: false, entries: [] };

    const trade: Trade = {
      id: newTradeId(),
      opportunityId: 'reconciliation',
      strategy: 'adjustment',
      assetClass: 'prediction',
      mode: 'live',
      status: 'closed',
      fills,
      notionalUsd: 0,
      pnlUsd: 0,
      reasoning:
        'LEDGER ADJUSTMENT — not a trade. Corrects recorded net positions to match the exchange, ' +
        'which is the source of truth. The gap came from unwind sells that were executed on the ' +
        'exchange but dropped from their trade records. Zero-price fills: quantities only, no P&L. ' +
        entries
          .map((e) => `${e.marketSlug}: ${e.ledgerNet.toFixed(2)} → ${e.exchangeNet.toFixed(2)}`)
          .join('; '),
      openedAt: Date.now(),
      closedAt: Date.now(),
    };
    this.storage.recordTrade(trade);
    this.logger.warn({ tradeId: trade.id, entries }, 'ledger adjusted to exchange positions');
    await this.reconcileUsPositions();
    return { applied: true, entries };
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
    this.storage.saveKillSwitch(active);
    this.killSwitch = active;
    this.state.killSwitch = active;
    this.persistState();
    this.logger.warn({ active }, 'kill switch toggled');
  }

  status(): EngineStatus {
    return {
      mode: this.mode,
      execution: {
        dryRun: this.config.execution.dryRun,
        liveVenues: [...this.config.execution.liveVenues],
        maxSettlementDays: this.config.execution.maxSettlementDays,
        realOrderTransmissionConfigured:
          this.mode === 'live' &&
          !this.config.execution.dryRun &&
          this.liveRoutedVenues.size > 0,
      },
      running: this.running,
      killSwitch: this.killSwitch,
      startedAt: this.startedAt,
      scannedCount: this.scannedCount,
      candidateCount: this.candidateCount,
      tradedCount: this.tradedCount,
      realizedPnlTodayUsd: this.state.realizedPnlTodayUsd,
      exposureTodayUsd: this.state.exposureTodayUsd,
      buyingPowerUsd: this.buyingPowerUsd,
      limits: this.config.limits,
      lastScanAt: this.lastScanAt,
      lastScanMs: this.lastScanMs,
      marketCounts: this.marketCounts,
      reconciliation: this.lastReconciliation,
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
    if (this.liveRoutedVenues.size || this.storage.liveTrades().length) throw new Error('Cannot erase live trade history');
    this.storage.resetTradeHistory();
    this.recentFires.clear();
    this.state = freshState(this.config.startingEquityUsd);
    this.paperState = freshState(this.config.startingEquityUsd);
    this.paperLossHalt = false;
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
      const paperBefore = this.paperState;
      this.paperState = maybeResetForNewDay(this.paperState, this.config.startingEquityUsd);
      if (this.paperState !== paperBefore) this.paperLossHalt = false;
      // Cesar's kill switch stops everything, simulated trades included.
      this.paperState.killSwitch = this.killSwitch || this.paperLossHalt;

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
        this.storage.recordOpportunity(o, o.edgePct >= minEdge && !o.requiresReview);
      }

      this.candidateCount += candidates.length;
      this.scannedCount += tradable.length;
      this.currentCandidates = candidates;
      this.currentOpportunities = tradable;

      await this.refreshMarketCounts();

      // Try to execute the best tradable opportunity (if any).
      this.gcRecentFires();
      for (const opp of this.currentOpportunities) {
        // Routing gate runs BEFORE risk limits: a half-real trade is unsafe at
        // any size, so it must never depend on a limit being set correctly.
        const routing = this.routingFor(opp);
        if (routing === 'mixed') {
          this.logger.warn(
            {
              opp: opp.id,
              strategy: opp.strategy,
              venues: opp.legs.map((l) => l.venue),
              liveVenues: [...this.liveRoutedVenues],
            },
            'SKIPPED: opportunity spans live and simulated venues — one leg would be ' +
              'real and its hedge fake. Enable every venue in LIVE_VENUES or none.',
          );
          continue;
        }
        // Once ANY venue is live-routed, a paper-routed opportunity is not a
        // trade — it is a simulation the ledger would record as a completed
        // position with invented P&L. Skip it outright rather than "filling"
        // it. (With LIVE_VENUES empty the engine is a pure paper/demo rig and
        // simulating is the whole point, so the gate only applies when real
        // money is in play somewhere.)
        if (routing === 'paper' && this.liveRoutedVenues.size > 0) {
          this.logger.debug(
            { opp: opp.id, strategy: opp.strategy, venues: opp.legs.map((l) => l.venue) },
            'skip: no live-routed venue for this opportunity — not simulating a fill',
          );
          continue;
        }
        const decision = this.guard.evaluate(opp, this.riskStateFor(this.ledgerModeFor(routing)));
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
        // CONCENTRATION: a prediction position only pays out when the event
        // resolves, so buying more of an event we already hold locks up more
        // capital in the same bet rather than compounding a repeatable edge.
        const alreadyHeld = opp.legs
          .map((l) => l.symbol.split(':')[0] ?? l.symbol)
          .filter((slug) => this.heldUsSlugs.has(slug));
        if (routing === 'live' && alreadyHeld.length > 0) {
          this.logger.info(
            { opp: opp.id, alreadyHeld },
            'skip: already holding this event — capital stays locked until it resolves, so re-entering only concentrates the position',
          );
          continue;
        }
        // BUYING POWER: without this the exchange rejects the first leg with a
        // bare HTTP 400 and the bot writes a failed trade every dedupe window,
        // for days, with nothing on the dashboard explaining why.
        if (routing === 'live' && !this.config.execution.dryRun) {
          await this.reconcileUsPositions();
          if (!this.lastReconciliation?.ok) continue;
          if (opp.legs.some((l) => this.heldUsSlugs.has(l.symbol.split(':')[0]!))) continue;
          if (Date.now() >= opp.expiresAt) continue;
          this.polymarketUs.invalidateBalance();
          const affordable = await this.canAfford(opp);
          if (!affordable.ok) {
            this.logger.warn({ opp: opp.id, reason: affordable.reason }, 'skip: cannot fund this trade');
            continue;
          }
        }
        this.recentFires.set(fp, Date.now());
        await this.executeOpportunity(opp, routing);
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
    // Retired venues must not delay a short-lived US opportunity or make a
    // healthy US engine depend on unrelated exchanges being reachable.
    try {
      const events = await this.polymarketUs.listActiveEvents();
      this.marketCounts['polymarket-us'] = events.reduce((n, e) => n + e.markets.length, 0);
    } catch (err) {
      this.marketCounts['polymarket-us'] = 0;
      this.logger.warn({ error: (err as Error).message }, 'US market listing unavailable');
    }
  }

  private async executeOpportunity(opp: Opportunity, routing: 'live' | 'paper' = 'paper'): Promise<void> {
    // Label by how this trade ACTUALLY executes, then size it against the
    // matching set of counters, so a simulation can never spend the real
    // daily budget.
    const mode = this.ledgerModeFor(routing);
    const risk = this.riskStateFor(mode);
    const sizeUsd = this.guard.sizeFor(opp, risk);
    if (opp.requiresReview || Date.now() >= opp.expiresAt || this.killSwitch || !this.guard.evaluate(opp, risk).allowed) return;
    if (opp.legs.every((l) => l.venue === 'polymarket-us')) {
      const quantity = Math.floor(Math.min(...opp.legs.map((l) => l.qty * sizeUsd / opp.sizeUsd)));
      if (quantity <= 0) return;
      const legs = opp.legs.map((l) => ({ ...l, qty: quantity }));
      const cost = legs.reduce((sum, l) => sum + l.price * l.qty, 0);
      const fees = legs.reduce((sum, l) => sum + Math.ceil((l.feeCoefficient ?? 0.06) * l.price * (1 - l.price) * quantity * 100) / 100, 0);
      if (!(cost > 0) || (quantity - cost - fees) / cost * 100 < this.config.limits.minSpreadPct) return;
      opp = { ...opp, legs, sizeUsd: cost };
    }
    const trade: Trade = {
      id: newTradeId(),
      opportunityId: opp.id,
      strategy: opp.strategy,
      assetClass: opp.assetClass,
      mode,
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
    const scaleFactor = opp.legs.every((l) => l.venue === 'polymarket-us') ? 1 : sizeUsd / opp.sizeUsd;
    if (!(scaleFactor > 0) || !Number.isFinite(scaleFactor)) return;
    let failReason = '';
    const filledLegs: OpportunityLeg[] = [];
    for (const leg of opp.legs) {
      // A stop received while an earlier order was in flight must block the
      // next entry. Recovery orders remain allowed to reduce exposure.
      if (this.killSwitch) { failReason = 'kill switch engaged during execution'; break; }
      const exec = this.executorByVenue.get(leg.venue);
      if (!exec) { failReason = `no executor for ${leg.venue}`; break; }
      const scaledLeg = { ...leg, qty: leg.qty * scaleFactor };
      try {
        const beforeOrder = trade.reasoning;
        trade.reasoning += ' [ORDER_PENDING]';
        this.storage.recordTrade(trade);
        const res = await exec.placeMarketOrder(scaledLeg);
        if (!res.uncertain) trade.reasoning = beforeOrder;
        if (res.fill) {
          fills.push(res.fill);
          // Never sell the requested quantity when the actual fill was smaller.
          filledLegs.push({ ...scaledLeg, qty: res.fill.qty, price: res.fill.price });
          trade.fills = [...fills];
          this.storage.recordTrade(trade);
        }
        if (res.uncertain) this.flagNakedPosition(trade, scaledLeg, res.error ?? 'order outcome unknown');
        if (!res.ok || !res.fill) { failReason = res.error ?? 'leg did not fill'; break; }
        if (Math.abs(res.fill.qty - scaledLeg.qty) > 1e-6) {
          failReason = 'incomplete entry fill — aborting basket';
          break;
        }
      } catch (err) {
        failReason = `order outcome unknown: ${(err as Error).message}`;
        this.flagNakedPosition(trade, scaledLeg, failReason);
        break;
      }
    }

    if (failReason) await this.unwindLegs(filledLegs, trade, fills);
    trade.fills = fills;
    const net = new Map<string, number>();
    for (const f of fills) {
      const key = `${f.venue}:${f.symbol}`;
      net.set(key, (net.get(key) ?? 0) + (f.side === 'buy' ? f.qty : -f.qty));
    }
    const hasPosition = [...net.values()].some((q) => Math.abs(q) > 1e-6);
    const cashCost = fills.reduce((sum, f) => sum + (f.side === 'buy' ? 1 : -1) * f.price * f.qty + f.feeUsd, 0);
    trade.notionalUsd = fills.filter((f) => f.side === 'buy').reduce((sum, f) => sum + f.price * f.qty, 0);
    // Prediction payout is not cash received. Leave it open until an explicit
    // settlement/account reconciliation supplies the realised result.
    const pending = opp.assetClass === 'prediction' && hasPosition;
    trade.status = failReason ? 'failed' : pending ? 'open' : 'closed';
    trade.closedAt = pending ? null : Date.now();
    trade.pnlUsd = pending || this.killSwitch ? null : opp.assetClass === 'prediction' ? -cashCost : computeRealizedPnl(opp, fills);
    trade.reasoning += failReason ? ` | ABORTED: ${failReason}` : pending ? ' | Awaiting settlement; no realised profit booked.' : '';
    if (failReason && hasPosition) this.flagNakedPosition(trade, filledLegs[0] ?? opp.legs[0]!, 'residual exposure after unwind');
    risk.exposureTodayUsd += trade.notionalUsd;
    risk.realizedPnlTodayUsd += trade.pnlUsd ?? 0;
    if (-risk.realizedPnlTodayUsd / Math.max(risk.startingEquityUsd, 1) * 100 >= this.config.limits.maxDailyLossPct) {
      if (mode === 'live') this.setKillSwitch(true);
      else this.paperLossHalt = true;
    }
    this.storage.recordTrade(trade);
    this.persistState();
    this.tradedCount += 1;
    if (routing === 'live' && !this.config.execution.dryRun) {
      this.polymarketUs.invalidateBalance();
      await this.reconcileUsPositions();
    }
  }

  /**
   * Unwind already-filled legs after a later leg failed, by placing the
   * opposite market order on each. Best-effort: if an unwind ITSELF fails the
   * position is genuinely naked — we trip the kill-switch and log CRITICAL so
   * a human reconciles it. The unwind fills are appended to the trade record.
   */
  private async unwindLegs(filledLegs: OpportunityLeg[], trade: Trade, into: Fill[]): Promise<void> {
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
        const quote = await exec.ticker(leg.symbol);
        opposite.price = opposite.side === 'sell' ? quote.bid : quote.ask;
        if (!(opposite.price > 0) || !Number.isFinite(opposite.price)) throw new Error('no executable recovery quote');
        const beforeOrder = trade.reasoning;
        trade.reasoning += ' [ORDER_PENDING]';
        this.storage.recordTrade(trade);
        const res = await exec.placeMarketOrder(opposite);
        if (!res.uncertain) trade.reasoning = beforeOrder;
        if (res.fill) into.push(res.fill);
        trade.fills = [...into];
        this.storage.recordTrade(trade);
        if (!res.ok || !res.fill || res.uncertain) {
          this.flagNakedPosition(trade, leg, res.error ?? 'unwind order rejected or uncertain');
          continue;
        }
        trade.fills = [...into];
        this.storage.recordTrade(trade);
        if (Math.abs(res.fill.qty - leg.qty) > 1e-6) {
          this.flagNakedPosition(trade, leg, 'unwind filled only part of the exposure');
        }
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
    // Exactly one leg of the outcome set pays $1, so the guaranteed payoff is
    // the SMALLEST net position across every leg — a basket is only hedged up
    // to its thinnest side.
    //
    // This used to read min(fills[0].qty, fills[1].qty), which is right for a
    // two-leg YES/NO pair but silently wrong for the 3+ leg US event baskets:
    // it ignored legs 3..n entirely. On 2026-08-01 a basket that filled
    // 10/10/3.93/0.07 contracts was booked as +$2.71 profit when the real
    // guaranteed payoff was $0.07 against $7.00 of cost.
    //
    // Netting by symbol also makes unwind sells subtract correctly, so a
    // trimmed over-fill values at what it actually cost to get flat.
    const net = new Map<string, number>();
    let cash = 0;
    for (const f of fills) {
      const dir = f.side === 'buy' ? 1 : -1;
      net.set(f.symbol, (net.get(f.symbol) ?? 0) + dir * f.qty);
      cash += dir * f.price * f.qty + f.feeUsd;
    }
    if (net.size === 0) return 0;
    const payoff = Math.min(...net.values());
    return payoff - cash;
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
