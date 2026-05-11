import type { OpportunityLeg, Venue } from '@cesar-arb/shared';
import type { Executor, MarketTicker, PlaceOrderResult } from './base.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

export interface PolymarketMarket {
  /** Polymarket condition id. */
  conditionId: string;
  /** Slug from the frontend, useful for matching to Kalshi. */
  slug: string;
  question: string;
  description: string;
  /** YES token CLOB id. */
  yesTokenId: string;
  /** NO token CLOB id. */
  noTokenId: string;
  yesPrice: number; // 0..1
  noPrice: number; // 0..1
  endDate: string;
  volume24h: number;
}

interface GammaMarketRow {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  description: string;
  outcomes: string; // JSON-encoded ["Yes","No"]
  outcomePrices: string; // JSON-encoded ["0.62","0.38"]
  clobTokenIds: string; // JSON-encoded ["123","456"]
  endDate: string;
  volume24hr?: number;
  closed: boolean;
  active: boolean;
}

/**
 * Read-only Polymarket executor.
 *
 * Polymarket order placement requires an EIP-712 signed message and a
 * proxy wallet — not trivial to build until Cesar's account exists. v1
 * uses this purely as a market-data source for the prediction-pair
 * scanner; paper-trades fill against the live YES/NO prices.
 */
export class PolymarketExecutor implements Executor {
  readonly venue: Venue = 'polymarket';
  private readonly enableLive: boolean;
  private readonly privateKey?: string;
  private marketsCache: { markets: PolymarketMarket[]; cachedAt: number } | null = null;
  // Match the engine scan interval (~5s). A longer cache means the bot
  // trades on stale prices and can re-fire the "same" arb every tick for
  // the duration of the cache window — turning one real opportunity into
  // a stream of inflated paper trades.
  private readonly marketsCacheMs = 5_000;

  constructor(opts: { privateKey?: string; enableLive?: boolean } = {}) {
    this.privateKey = opts.privateKey;
    this.enableLive = opts.enableLive ?? false;
  }

  async listActiveMarkets(): Promise<PolymarketMarket[]> {
    if (this.marketsCache && Date.now() - this.marketsCache.cachedAt < this.marketsCacheMs) {
      return this.marketsCache.markets;
    }
    // Paginate across multiple pages of active markets ordered by 24h volume.
    // The top 100 alone misses curated allowlist pairs (e.g. 2028 nominee
    // markets sit well below the BTC/election headline volume), so the
    // scanner can't match them. 5 pages * 100 = 500 markets gives enough
    // coverage for the allowlist while keeping the request cost reasonable.
    const markets: PolymarketMarket[] = [];
    const maxPages = 5;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        closed: 'false',
        active: 'true',
        limit: '100',
        offset: String(page * 100),
        order: 'volume24hr',
        ascending: 'false',
      });
      const res = await fetch(`${GAMMA_BASE}/markets?${params.toString()}`);
      if (!res.ok) throw new Error(`polymarket gamma HTTP ${res.status}`);
      const rows = (await res.json()) as GammaMarketRow[];
      if (rows.length === 0) break;
      for (const r of rows) {
        const parsed = parseGammaRow(r);
        if (parsed) markets.push(parsed);
      }
      if (rows.length < 100) break;
    }
    this.marketsCache = { markets, cachedAt: Date.now() };
    return markets;
  }

  async ticker(symbol: string): Promise<MarketTicker> {
    // For Polymarket, `symbol` = "<conditionId>:YES" or ":NO".
    const [conditionId, side] = symbol.split(':');
    if (!conditionId || (side !== 'YES' && side !== 'NO')) {
      throw new Error(`polymarket ticker: bad symbol ${symbol}`);
    }
    const markets = await this.listActiveMarkets();
    const m = markets.find((x) => x.conditionId === conditionId);
    if (!m) throw new Error(`polymarket ticker: market not found ${conditionId}`);
    const px = side === 'YES' ? m.yesPrice : m.noPrice;
    // Polymarket book is thin; use a tight synthetic spread for paper fills.
    const half = 0.005;
    return {
      symbol,
      bid: Math.max(0.01, px - half),
      ask: Math.min(0.99, px + half),
      last: px,
      ts: Date.now(),
    };
  }

  async tickers(symbols: string[]): Promise<MarketTicker[]> {
    const out: MarketTicker[] = [];
    for (const s of symbols) {
      try {
        out.push(await this.ticker(s));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  async placeMarketOrder(_leg: OpportunityLeg): Promise<PlaceOrderResult> {
    if (!this.enableLive) {
      return { ok: false, error: 'polymarket: live trading disabled (paper mode)' };
    }
    if (!this.privateKey) {
      return { ok: false, error: 'polymarket: missing wallet private key' };
    }
    // Live placement requires EIP-712 signing against CLOB. v2 work.
    return { ok: false, error: 'polymarket: live order placement not yet implemented — paper only in v1' };
  }

  // Helper for the prediction scanner to look up a single market by slug.
  async getMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
    const markets = await this.listActiveMarkets();
    return markets.find((m) => m.slug === slug) ?? null;
  }

  // Expose CLOB base for clients that may want it later.
  static readonly clobBase = CLOB_BASE;
}

function parseGammaRow(r: GammaMarketRow): PolymarketMarket | null {
  if (r.closed || !r.active) return null;
  let outcomes: string[];
  let prices: string[];
  let tokenIds: string[];
  try {
    outcomes = JSON.parse(r.outcomes);
    prices = JSON.parse(r.outcomePrices);
    tokenIds = JSON.parse(r.clobTokenIds);
  } catch {
    return null;
  }
  if (outcomes.length < 2 || prices.length < 2 || tokenIds.length < 2) return null;
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(o));
  const noIdx = outcomes.findIndex((o) => /^no$/i.test(o));
  if (yesIdx === -1 || noIdx === -1) return null;
  const yesPrice = parseFloat(prices[yesIdx]!);
  const noPrice = parseFloat(prices[noIdx]!);
  const yesTokenId = tokenIds[yesIdx]!;
  const noTokenId = tokenIds[noIdx]!;
  if (!isFinite(yesPrice) || !isFinite(noPrice)) return null;
  const vol24 = typeof r.volume24hr === 'number' ? r.volume24hr : Number(r.volume24hr);
  return {
    conditionId: r.conditionId,
    slug: r.slug,
    question: r.question,
    description: r.description ?? '',
    yesTokenId,
    noTokenId,
    yesPrice,
    noPrice,
    endDate: r.endDate,
    volume24h: isFinite(vol24) ? vol24 : 0,
  };
}
