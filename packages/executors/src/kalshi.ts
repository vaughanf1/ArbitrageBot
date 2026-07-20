import type { Fill, OpportunityLeg, Venue } from '@cesar-arb/shared';
import type { Executor, MarketTicker, PlaceOrderResult } from './base.js';
import { readFileSync } from 'node:fs';
import { sign as cryptoSign, constants as cryptoConstants, randomUUID } from 'node:crypto';

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
// Request path used both for the URL and for the RSA signature payload.
// Kalshi signs `timestamp + METHOD + path` where path is the domain-relative
// path with no query string.
const KALSHI_SIGN_PREFIX = '/trade-api/v2';
const KALSHI_ORDERS_PATH = `${KALSHI_SIGN_PREFIX}/portfolio/orders`;

export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle: string;
  /** YES/NO best bid/ask in dollars (0..1). */
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  /** YES probability midpoint, 0..1. */
  yesMid: number;
  closeTs: number;
  volume24h: number;
}

interface KalshiMarketRow {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  // Current API (2025+) — prices in dollars (0..1)
  yes_bid_dollars?: number;
  yes_ask_dollars?: number;
  no_bid_dollars?: number;
  no_ask_dollars?: number;
  // Legacy fields kept for compatibility
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  close_time?: string;
  volume_24h?: number;
  volume_24h_fp?: number;
  status?: string;
}

interface KalshiMarketsResponse {
  markets?: KalshiMarketRow[];
  cursor?: string;
}

/** Body for POST /portfolio/orders. buy_max_cost only applies to buys. */
interface KalshiOrderBody {
  ticker: string;
  client_order_id: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  type: 'market';
  buy_max_cost?: number;
}

/** Subset of the order object Kalshi returns from POST /portfolio/orders. */
interface KalshiOrderRow {
  order_id?: string;
  status?: string;
  taker_fill_count?: number;
  taker_fill_cost?: number; // cents
  taker_fees?: number; // cents
}

/** Coerce a possibly-undefined/string numeric field to a finite number. */
function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : fallback;
}

interface KalshiEventRow {
  event_ticker: string;
  title?: string;
  category?: string;
  markets?: KalshiMarketRow[];
}

interface KalshiEventsResponse {
  events?: KalshiEventRow[];
  cursor?: string;
}

const SKIP_CATEGORIES = new Set(['Sports']);

// High-volume Kalshi crypto series whose resolution windows commonly overlap
// Polymarket BTC/ETH product. The default /events feed never returns Crypto
// category events, so we have to enumerate these explicitly.
const CRYPTO_SERIES = [
  'KXBTCD',   // Bitcoin price daily strikes (5pm EDT settle)
  'KXBTC',    // Bitcoin price (multiple timeframes)
  'KXBTCY',   // Bitcoin yearly
  'KXBTCMAXY', // Bitcoin max for year
  'KXBTCMINY', // Bitcoin min for year
  'KXETH',    // Ethereum price
  'KXETHD',   // Ethereum daily
  'KXSOL',    // Solana price
  'KXSOLD',   // Solana daily
  'KXXRP',    // XRP price
  'KXXRPD',   // XRP daily
];

/**
 * Read-only Kalshi executor.
 *
 * Kalshi REST is straightforward — public market data is unauthenticated.
 * Live order placement uses RSA-signed requests with an API key id and a
 * downloaded private key file. v1 is paper only; live placement is wired
 * in v2 once Cesar's Kalshi account exists.
 */
export class KalshiExecutor implements Executor {
  readonly venue: Venue = 'kalshi';
  private readonly enableLive: boolean;
  private readonly dryRun: boolean;
  private readonly apiKeyId?: string;
  private readonly privateKeyPath?: string;
  /** Lazily-loaded + cached PEM contents of the RSA private key file. */
  private privateKeyPem: string | null = null;
  private marketsCache: { markets: KalshiMarket[]; cachedAt: number } | null = null;
  // Match the engine scan interval (~5s). See polymarket.ts for the
  // detailed reason — a long cache window inflates paper P&L by letting
  // the same arb re-fire every tick before the data refreshes.
  private readonly marketsCacheMs = 5_000;

  constructor(opts: {
    apiKeyId?: string;
    privateKeyPath?: string;
    enableLive?: boolean;
    /** When true (the default), live orders are signed/validated but never sent. */
    dryRun?: boolean;
  } = {}) {
    this.apiKeyId = opts.apiKeyId;
    this.privateKeyPath = opts.privateKeyPath;
    this.enableLive = opts.enableLive ?? false;
    this.dryRun = opts.dryRun ?? true;
  }

  async listActiveMarkets(maxPages = 5): Promise<KalshiMarket[]> {
    if (this.marketsCache && Date.now() - this.marketsCache.cachedAt < this.marketsCacheMs) {
      return this.marketsCache.markets;
    }
    // Use the /events endpoint with nested markets — that returns the binary
    // political/event markets that overlap Polymarket. The flat /markets feed
    // is dominated by multi-leg sports parlays we don't want.
    //
    // Kalshi's /events endpoint silently ignores the `category` query param,
    // so the default listing is dominated by Politics/Elections and never
    // surfaces Crypto events. To get crypto markets we explicitly pull a
    // few high-volume series tickers that overlap with Polymarket's BTC/ETH
    // products — those are the only pairs likely to share resolution.
    const seen = new Set<string>();
    const out: KalshiMarket[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        status: 'open',
        limit: '200',
        with_nested_markets: 'true',
      });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`${KALSHI_BASE}/events?${params.toString()}`);
      if (!res.ok) throw new Error(`kalshi events HTTP ${res.status}`);
      const json = (await res.json()) as KalshiEventsResponse;
      for (const e of json.events ?? []) {
        if (e.category && SKIP_CATEGORIES.has(e.category)) continue;
        const eventTitle = e.title ?? '';
        for (const r of e.markets ?? []) {
          if (seen.has(r.ticker)) continue;
          const parsed = parseKalshiRow(r, eventTitle);
          if (parsed) {
            seen.add(r.ticker);
            out.push(parsed);
          }
        }
      }
      if (!json.cursor) break;
      cursor = json.cursor;
    }

    // Crypto/financial top-up: Kalshi's default events feed never returns
    // Crypto category events, so explicitly fetch the major series.
    for (const seriesTicker of CRYPTO_SERIES) {
      try {
        const params = new URLSearchParams({
          status: 'open',
          limit: '100',
          with_nested_markets: 'true',
          series_ticker: seriesTicker,
        });
        const res = await fetch(`${KALSHI_BASE}/events?${params.toString()}`);
        if (!res.ok) continue;
        const json = (await res.json()) as KalshiEventsResponse;
        for (const e of json.events ?? []) {
          const eventTitle = e.title ?? '';
          for (const r of e.markets ?? []) {
            if (seen.has(r.ticker)) continue;
            const parsed = parseKalshiRow(r, eventTitle);
            if (parsed) {
              seen.add(r.ticker);
              out.push(parsed);
            }
          }
        }
      } catch {
        // best-effort enrichment; ignore series-level failures
      }
    }

    this.marketsCache = { markets: out, cachedAt: Date.now() };
    return out;
  }

  async ticker(symbol: string): Promise<MarketTicker> {
    // For Kalshi, `symbol` = "<ticker>:YES" or ":NO". Price reported in dollars 0..1.
    const [ticker, side] = symbol.split(':');
    if (!ticker || (side !== 'YES' && side !== 'NO')) {
      throw new Error(`kalshi ticker: bad symbol ${symbol}`);
    }
    const markets = await this.listActiveMarkets();
    const m = markets.find((x) => x.ticker === ticker);
    if (!m) throw new Error(`kalshi ticker: market not found ${ticker}`);
    const bid = side === 'YES' ? m.yesBid : m.noBid;
    const ask = side === 'YES' ? m.yesAsk : m.noAsk;
    return {
      symbol,
      bid,
      ask,
      last: (bid + ask) / 2,
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
      return { ok: false, error: 'kalshi: live trading disabled (paper mode)' };
    }
    if (!this.apiKeyId || !this.privateKeyPath) {
      return { ok: false, error: 'kalshi: missing API key id or private key path' };
    }

    // Leg symbol is "<ticker>:YES" | "<ticker>:NO".
    const [ticker, rawSide] = leg.symbol.split(':');
    if (!ticker || (rawSide !== 'YES' && rawSide !== 'NO')) {
      return { ok: false, error: `kalshi: bad leg symbol ${leg.symbol}` };
    }
    const side = rawSide.toLowerCase() as 'yes' | 'no';

    // Kalshi trades whole contracts. Round DOWN so we never exceed sizing.
    const count = Math.floor(leg.qty);
    if (count < 1) {
      return { ok: false, error: `kalshi: leg qty ${leg.qty} rounds to 0 contracts (min 1)` };
    }

    // Honour the leg direction: 'buy' opens the position, 'sell' unwinds it
    // (used by the engine's partial-fill safety).
    const action = leg.side === 'sell' ? 'sell' : 'buy';

    const body: KalshiOrderBody = {
      ticker,
      client_order_id: randomUUID(),
      action,
      side,
      count,
      type: 'market',
    };
    if (action === 'buy') {
      // Cap the spend so a thin book can't fill a market buy far above the
      // reference price. leg.price is dollars (0..1); Kalshi wants cents.
      body.buy_max_cost = Math.max(1, Math.ceil(leg.price * 100 * count * 1.1));
    }

    let headers: Record<string, string>;
    try {
      headers = this.signHeaders('POST', KALSHI_ORDERS_PATH);
    } catch (err) {
      return { ok: false, error: `kalshi: signing failed: ${(err as Error).message}` };
    }

    // DRY RUN: everything above (symbol parse, sizing, cost cap, signing) has
    // run for real, but we stop before transmitting. Returns a simulated fill
    // at the reference price so the rest of the pipeline can be exercised.
    if (this.dryRun) {
      return { ok: true, fill: this.simulatedFill(leg, count) };
    }

    let res: Response;
    try {
      res = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, error: `kalshi: order POST failed: ${(err as Error).message}` };
    }

    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `kalshi: order rejected HTTP ${res.status}: ${text.slice(0, 300)}` };
    }

    let parsed: { order?: KalshiOrderRow };
    try {
      parsed = JSON.parse(text) as { order?: KalshiOrderRow };
    } catch {
      return { ok: false, error: `kalshi: unparseable order response: ${text.slice(0, 300)}` };
    }
    const order = parsed.order;
    if (!order) {
      return { ok: false, error: `kalshi: no order in response: ${text.slice(0, 300)}` };
    }

    // Derive the real average fill price from taker fill fields when present.
    // taker_fill_cost is in cents, taker_fill_count in contracts.
    const filledCount = numOr(order.taker_fill_count, count);
    const costCents = numOr(order.taker_fill_cost, leg.price * 100 * count);
    const avgPrice = filledCount > 0 ? costCents / 100 / filledCount : leg.price;
    const feeUsd = numOr(order.taker_fees, 0) / 100;

    const fill: Fill = {
      venue: this.venue,
      symbol: leg.symbol,
      side: leg.side,
      qty: filledCount,
      price: avgPrice,
      feeUsd,
      filledAt: Date.now(),
    };
    return { ok: true, fill };
  }

  /** Build a simulated fill at the leg's reference price (dry-run path). */
  private simulatedFill(leg: OpportunityLeg, count: number): Fill {
    return {
      venue: this.venue,
      symbol: leg.symbol,
      side: leg.side,
      qty: count,
      price: leg.price,
      // Kalshi taker fee ≈ 0.07 * price * (1-price) * count, rounded up per contract.
      feeUsd: Math.ceil(0.07 * leg.price * (1 - leg.price) * count * 100) / 100,
      filledAt: Date.now(),
    };
  }

  /**
   * Build the Kalshi auth headers for a request. The signature payload is
   * `${timestampMs}${METHOD}${path}` signed RSA-PSS / SHA-256 (salt length =
   * digest length), base64-encoded.
   */
  private signHeaders(method: string, path: string): Record<string, string> {
    if (!this.apiKeyId) throw new Error('missing api key id');
    if (this.privateKeyPem === null) {
      if (!this.privateKeyPath) throw new Error('missing private key path');
      this.privateKeyPem = readFileSync(this.privateKeyPath, 'utf8');
    }
    const timestamp = String(Date.now());
    const signature = cryptoSign('sha256', Buffer.from(`${timestamp}${method}${path}`, 'utf8'), {
      key: this.privateKeyPem,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
    };
  }

  async getMarket(ticker: string): Promise<KalshiMarket | null> {
    const markets = await this.listActiveMarkets();
    return markets.find((m) => m.ticker === ticker) ?? null;
  }
}

function parseKalshiRow(r: KalshiMarketRow, eventTitle = ''): KalshiMarket | null {
  if (r.status && r.status !== 'open' && r.status !== 'active') return null;

  // Prefer the new dollar-denominated fields; fall back to legacy cent fields.
  // Kalshi sometimes returns these as strings, so coerce defensively.
  const num = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : undefined;
  };
  const yesBid = num(r.yes_bid_dollars) ?? (num(r.yes_bid) !== undefined ? num(r.yes_bid)! / 100 : undefined);
  const yesAsk = num(r.yes_ask_dollars) ?? (num(r.yes_ask) !== undefined ? num(r.yes_ask)! / 100 : undefined);
  const noBid = num(r.no_bid_dollars) ?? (num(r.no_bid) !== undefined ? num(r.no_bid)! / 100 : undefined);
  const noAsk = num(r.no_ask_dollars) ?? (num(r.no_ask) !== undefined ? num(r.no_ask)! / 100 : undefined);

  if (yesBid === undefined || yesAsk === undefined || noBid === undefined || noAsk === undefined) {
    return null;
  }
  // Skip markets with no real two-sided book on either side.
  const yesHasBook = yesBid > 0 && yesAsk < 1;
  const noHasBook = noBid > 0 && noAsk < 1;
  if (!yesHasBook && !noHasBook) return null;

  const yesMid = (yesBid + yesAsk) / 2;
  // Concatenate event title + market subtitle so the prediction-pair scanner
  // gets meaningful text to similarity-match against Polymarket questions.
  // Most Kalshi market titles are short labels like "Mars" or "Before 2050".
  const fullTitle = eventTitle && r.subtitle
    ? `${eventTitle} (${r.subtitle})`
    : eventTitle || r.title;
  return {
    ticker: r.ticker,
    eventTicker: r.event_ticker,
    title: fullTitle,
    subtitle: r.subtitle ?? r.yes_sub_title ?? '',
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    yesMid,
    closeTs: r.close_time ? Date.parse(r.close_time) : 0,
    volume24h: num(r.volume_24h_fp) ?? num(r.volume_24h) ?? 0,
  };
}
