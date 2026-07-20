import type { Fill, OpportunityLeg, Venue } from '@cesar-arb/shared';
import type { Executor, MarketTicker, PlaceOrderResult } from './base.js';
import { Wallet } from 'ethers';
import { ClobClient, Side, OrderType, type ApiKeyCreds } from '@polymarket/clob-client';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
// Magic/email proxy wallets sign with signatureType 2 (Gnosis-safe style),
// funder = the proxy contract address. Verified against Cesar's account: the
// exported key derives L2 creds and signs orders cleanly under this config.
const DEFAULT_SIGNATURE_TYPE = 2;

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
  /** Negative-risk (multi-outcome) market — required for correct order signing. */
  negRisk: boolean;
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
  negRisk?: boolean;
}

/**
 * Polymarket executor — live order placement via the CLOB.
 *
 * Reads market data from the public Gamma API and places orders through the
 * authenticated CLOB using the official client: an EIP-712 order signed by the
 * wallet key, submitted as the proxy funder (signatureType 2). Live placement
 * is gated by `enableLive`; `dryRun` (default on) signs without submitting.
 */
export class PolymarketExecutor implements Executor {
  readonly venue: Venue = 'polymarket';
  private readonly enableLive: boolean;
  private readonly dryRun: boolean;
  private readonly privateKey?: string;
  /** Proxy wallet address that custodies funds (the order funder). */
  private readonly funderAddress?: string;
  private readonly signatureType: number;
  /** Optional pre-issued L2 creds; if absent we derive them from the key. */
  private readonly presetCreds?: ApiKeyCreds;
  /** Lazily-built, authenticated CLOB client (caches derived creds). */
  private clobClient: ClobClient | null = null;
  /** Lazily-built UNAUTHENTICATED client for public reads (order books). */
  private bookClient: ClobClient | null = null;
  /** Extra slippage allowance (bps) added to the leg price for a marketable order. */
  private readonly slippageBps: number;
  private marketsCache: { markets: PolymarketMarket[]; cachedAt: number } | null = null;
  // Match the engine scan interval (~5s). A longer cache means the bot
  // trades on stale prices and can re-fire the "same" arb every tick for
  // the duration of the cache window — turning one real opportunity into
  // a stream of inflated paper trades.
  private readonly marketsCacheMs = 5_000;

  constructor(opts: {
    privateKey?: string;
    enableLive?: boolean;
    /** When true (default), orders are built + signed but NOT submitted. */
    dryRun?: boolean;
    /** Proxy wallet address holding funds (POLY funder). Required for live. */
    funderAddress?: string;
    signatureType?: number;
    apiKey?: string;
    apiSecret?: string;
    apiPassphrase?: string;
    slippageBps?: number;
  } = {}) {
    this.privateKey = opts.privateKey;
    this.enableLive = opts.enableLive ?? false;
    this.dryRun = opts.dryRun ?? true;
    this.funderAddress = opts.funderAddress;
    this.signatureType = opts.signatureType ?? DEFAULT_SIGNATURE_TYPE;
    this.slippageBps = opts.slippageBps ?? 100; // 1% default for thin books
    if (opts.apiKey && opts.apiSecret && opts.apiPassphrase) {
      this.presetCreds = { key: opts.apiKey, secret: opts.apiSecret, passphrase: opts.apiPassphrase };
    }
  }

  /**
   * Build (and cache) an authenticated CLOB client. Uses preset L2 creds when
   * provided, otherwise derives them deterministically from the wallet key.
   */
  private async getClobClient(): Promise<ClobClient> {
    if (this.clobClient) return this.clobClient;
    if (!this.privateKey) throw new Error('missing wallet private key');
    if (!this.funderAddress) throw new Error('missing funder (proxy) address');
    const wallet = new Wallet(this.privateKey);
    const creds =
      this.presetCreds ?? (await new ClobClient(CLOB_BASE, POLYGON_CHAIN_ID, wallet).createOrDeriveApiKey());
    this.clobClient = new ClobClient(
      CLOB_BASE,
      POLYGON_CHAIN_ID,
      wallet,
      creds,
      this.signatureType,
      this.funderAddress,
    );
    return this.clobClient;
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

  /**
   * Best bid/ask per CLOB token from the live order book. Public read — no
   * wallet or API creds needed, so this works in paper mode too. Unlike
   * `ticker()` (which synthesises a spread around the Gamma mid), these are
   * the REAL prices you could fill against right now — which is what an
   * intra-market YES+NO arb needs: the Gamma mids always sum to ~$1, so only
   * the actual book reveals when YES_ask + NO_ask dips below $1.
   *
   * Returns a map keyed by token id. Tokens with an empty/one-sided book are
   * omitted. `askSize`/`bidSize` are the depth at the best level, in
   * contracts — the scanner uses these to cap trade size to what's fillable.
   */
  async orderBooks(
    tokenIds: string[],
  ): Promise<Map<string, { bestAsk: number; askSize: number; bestBid: number; bidSize: number }>> {
    const out = new Map<string, { bestAsk: number; askSize: number; bestBid: number; bidSize: number }>();
    if (tokenIds.length === 0) return out;
    if (!this.bookClient) this.bookClient = new ClobClient(CLOB_BASE, POLYGON_CHAIN_ID);
    const params = tokenIds.map((token_id) => ({ token_id, side: Side.BUY }));
    const books = await this.bookClient.getOrderBooks(params);
    for (const b of books) {
      if (!b || !b.asset_id) continue;
      // Don't assume the API's sort order — take the true best level.
      let bestAsk = Infinity;
      let askSize = 0;
      for (const a of b.asks ?? []) {
        const p = numOr(a.price, NaN);
        if (!isFinite(p) || p <= 0) continue;
        if (p < bestAsk) {
          bestAsk = p;
          askSize = numOr(a.size, 0);
        }
      }
      let bestBid = 0;
      let bidSize = 0;
      for (const bd of b.bids ?? []) {
        const p = numOr(bd.price, NaN);
        if (!isFinite(p) || p <= 0) continue;
        if (p > bestBid) {
          bestBid = p;
          bidSize = numOr(bd.size, 0);
        }
      }
      if (!isFinite(bestAsk) || bestAsk === Infinity) continue;
      out.set(b.asset_id, { bestAsk, askSize, bestBid, bidSize });
    }
    return out;
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

  async placeMarketOrder(leg: OpportunityLeg): Promise<PlaceOrderResult> {
    if (!this.enableLive) {
      return { ok: false, error: 'polymarket: live trading disabled (paper mode)' };
    }
    if (!this.privateKey) {
      return { ok: false, error: 'polymarket: missing wallet private key' };
    }
    if (!this.funderAddress) {
      return { ok: false, error: 'polymarket: missing funder (proxy) address' };
    }

    // Leg symbol is "<conditionId>:YES" | "<conditionId>:NO". Resolve to the
    // CLOB token id we actually trade.
    const [conditionId, rawSide] = leg.symbol.split(':');
    if (!conditionId || (rawSide !== 'YES' && rawSide !== 'NO')) {
      return { ok: false, error: `polymarket: bad leg symbol ${leg.symbol}` };
    }
    const markets = await this.listActiveMarkets();
    const market = markets.find((m) => m.conditionId === conditionId);
    if (!market) {
      return { ok: false, error: `polymarket: market not found ${conditionId}` };
    }
    const tokenId = rawSide === 'YES' ? market.yesTokenId : market.noTokenId;

    // Marketable order: for a BUY, cap the price above the reference ask so it
    // crosses the book but never pays >$0.99; for a SELL (unwind), set a floor
    // below the bid so it crosses down but never dumps below $0.01.
    const isSell = leg.side === 'sell';
    const slip = this.slippageBps / 10_000;
    const limitPrice = isSell
      ? Math.max(0.01, leg.price * (1 - slip))
      : Math.min(0.99, leg.price * (1 + slip));
    const size = Math.floor(leg.qty * 100) / 100; // Polymarket size precision
    if (size <= 0) {
      return { ok: false, error: `polymarket: leg qty ${leg.qty} too small` };
    }

    // DRY RUN: resolve token, price cap and size for real, but stop before
    // signing/submitting. Returns a simulated fill at the reference price.
    if (this.dryRun) {
      return { ok: true, fill: this.simulatedFill(leg, size) };
    }

    let client: ClobClient;
    try {
      client = await this.getClobClient();
    } catch (err) {
      return { ok: false, error: `polymarket: auth failed: ${(err as Error).message}` };
    }

    try {
      const tickSize = await client.getTickSize(tokenId);
      const order = await client.createOrder(
        { tokenID: tokenId, price: limitPrice, size, side: isSell ? Side.SELL : Side.BUY },
        { tickSize, negRisk: market.negRisk },
      );
      // FAK (fill-and-kill) = take whatever liquidity is available now at/under
      // the cap, cancel the rest. The arbitrage wants an immediate fill, not a
      // resting order.
      const resp = (await client.postOrder(order, OrderType.FAK)) as PolyOrderResponse;
      if (resp && resp.success === false) {
        return { ok: false, error: `polymarket: order rejected: ${resp.errorMsg ?? 'unknown'}` };
      }
      // Derive the executed price/qty from the response when available; fall
      // back to the cap/size used. Real reconciliation happens via fills later.
      const filledSize = numOr(resp?.takingAmount, size);
      const spent = numOr(resp?.makingAmount, limitPrice * size);
      const avgPrice = filledSize > 0 ? spent / filledSize : limitPrice;
      const fill: Fill = {
        venue: this.venue,
        symbol: leg.symbol,
        side: leg.side,
        qty: filledSize,
        price: avgPrice,
        feeUsd: 0, // Polymarket charges no taker fee on the global CLOB.
        filledAt: Date.now(),
      };
      return { ok: true, fill };
    } catch (err) {
      return { ok: false, error: `polymarket: order failed: ${(err as Error).message}` };
    }
  }

  /** Simulated fill at the leg's reference price (dry-run path). */
  private simulatedFill(leg: OpportunityLeg, size: number): Fill {
    return {
      venue: this.venue,
      symbol: leg.symbol,
      side: leg.side,
      qty: size,
      price: leg.price,
      feeUsd: 0,
      filledAt: Date.now(),
    };
  }

  // Helper for the prediction scanner to look up a single market by slug.
  async getMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
    const markets = await this.listActiveMarkets();
    return markets.find((m) => m.slug === slug) ?? null;
  }

  /**
   * Fetch specific markets by slug directly. Used to guarantee allowlist
   * pairs are always scannable regardless of where they sit in the
   * volume-ranked listActiveMarkets() output — the curated set is small
   * but only a subset of pairs trade enough 24h volume to appear in the
   * top 500. Bypasses the cache: callers can merge into the cached set.
   */
  async getMarketsBySlugs(slugs: string[]): Promise<PolymarketMarket[]> {
    if (slugs.length === 0) return [];
    const params = new URLSearchParams();
    for (const s of slugs) params.append('slug', s);
    const res = await fetch(`${GAMMA_BASE}/markets?${params.toString()}`);
    if (!res.ok) return [];
    const rows = (await res.json()) as GammaMarketRow[];
    const out: PolymarketMarket[] = [];
    for (const r of rows) {
      const parsed = parseGammaRow(r);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  // Expose CLOB base for clients that may want it later.
  static readonly clobBase = CLOB_BASE;
}

/** Subset of the CLOB postOrder response we read for fill reconciliation. */
interface PolyOrderResponse {
  success?: boolean;
  errorMsg?: string;
  orderID?: string;
  /** Size taken (filled), in contracts. */
  takingAmount?: number | string;
  /** USDC spent on the take. */
  makingAmount?: number | string;
  status?: string;
}

/** Coerce a possibly-undefined/string numeric field to a finite number. */
function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : fallback;
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
    negRisk: Boolean(r.negRisk),
  };
}
