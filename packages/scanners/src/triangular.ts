import type {
  AssetClass,
  Opportunity,
  OpportunityLeg,
  StrategyKind,
  Venue,
} from '@cesar-arb/shared';
import type { Executor, MarketTicker } from '@cesar-arb/executors';
import { newOpportunityId, type Scanner } from './base.js';

/**
 * A triangle is three pairs that close a loop, e.g.
 *   { quote: 'USDT', mid: 'BTC', other: 'ETH',
 *     pairs: { quoteMid: 'BTCUSDT', quoteOther: 'ETHUSDT', midOther: 'ETHBTC' } }
 *
 * Starting from `quote`:
 *   Direction A: quote → mid → other → quote
 *     buy mid with quote, buy other with mid, sell other for quote
 *   Direction B: quote → other → mid → quote
 *     buy other with quote, buy mid with other, sell mid for quote
 */
export interface Triangle {
  quote: string;
  mid: string;
  other: string;
  pairs: {
    quoteMid: string; // e.g. BTCUSDT
    quoteOther: string; // e.g. ETHUSDT
    midOther: string; // e.g. ETHBTC
  };
}

export const DEFAULT_TRIANGLES: Triangle[] = [
  { quote: 'USDT', mid: 'BTC', other: 'ETH', pairs: { quoteMid: 'BTCUSDT', quoteOther: 'ETHUSDT', midOther: 'ETHBTC' } },
  { quote: 'USDT', mid: 'BTC', other: 'SOL', pairs: { quoteMid: 'BTCUSDT', quoteOther: 'SOLUSDT', midOther: 'SOLBTC' } },
  { quote: 'USDT', mid: 'ETH', other: 'SOL', pairs: { quoteMid: 'ETHUSDT', quoteOther: 'SOLUSDT', midOther: 'SOLETH' } },
  { quote: 'USDT', mid: 'BTC', other: 'XRP', pairs: { quoteMid: 'BTCUSDT', quoteOther: 'XRPUSDT', midOther: 'XRPBTC' } },
  { quote: 'USDT', mid: 'ETH', other: 'XRP', pairs: { quoteMid: 'ETHUSDT', quoteOther: 'XRPUSDT', midOther: 'XRPETH' } },
  { quote: 'USDT', mid: 'BTC', other: 'LINK', pairs: { quoteMid: 'BTCUSDT', quoteOther: 'LINKUSDT', midOther: 'LINKBTC' } },
];

export interface TriangularScannerOptions {
  executor: Executor;
  venue: Venue;
  triangles?: Triangle[];
  /** Per-leg taker fee in bps. BitGet spot is ~10 bps default. */
  feeBps?: number;
  /** Reject opportunities below this edge (in percent, e.g. 0.3 = 0.3%). */
  minEdgePct: number;
  /** Trade size in `quote` currency (USD-equivalent for USDT triangles). */
  sizeUsd: number;
  /** How long the opportunity is considered fresh, ms. */
  ttlMs?: number;
}

/**
 * Scans for triangular arb on a single venue. Single-venue is the only
 * triangular arb that is realistic at retail size — no cross-exchange
 * latency, no withdrawal fees, atomic three-leg execution.
 */
export class TriangularScanner implements Scanner {
  readonly name = 'triangular';
  private readonly executor: Executor;
  private readonly venue: Venue;
  private readonly triangles: Triangle[];
  private readonly feeBps: number;
  private readonly minEdgePct: number;
  private readonly sizeUsd: number;
  private readonly ttlMs: number;

  constructor(opts: TriangularScannerOptions) {
    this.executor = opts.executor;
    this.venue = opts.venue;
    this.triangles = opts.triangles ?? DEFAULT_TRIANGLES;
    this.feeBps = opts.feeBps ?? 10;
    this.minEdgePct = opts.minEdgePct;
    this.sizeUsd = opts.sizeUsd;
    this.ttlMs = opts.ttlMs ?? 3_000;
  }

  async scan(): Promise<Opportunity[]> {
    const symbolSet = new Set<string>();
    for (const t of this.triangles) {
      symbolSet.add(t.pairs.quoteMid);
      symbolSet.add(t.pairs.quoteOther);
      symbolSet.add(t.pairs.midOther);
    }
    const tickers = await this.executor.tickers([...symbolSet]);
    const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));

    const out: Opportunity[] = [];
    for (const tri of this.triangles) {
      const a = bySymbol.get(tri.pairs.quoteMid);
      const b = bySymbol.get(tri.pairs.quoteOther);
      const c = bySymbol.get(tri.pairs.midOther);
      if (!a || !b || !c || !validTicker(a) || !validTicker(b) || !validTicker(c)) continue;

      // Direction A: quote → mid → other → quote
      const dirA = simulateDirA(tri, a, b, c, this.sizeUsd, this.feeBps);
      if (dirA && dirA.edgePct >= this.minEdgePct) {
        out.push(this.buildOpportunity(tri, dirA, 'A'));
      }
      // Direction B: quote → other → mid → quote
      const dirB = simulateDirB(tri, a, b, c, this.sizeUsd, this.feeBps);
      if (dirB && dirB.edgePct >= this.minEdgePct) {
        out.push(this.buildOpportunity(tri, dirB, 'B'));
      }
    }
    return out;
  }

  private buildOpportunity(tri: Triangle, sim: SimResult, dir: 'A' | 'B'): Opportunity {
    const now = Date.now();
    const description =
      dir === 'A'
        ? `${tri.quote} → ${tri.mid} → ${tri.other} → ${tri.quote} on ${this.venue}`
        : `${tri.quote} → ${tri.other} → ${tri.mid} → ${tri.quote} on ${this.venue}`;
    return {
      id: newOpportunityId('tri'),
      strategy: 'triangular' as StrategyKind,
      assetClass: 'crypto' as AssetClass,
      venues: [this.venue],
      description,
      edgePct: sim.edgePct,
      estProfitUsd: sim.profitUsd,
      sizeUsd: this.sizeUsd,
      legs: sim.legs,
      reasoning: sim.reasoning,
      detectedAt: now,
      expiresAt: now + this.ttlMs,
    };
  }
}

interface SimResult {
  edgePct: number;
  profitUsd: number;
  legs: OpportunityLeg[];
  reasoning: string;
}

function simulateDirA(
  tri: Triangle,
  quoteMid: MarketTicker,
  quoteOther: MarketTicker,
  midOther: MarketTicker,
  sizeUsd: number,
  feeBps: number,
): SimResult | null {
  // 1. Buy `mid` with `quote` at quoteMid.ask
  // 2. Buy `other` with `mid` at midOther.ask
  // 3. Sell `other` for `quote` at quoteOther.bid
  if (quoteMid.ask <= 0 || midOther.ask <= 0 || quoteOther.bid <= 0) return null;
  const fee = 1 - feeBps / 10_000;
  const midQty = (sizeUsd / quoteMid.ask) * fee;
  const otherQty = (midQty / midOther.ask) * fee;
  const endQuote = otherQty * quoteOther.bid * fee;
  const profitUsd = endQuote - sizeUsd;
  const edgePct = (profitUsd / sizeUsd) * 100;
  const legs: OpportunityLeg[] = [
    { venue: 'bitget', symbol: tri.pairs.quoteMid, side: 'buy', price: quoteMid.ask, qty: midQty / fee, note: `buy ${tri.mid} with ${tri.quote}` },
    { venue: 'bitget', symbol: tri.pairs.midOther, side: 'buy', price: midOther.ask, qty: otherQty / fee, note: `buy ${tri.other} with ${tri.mid}` },
    { venue: 'bitget', symbol: tri.pairs.quoteOther, side: 'sell', price: quoteOther.bid, qty: otherQty, note: `sell ${tri.other} for ${tri.quote}` },
  ];
  const reasoning =
    `Cycle ${tri.quote}→${tri.mid}→${tri.other}→${tri.quote}. ` +
    `Implied cross ${tri.other}/${tri.quote} via ${tri.mid} = ` +
    `${(quoteMid.ask * midOther.ask).toFixed(6)} vs direct bid ${quoteOther.bid.toFixed(6)}. ` +
    `Edge ${edgePct.toFixed(2)}% after ${(feeBps * 3) / 100}% round-trip fees.`;
  return { edgePct, profitUsd, legs, reasoning };
}

function simulateDirB(
  tri: Triangle,
  quoteMid: MarketTicker,
  quoteOther: MarketTicker,
  midOther: MarketTicker,
  sizeUsd: number,
  feeBps: number,
): SimResult | null {
  // 1. Buy `other` with `quote` at quoteOther.ask
  // 2. Sell `other` for `mid` at midOther.bid (so we get `mid`)
  // 3. Sell `mid` for `quote` at quoteMid.bid
  if (quoteOther.ask <= 0 || midOther.bid <= 0 || quoteMid.bid <= 0) return null;
  const fee = 1 - feeBps / 10_000;
  const otherQty = (sizeUsd / quoteOther.ask) * fee;
  const midQty = (otherQty * midOther.bid) * fee;
  const endQuote = midQty * quoteMid.bid * fee;
  const profitUsd = endQuote - sizeUsd;
  const edgePct = (profitUsd / sizeUsd) * 100;
  const legs: OpportunityLeg[] = [
    { venue: 'bitget', symbol: tri.pairs.quoteOther, side: 'buy', price: quoteOther.ask, qty: otherQty / fee, note: `buy ${tri.other} with ${tri.quote}` },
    { venue: 'bitget', symbol: tri.pairs.midOther, side: 'sell', price: midOther.bid, qty: otherQty, note: `sell ${tri.other} for ${tri.mid}` },
    { venue: 'bitget', symbol: tri.pairs.quoteMid, side: 'sell', price: quoteMid.bid, qty: midQty, note: `sell ${tri.mid} for ${tri.quote}` },
  ];
  const reasoning =
    `Reverse cycle ${tri.quote}→${tri.other}→${tri.mid}→${tri.quote}. ` +
    `Implied cross ${tri.other}/${tri.quote} via ${tri.mid} = ` +
    `${(quoteMid.bid * midOther.bid).toFixed(6)} vs direct ask ${quoteOther.ask.toFixed(6)}. ` +
    `Edge ${edgePct.toFixed(2)}% after ${(feeBps * 3) / 100}% round-trip fees.`;
  return { edgePct, profitUsd, legs, reasoning };
}

function validTicker(t: MarketTicker): boolean {
  return t.bid > 0 && t.ask > 0 && t.ask >= t.bid;
}
