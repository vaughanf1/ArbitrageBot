import type {
  AssetClass,
  Opportunity,
  OpportunityLeg,
  StrategyKind,
} from '@cesar-arb/shared';
import type {
  PolymarketExecutor,
  PolymarketMarket,
  KalshiExecutor,
  KalshiMarket,
} from '@cesar-arb/executors';
import { newOpportunityId, type Scanner } from './base.js';
import { PREDICTION_PAIRS, type PredictionPair } from './prediction-pairs.js';

export type PredictionMatchMode = 'allowlist' | 'strict';

export interface PredictionScannerOptions {
  polymarket: PolymarketExecutor;
  kalshi: KalshiExecutor;
  /** Minimum edge percent (e.g. 1.0 = 1%). */
  minEdgePct: number;
  /** Trade size in USD per leg. */
  sizeUsd: number;
  /** Minimum 24h volume on each side. */
  minVolume24h?: number;
  /**
   * Match mode:
   *   - 'allowlist' (default): only consider pairs in PREDICTION_PAIRS.
   *     Zero false positives at the cost of zero opportunities until the
   *     curated list grows.
   *   - 'strict': use heuristic text matching with tight rules
   *     (high Jaccard similarity + named-entity contradiction check).
   *     Will surface candidate pairs but is not guaranteed safe — review
   *     before trusting a `strict`-mode trade.
   */
  matchMode?: PredictionMatchMode;
  /** Used only in 'strict' mode. */
  minSimilarity?: number;
  /** Optional override of the allowlist (mostly for tests). */
  pairs?: PredictionPair[];
  ttlMs?: number;
  /** Round-trip fee assumption in bps (Kalshi has fees, Polymarket has gas/relayer). */
  feeBps?: number;
}

/**
 * Scans Polymarket × Kalshi for the same event being priced differently.
 *
 * Arbitrage construction (when YES_poly + NO_kalshi < 1, after fees):
 *   - Buy YES on Polymarket at yesAsk_poly
 *   - Buy NO on Kalshi at noAsk_kalshi
 *   - One side will resolve to 1 → payoff 1 regardless of outcome
 *   - Profit = 1 - (yesAsk_poly + noAsk_kalshi) - fees
 *
 * Symmetric: NO_poly + YES_kalshi < 1.
 *
 * IMPORTANT: this construction is only valid when the two markets resolve
 * to the SAME binary outcome. If Polymarket asks "will X win" and Kalshi
 * asks "will Y win" (where X and Y are distinct candidates), buying
 * YES-X + NO-Y can lose on both sides. That's why we default to an
 * allowlist of confirmed equivalent markets.
 */
export class PredictionScanner implements Scanner {
  readonly name = 'prediction-pair';
  private readonly polymarket: PolymarketExecutor;
  private readonly kalshi: KalshiExecutor;
  private readonly minEdgePct: number;
  private readonly sizeUsd: number;
  private readonly minVolume24h: number;
  private readonly minSimilarity: number;
  private readonly ttlMs: number;
  private readonly feeBps: number;
  private readonly matchMode: PredictionMatchMode;
  private readonly pairs: PredictionPair[];

  constructor(opts: PredictionScannerOptions) {
    this.polymarket = opts.polymarket;
    this.kalshi = opts.kalshi;
    this.minEdgePct = opts.minEdgePct;
    this.sizeUsd = opts.sizeUsd;
    this.minVolume24h = opts.minVolume24h ?? 1_000;
    this.minSimilarity = opts.minSimilarity ?? 0.75;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.feeBps = opts.feeBps ?? 50;
    this.matchMode = opts.matchMode ?? 'allowlist';
    this.pairs = opts.pairs ?? PREDICTION_PAIRS;
  }

  async scan(): Promise<Opportunity[]> {
    const [polyMarkets, kalshiMarkets] = await Promise.all([
      this.polymarket.listActiveMarkets().catch(() => [] as PolymarketMarket[]),
      this.kalshi.listActiveMarkets().catch(() => [] as KalshiMarket[]),
    ]);

    if (this.matchMode === 'allowlist') {
      return this.scanAllowlist(polyMarkets, kalshiMarkets);
    }
    return this.scanStrict(polyMarkets, kalshiMarkets);
  }

  /** Allowlist mode: only consider explicitly-paired markets. */
  private scanAllowlist(
    polyMarkets: PolymarketMarket[],
    kalshiMarkets: KalshiMarket[],
  ): Opportunity[] {
    if (this.pairs.length === 0) return [];
    const polyBySlug = new Map(polyMarkets.map((m) => [m.slug, m]));
    const kalshiByEvent = new Map<string, KalshiMarket[]>();
    for (const m of kalshiMarkets) {
      const list = kalshiByEvent.get(m.eventTicker) ?? [];
      list.push(m);
      kalshiByEvent.set(m.eventTicker, list);
    }

    const out: Opportunity[] = [];
    for (const pair of this.pairs) {
      const p = polyBySlug.get(pair.polymarketSlug);
      if (!p) continue;
      const ks = kalshiByEvent.get(pair.kalshiEventTicker);
      if (!ks || ks.length === 0) continue;
      const k = pair.kalshiTicker
        ? ks.find((m) => m.ticker === pair.kalshiTicker)
        : ks[0];
      if (!k) continue;

      const opp = this.evaluatePair(p, k, 1.0, 'allowlist');
      if (opp) out.push(opp);
    }
    return out;
  }

  /** Strict heuristic mode: high-similarity + named-entity contradiction check. */
  private scanStrict(
    polyMarkets: PolymarketMarket[],
    kalshiMarkets: KalshiMarket[],
  ): Opportunity[] {
    const liquidPoly = polyMarkets.filter((m) => m.volume24h >= this.minVolume24h);
    const liquidKalshi = kalshiMarkets.filter((m) => m.volume24h >= this.minVolume24h);

    const polyEntitiesByCondition = new Map<string, Set<string>>();
    for (const p of liquidPoly) {
      polyEntitiesByCondition.set(p.conditionId, namedEntities(p.question));
    }
    const kalshiEntitiesByTicker = new Map<string, Set<string>>();
    for (const k of liquidKalshi) {
      kalshiEntitiesByTicker.set(k.ticker, namedEntities(`${k.title} ${k.subtitle}`));
    }

    const out: Opportunity[] = [];
    for (const p of liquidPoly) {
      const pTokens = tokenize(p.question);
      const pEnt = polyEntitiesByCondition.get(p.conditionId)!;
      let bestMatch: { k: KalshiMarket; sim: number } | null = null;
      for (const k of liquidKalshi) {
        const kTokens = tokenize(`${k.title} ${k.subtitle}`);
        const sim = jaccard(pTokens, kTokens);
        if (sim < this.minSimilarity) continue;
        // Named-entity contradiction: if each side has at least one specific
        // entity the other side does NOT have, they're describing different
        // events even if generic words overlap. This is the Bertrand vs
        // National Rally case — both have "French/2027/election" in common,
        // but each names a distinct entity the other doesn't.
        const kEnt = kalshiEntitiesByTicker.get(k.ticker)!;
        if (hasContradiction(pEnt, kEnt)) continue;
        // Require at least one shared specific entity (not just stopword overlap).
        if (sharedSpecificCount(pEnt, kEnt) < 1) continue;
        if (!bestMatch || sim > bestMatch.sim) bestMatch = { k, sim };
      }
      if (!bestMatch) continue;
      const opp = this.evaluatePair(p, bestMatch.k, bestMatch.sim, 'strict');
      if (opp) out.push(opp);
    }
    return out;
  }

  private evaluatePair(
    p: PolymarketMarket,
    k: KalshiMarket,
    sim: number,
    source: 'allowlist' | 'strict',
  ): Opportunity | null {
    const fee = 1 - this.feeBps / 10_000;

    // Polymarket prices are 0..1 (probability). Kalshi as of 2025+ uses dollar fields.
    const polyYesAsk = p.yesPrice;
    const polyNoAsk = p.noPrice;
    const kalshiYesAsk = k.yesAsk;
    const kalshiNoAsk = k.noAsk;

    // Build A: YES on Polymarket + NO on Kalshi
    const costA = polyYesAsk + kalshiNoAsk;
    // Build B: NO on Polymarket + YES on Kalshi
    const costB = polyNoAsk + kalshiYesAsk;

    const buildAEdge = ((1 / costA) * fee * fee - 1) * 100;
    const buildBEdge = ((1 / costB) * fee * fee - 1) * 100;

    const usingA = buildAEdge >= buildBEdge;
    const edgePct = usingA ? buildAEdge : buildBEdge;
    if (edgePct < this.minEdgePct) return null;

    const cost = usingA ? costA : costB;
    if (cost <= 0 || cost >= 1) return null;

    const polySide = usingA ? 'YES' : 'NO';
    const kalshiSide = usingA ? 'NO' : 'YES';
    const polyPrice = usingA ? polyYesAsk : polyNoAsk;
    const kalshiPrice = usingA ? kalshiNoAsk : kalshiYesAsk;
    const contracts = this.sizeUsd / (polyPrice + kalshiPrice);
    const polyQty = contracts;
    const kalshiQty = contracts;

    const legs: OpportunityLeg[] = [
      {
        venue: 'polymarket',
        symbol: `${p.conditionId}:${polySide}`,
        side: 'buy',
        price: polyPrice,
        qty: polyQty,
        note: `buy ${polySide} on Polymarket — "${truncate(p.question, 80)}"`,
      },
      {
        venue: 'kalshi',
        symbol: `${k.ticker}:${kalshiSide}`,
        side: 'buy',
        price: kalshiPrice,
        qty: kalshiQty,
        note: `buy ${kalshiSide} on Kalshi — "${truncate(k.title, 80)}"`,
      },
    ];

    const profitUsd = (this.sizeUsd / cost) - this.sizeUsd;
    const matchTag = source === 'allowlist'
      ? 'Confirmed pair (allowlist)'
      : `Heuristic match (similarity ${(sim * 100).toFixed(0)}%, no entity contradiction)`;
    const reasoning =
      `${matchTag}. ` +
      `Combined cost of paired ${polySide}/${kalshiSide} legs = ${cost.toFixed(3)} per $1 payoff. ` +
      `Whichever side resolves wins $1 → edge ${edgePct.toFixed(2)}% after ~${this.feeBps / 100}% fees. ` +
      `Poly: "${truncate(p.question, 60)}" | Kalshi: "${truncate(k.title, 60)}".`;

    const now = Date.now();
    return {
      id: newOpportunityId('pred'),
      strategy: 'prediction-pair' as StrategyKind,
      assetClass: 'prediction' as AssetClass,
      venues: ['polymarket', 'kalshi'],
      description: `Polymarket ${polySide} ↔ Kalshi ${kalshiSide}: "${truncate(p.question, 60)}"`,
      edgePct,
      estProfitUsd: profitUsd,
      sizeUsd: this.sizeUsd,
      legs,
      reasoning,
      detectedAt: now,
      expiresAt: now + this.ttlMs,
    };
  }
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'be', 'will', 'is', 'are', 'on', 'at', 'in', 'of', 'to',
  'for', 'by', 'with', 'and', 'or', 'this', 'that', 'it', 'its', 'as',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'has', 'have',
  'than', 'before', 'after', 'who', 'what', 'when', 'win', 'wins', 'won',
]);

// Generic event-template words — present in almost every "will X win Y" market.
// We exclude these from the entity-contradiction check so e.g. "election"
// isn't treated as a distinguishing entity.
const GENERIC_EVENT_WORDS = new Set([
  'election', 'elections', 'presidential', 'primary', 'general',
  'race', 'vote', 'votes', 'voting', 'poll', 'polls',
  'champion', 'championship', 'final', 'finals', 'tournament',
  'winner', 'season', 'series',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

/**
 * Extract specific named entities — capitalized words ≥ 3 chars and 4-digit
 * years — that distinguish one event from another. Excludes generic
 * event-template words ("election", "primary", etc.) and stopwords.
 *
 * Returned tokens are lowercased to make comparison case-insensitive.
 */
function namedEntities(s: string): Set<string> {
  const out = new Set<string>();
  const words = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const w of words) {
    if (/^\d{4}$/.test(w)) {
      out.add(w);
      continue;
    }
    if (w.length < 3) continue;
    // Capitalized word — likely a proper noun.
    if (/^[A-Z]/.test(w)) {
      const lower = w.toLowerCase();
      if (STOPWORDS.has(lower)) continue;
      if (GENERIC_EVENT_WORDS.has(lower)) continue;
      out.add(lower);
    }
  }
  return out;
}

/**
 * Two markets contradict if each side has at least one specific named entity
 * that the other side does not. Different candidates / parties / countries /
 * years / specific values present on each side imply they're describing
 * different sub-questions of the same event template.
 */
function hasContradiction(a: Set<string>, b: Set<string>): boolean {
  let aOnly = false;
  let bOnly = false;
  for (const t of a) {
    if (!b.has(t)) {
      aOnly = true;
      if (bOnly) return true;
    }
  }
  for (const t of b) {
    if (!a.has(t)) {
      bOnly = true;
      if (aOnly) return true;
    }
  }
  return aOnly && bOnly;
}

function sharedSpecificCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
