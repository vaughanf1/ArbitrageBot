import type {
  AssetClass,
  Opportunity,
  OpportunityLeg,
  StrategyKind,
} from '@cesar-arb/shared';
import type { PolymarketExecutor, PolymarketMarket } from '@cesar-arb/executors';
import { newOpportunityId, type Scanner } from './base.js';

/**
 * Intra-market Polymarket arbitrage — single venue, two legs.
 *
 * A binary Polymarket market has a YES token and a NO token. At resolution
 * exactly one pays $1 and the other pays $0, so owning one of each guarantees
 * a $1 payout per pair. If you can BUY YES and BUY NO for a combined cost
 * BELOW $1, you lock a risk-free profit of (1 − cost) per pair.
 *
 * Why this is genuinely risk-free (unlike the old Poly↔Kalshi pair):
 *   - Both legs settle on the SAME market's resolution. There is no
 *     "do these two markets resolve on the same criteria?" risk — it's one
 *     market, so the pair is always 'confirmed' / never requiresReview.
 *   - No on-chain transfer or cross-venue inventory in the loop.
 *
 * The only real risks are execution risks, which this scanner controls for:
 *   - It reads the LIVE order book (`executor.orderBooks`), not the Gamma
 *     mid. Gamma mids always sum to ~$1; only the real book reveals a sub-$1
 *     YES_ask + NO_ask. Detection quality therefore depends on the book, as
 *     it should.
 *   - It caps trade size to the depth available at the best level on BOTH
 *     sides, so the quoted edge is actually fillable.
 *
 * Bounding note: Polymarket lists hundreds of active markets. Fetching a
 * full order book for every one each tick is wasteful, so this scans the top
 * `maxMarkets` by 24h volume (the liquid ones an arb can actually fill) and
 * emits at most `maxResults` candidates. That bound is intentional and
 * surfaced here rather than hidden — widen it if you want deeper coverage.
 */

export interface PolyIntraMarketScannerOptions {
  polymarket: PolymarketExecutor;
  minEdgePct: number;
  sizeUsd: number;
  /** Skip markets thinner than this in 24h USD volume. Default $5k. */
  minVolume24hUsd?: number;
  /** Per-leg taker fee in bps. Polymarket's global CLOB charges 0. Default 0. */
  feeBps?: number;
  /** Max markets (by volume) to pull books for each tick. Default 80. */
  maxMarkets?: number;
  /** Max candidates emitted per scan (strongest first). Default 25. */
  maxResults?: number;
  ttlMs?: number;
}

export class PolyIntraMarketScanner implements Scanner {
  readonly name = 'poly-intra-market';
  private readonly polymarket: PolymarketExecutor;
  private readonly minEdgePct: number;
  private readonly sizeUsd: number;
  private readonly minVolume24hUsd: number;
  private readonly feeBps: number;
  private readonly maxMarkets: number;
  private readonly maxResults: number;
  private readonly ttlMs: number;

  constructor(opts: PolyIntraMarketScannerOptions) {
    this.polymarket = opts.polymarket;
    this.minEdgePct = opts.minEdgePct;
    this.sizeUsd = opts.sizeUsd;
    this.minVolume24hUsd = opts.minVolume24hUsd ?? 5_000;
    this.feeBps = opts.feeBps ?? 0;
    this.maxMarkets = opts.maxMarkets ?? 80;
    this.maxResults = opts.maxResults ?? 25;
    this.ttlMs = opts.ttlMs ?? 6_000;
  }

  async scan(): Promise<Opportunity[]> {
    let markets: PolymarketMarket[];
    try {
      markets = await this.polymarket.listActiveMarkets();
    } catch {
      return [];
    }

    // Liquid markets only, richest first, bounded to maxMarkets.
    const liquid = markets
      .filter((m) => m.volume24h >= this.minVolume24hUsd && m.yesTokenId && m.noTokenId)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, this.maxMarkets);
    if (liquid.length === 0) return [];

    // One batched book fetch for every YES and NO token across all markets.
    const tokenIds: string[] = [];
    for (const m of liquid) {
      tokenIds.push(m.yesTokenId, m.noTokenId);
    }
    let books: Awaited<ReturnType<PolymarketExecutor['orderBooks']>>;
    try {
      books = await this.polymarket.orderBooks(tokenIds);
    } catch {
      return [];
    }

    const now = Date.now();
    const roundTripFeePct = (this.feeBps * 2) / 100;
    const out: Opportunity[] = [];

    for (const m of liquid) {
      const yes = books.get(m.yesTokenId);
      const no = books.get(m.noTokenId);
      if (!yes || !no) continue; // need a fillable ask on BOTH sides

      const cost = yes.bestAsk + no.bestAsk; // USD to buy one of each
      if (!isFinite(cost) || cost <= 0 || cost >= 1) continue; // no edge if ≥ $1

      const grossEdgePct = ((1 - cost) / cost) * 100;
      const edgePct = grossEdgePct - roundTripFeePct;

      // Size is capped by the shallower side's depth at the best level so the
      // quoted edge is actually executable, then by the configured sizeUsd.
      const maxQtyByBook = Math.min(yes.askSize, no.askSize);
      const qtyByBudget = this.sizeUsd / cost;
      const qty = Math.min(qtyByBudget, maxQtyByBook);
      if (!(qty > 0) || !isFinite(qty)) continue;

      const deployedUsd = qty * cost;
      const profitUsd = qty * (1 - cost) - (deployedUsd * roundTripFeePct) / 100;

      const legs: OpportunityLeg[] = [
        {
          venue: 'polymarket',
          symbol: `${m.conditionId}:YES`,
          side: 'buy',
          price: yes.bestAsk,
          qty,
          note: `buy YES @ ${yes.bestAsk.toFixed(3)} (depth ${yes.askSize})`,
        },
        {
          venue: 'polymarket',
          symbol: `${m.conditionId}:NO`,
          side: 'buy',
          price: no.bestAsk,
          qty,
          note: `buy NO @ ${no.bestAsk.toFixed(3)} (depth ${no.askSize})`,
        },
      ];

      out.push({
        id: newOpportunityId('pim'),
        // Reuse 'prediction-pair' P&L: cost = Σ price·qty, payoff = min(qty) —
        // identical math (one of the two $1-payoff legs wins).
        strategy: 'prediction-pair' as StrategyKind,
        assetClass: 'prediction' as AssetClass,
        venues: ['polymarket'],
        description: `Poly YES+NO: ${truncate(m.question, 70)}`,
        edgePct,
        estProfitUsd: profitUsd,
        sizeUsd: deployedUsd,
        legs,
        reasoning:
          `Single-market arb on Polymarket "${m.question}". ` +
          `YES best ask ${yes.bestAsk.toFixed(3)} + NO best ask ${no.bestAsk.toFixed(3)} ` +
          `= ${cost.toFixed(3)} for a guaranteed $1 payoff → ${edgePct.toFixed(2)}% edge` +
          (roundTripFeePct > 0 ? ` after ${roundTripFeePct.toFixed(2)}% fees` : '') +
          `. Fillable size ${qty.toFixed(2)} contracts (capped by book depth ` +
          `${maxQtyByBook.toFixed(2)}). Both legs resolve on the same market — no ` +
          `cross-venue resolution risk.`,
        detectedAt: now,
        expiresAt: now + this.ttlMs,
        // One market, one resolution, real book — not a fuzzy cross-venue match.
        source: 'confirmed',
        requiresReview: false,
      });
    }

    out.sort((a, b) => b.edgePct - a.edgePct);
    return out.slice(0, this.maxResults);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
