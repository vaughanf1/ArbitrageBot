import type {
  AssetClass,
  Opportunity,
  OpportunityLeg,
  StrategyKind,
} from '@cesar-arb/shared';
import type { PolymarketUsExecutor, UsEvent } from '@cesar-arb/executors';
import { newOpportunityId, type Scanner } from './base.js';

/**
 * Polymarket US event arbitrage — single venue, N legs.
 *
 * On the US exchange (QCEX) each market is ONE instrument with one matched
 * book: "Yes" is long, "No" is short of the same thing, so ask + (1 − bid)
 * ≥ $1 always and the global CLOB's YES+NO-under-$1 arb cannot exist inside
 * a single market. The equivalent structure lives across the SIBLING markets
 * of a multi-outcome event (e.g. "NL Champion" = one market per team): the
 * books are independent, exactly one outcome resolves to $1, so if you can
 * buy long on EVERY outcome for a combined cost under $1, the difference is
 * locked-in profit — same math as YES+NO, generalized to N legs.
 *
 * The catch is EXHAUSTIVENESS: the profit is only riskless if the event's
 * markets cover every possible outcome. That can't be proven from the API,
 * so this scanner auto-fires only on sports events (a league champion /
 * game winner is one of the listed teams by construction) and marks
 * everything else review-only — the same allowlist philosophy the
 * cross-venue scanner used. A politics event with a missing candidate looks
 * IDENTICAL to an arb in the data; that's precisely when not to fire.
 */

/**
 * QCEX taker commission per contract ≈ rate · price · (1 − price). Rate
 * fitted to real fills (2026-07-29/30): $0.42 on 4×10 @ 0.36/0.34/0.15/0.13,
 * $0.68 on 50 @ 0.35, $0.01 on 1 @ 0.48.
 */
const US_FEE_RATE = 0.06;

export interface UsEventArbScannerOptions {
  executor: PolymarketUsExecutor;
  minEdgePct: number;
  sizeUsd: number;
  /** Per-leg taker fee in bps, applied to deployed notional. Default 0. */
  feeBps?: number;
  /** Max sibling markets an event may have before we skip it. Default 12. */
  maxLegs?: number;
  /** Max book fetches per scan tick (public API budget). Default 60. */
  maxBooks?: number;
  /** Max candidates emitted per scan (strongest first). Default 25. */
  maxResults?: number;
  ttlMs?: number;
}

export class UsEventArbScanner implements Scanner {
  readonly name = 'us-event-arb';
  private readonly executor: PolymarketUsExecutor;
  private readonly minEdgePct: number;
  private readonly sizeUsd: number;
  private readonly feeBps: number;
  private readonly maxLegs: number;
  private readonly maxBooks: number;
  private readonly maxResults: number;
  private readonly ttlMs: number;
  /** Rotating cursor so successive ticks cover different events. */
  private cursor = 0;

  constructor(opts: UsEventArbScannerOptions) {
    this.executor = opts.executor;
    this.minEdgePct = opts.minEdgePct;
    this.sizeUsd = opts.sizeUsd;
    this.feeBps = opts.feeBps ?? 0;
    this.maxLegs = opts.maxLegs ?? 12;
    this.maxBooks = opts.maxBooks ?? 60;
    this.maxResults = opts.maxResults ?? 25;
    this.ttlMs = opts.ttlMs ?? 6_000;
  }

  async scan(): Promise<Opportunity[]> {
    let events: UsEvent[];
    try {
      events = await this.executor.listActiveEvents();
    } catch {
      return [];
    }

    // Only multi-outcome events can arb (2+ independent books), and huge
    // outcome sets are execution nightmares — bound the leg count.
    const candidates = events.filter(
      (e) => e.markets.length >= 2 && e.markets.length <= this.maxLegs,
    );
    if (candidates.length === 0) return [];

    // The public API budget won't cover every event each tick. Rotate a
    // window across the candidate list so all events get scanned over a few
    // ticks rather than the same head slice every time.
    const picked: UsEvent[] = [];
    let bookBudget = this.maxBooks;
    for (let i = 0; i < candidates.length && bookBudget > 0; i++) {
      const e = candidates[(this.cursor + i) % candidates.length]!;
      if (e.markets.length > bookBudget) continue;
      picked.push(e);
      bookBudget -= e.markets.length;
    }
    this.cursor = (this.cursor + picked.length) % Math.max(1, candidates.length);

    const slugs = picked.flatMap((e) => e.markets.map((m) => m.slug));
    let books: Awaited<ReturnType<PolymarketUsExecutor['topOfBooks']>>;
    try {
      books = await this.executor.topOfBooks(slugs);
    } catch {
      return [];
    }

    const now = Date.now();
    const out: Opportunity[] = [];

    for (const event of picked) {
      // Every outcome needs a fillable ask, else the basket can't be bought.
      const sides = event.markets.map((m) => ({ market: m, book: books.get(m.slug) }));
      if (sides.some((s) => !s.book)) continue;

      const cost = sides.reduce((sum, s) => sum + s.book!.bestAsk, 0);
      if (!isFinite(cost) || cost <= 0 || cost >= 1) continue; // no edge if ≥ $1

      // QCEX charges ~$0.06 · p · (1−p) per contract per leg (verified against
      // real fills 2026-07-30: the first live arb filled at exactly the quoted
      // prices yet lost money because a 2% gross edge paid ~4% in fees). The
      // edge must clear fees or the "guaranteed profit" is a guaranteed loss.
      const feePerContractSet = sides.reduce((sum, s) => {
        const p = s.book!.bestAsk;
        return sum + US_FEE_RATE * p * (1 - p);
      }, 0);
      const extraFeePct = (this.feeBps * event.markets.length) / 100;
      const grossEdgePct = ((1 - cost) / cost) * 100;
      const edgePct = ((1 - cost - feePerContractSet) / cost) * 100 - extraFeePct;

      // Whole contracts only on the US exchange, and every leg needs the SAME
      // quantity for the payoff math to hold — cap by the shallowest book.
      const maxQtyByBook = Math.min(...sides.map((s) => s.book!.askSize));
      const qty = Math.floor(Math.min(this.sizeUsd / cost, maxQtyByBook));
      if (qty <= 0) continue;

      const deployedUsd = qty * cost;
      // Exchange rounds each leg's commission to the cent — round up per leg
      // so the estimate errs against firing marginal trades.
      const estFeeUsd = sides.reduce((sum, s) => {
        const p = s.book!.bestAsk;
        return sum + Math.ceil(US_FEE_RATE * p * (1 - p) * qty * 100) / 100;
      }, 0);
      const profitUsd = qty * (1 - cost) - estFeeUsd - (deployedUsd * extraFeePct) / 100;
      if (profitUsd <= 0) continue; // fee-negative "arb" — never worth firing

      const legs: OpportunityLeg[] = sides.map((s) => ({
        venue: 'polymarket-us',
        symbol: `${s.market.slug}:LONG`,
        side: 'buy',
        price: s.book!.bestAsk,
        qty,
        note: `buy ${truncate(s.market.question, 40)} @ ${s.book!.bestAsk.toFixed(3)} (depth ${s.book!.askSize})`,
      }));

      // Sports outcome sets (game winner, league champion) are exhaustive by
      // construction. Anything else could silently omit an outcome, which
      // makes "sum of asks < $1" a directional bet, not an arb — review only.
      const exhaustive = event.category === 'sports';

      out.push({
        id: newOpportunityId('use'),
        // Same P&L model as YES+NO: cost = Σ price·qty, payoff = min qty
        // (exactly one $1-payoff leg wins).
        strategy: 'prediction-pair' as StrategyKind,
        assetClass: 'prediction' as AssetClass,
        venues: ['polymarket-us'],
        description: `US event arb: ${truncate(event.title, 60)} (${event.markets.length} outcomes)`,
        edgePct,
        estProfitUsd: profitUsd,
        sizeUsd: deployedUsd,
        legs,
        reasoning:
          `Polymarket US multi-outcome arb on "${event.title}". Buying long on all ` +
          `${event.markets.length} outcomes costs $${cost.toFixed(3)} for a guaranteed $1 payoff ` +
          `→ ${edgePct.toFixed(2)}% net edge (${grossEdgePct.toFixed(2)}% gross − est. fees $${estFeeUsd.toFixed(2)})` +
          `. Fillable size ${qty} contracts (shallowest book ${maxQtyByBook.toFixed(0)}). ` +
          (exhaustive
            ? 'Sports outcome set — exhaustive by construction, one leg must pay.'
            : 'NON-sports event: outcome set may not be exhaustive — review before trading.'),
        detectedAt: now,
        expiresAt: now + this.ttlMs,
        source: exhaustive ? 'confirmed' : 'heuristic',
        requiresReview: !exhaustive,
      });
    }

    out.sort((a, b) => b.edgePct - a.edgePct);
    return out.slice(0, this.maxResults);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
