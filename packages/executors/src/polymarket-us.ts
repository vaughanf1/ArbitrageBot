import { createPrivateKey, sign as edSign, type KeyObject } from 'node:crypto';
import type { Fill, OpportunityLeg, Venue } from '@cesar-arb/shared';
import type { Executor, MarketTicker, PlaceOrderResult } from './base.js';

const API_BASE = 'https://api.polymarket.us';
const GATEWAY_BASE = 'https://gateway.polymarket.us';

// DER prefix that wraps a raw 32-byte Ed25519 seed into a PKCS8 private key,
// which is the only form node:crypto accepts. Same no-new-deps approach as
// the Kalshi executor's RSA-PSS signing.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * One outcome market inside a Polymarket US event. Unlike the global CLOB
 * there are no YES/NO tokens: each market is a single instrument with ONE
 * matched order book — "Yes" is a long position, "No" is a short. The
 * YES+NO-under-$1 arb therefore cannot exist INSIDE a US market (ask + (1 −
 * bid) ≥ $1 by construction); it lives across the sibling markets of a
 * multi-outcome event instead. See UsEventArbScanner.
 */
export interface UsMarket {
  slug: string;
  question: string;
  marketType: string;
  active: boolean;
  closed: boolean;
  /** ISO settlement/end timestamp supplied by the US gateway, when known. */
  endDate: string | null;
}

export interface UsEvent {
  slug: string;
  title: string;
  category: string;
  /** Event-level settlement/end timestamp supplied by the US gateway. */
  endDate: string | null;
  markets: UsMarket[];
}

/** A non-zero exchange-side position (netPosition > 0 means long). */
export interface UsOpenPosition {
  marketSlug: string;
  netPosition: number;
  costUsd: number;
}

/** Best price + size at the top of a US market's single order book. */
export interface UsTopOfBook {
  bestAsk: number;
  askSize: number;
  bestBid: number;
  bidSize: number;
}

interface UsOrderExecution {
  lastShares?: string;
  lastPx?: { value?: string };
  type?: string;
  orderRejectReason?: string;
  text?: string;
  commissionNotionalCollected?: { value?: string };
}

interface UsCreateOrderResponse {
  id?: string;
  executions?: UsOrderExecution[];
  message?: string;
}

/**
 * Polymarket US (QCEX) executor — the CFTC-regulated US exchange, a fully
 * separate venue from the global crypto CLOB. Auth is Ed25519 request
 * signing with a portal-issued key id + secret (no wallets, no funder
 * address). Live placement is gated exactly like every other executor:
 * `enableLive` (TRADING_MODE=live + LIVE_VENUES) and `dryRun` (default on —
 * resolve and size the real order but stop before signing/submitting).
 */
export class PolymarketUsExecutor implements Executor {
  readonly venue: Venue = 'polymarket-us';
  private readonly enableLive: boolean;
  private readonly dryRun: boolean;
  private readonly keyId?: string;
  private signingKey: KeyObject | null = null;
  private readonly secretKey?: string;
  /** Extra allowance (bps) past the leg price so a limit-IOC order crosses. */
  private readonly slippageBps: number;
  private eventsCache: { events: UsEvent[]; cachedAt: number } | null = null;
  private balanceCache: { usd: number; cachedAt: number } | null = null;
  private readonly balanceCacheMs = 30_000;
  // Events (market listings) change slowly; books are fetched fresh each
  // scan. 60s keeps us far under the public 20 req/s limit.
  private readonly eventsCacheMs = 60_000;

  constructor(opts: {
    keyId?: string;
    /** Base64 secret from the developer portal (64-byte seed‖pubkey). */
    secretKey?: string;
    enableLive?: boolean;
    dryRun?: boolean;
    slippageBps?: number;
  } = {}) {
    this.keyId = opts.keyId;
    this.secretKey = opts.secretKey;
    this.enableLive = opts.enableLive ?? false;
    this.dryRun = opts.dryRun ?? true;
    this.slippageBps = opts.slippageBps ?? 100;
  }

  /** Lazily parse the base64 secret into a node crypto Ed25519 key. */
  private getSigningKey(): KeyObject {
    if (this.signingKey) return this.signingKey;
    if (!this.secretKey) throw new Error('missing secret key');
    const raw = Buffer.from(this.secretKey, 'base64');
    // Portal secrets are 64 bytes (seed ‖ public key); the seed is the key.
    const seed = raw.length === 64 ? raw.subarray(0, 32) : raw;
    if (seed.length !== 32) throw new Error(`bad secret key length ${raw.length}`);
    this.signingKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    return this.signingKey;
  }

  /**
   * Signed request to the authenticated API. The signature covers
   * `{timestampMs}{METHOD}{pathname}` — pathname only, no query string, no
   * body — matching the official polymarket-us SDK exactly.
   */
  private async authedFetch(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    if (!this.keyId) throw new Error('missing key id');
    const ts = Date.now().toString();
    const signature = edSign(null, Buffer.from(`${ts}${method}${path}`), this.getSigningKey()).toString(
      'base64',
    );
    return fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-PM-Access-Key': this.keyId,
        'X-PM-Timestamp': ts,
        'X-PM-Signature': signature,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * USD buying power in Cesar's US account, cached ~30s.
   *
   * This is a pre-trade gate, not just a sanity check. When the account runs
   * out of cash the exchange rejects orders with a bare HTTP 400 whose message
   * is the generic "The server was unable to process your request." — reading
   * the balance first is the only way to report the real reason.
   */
  async buyingPowerUsd(): Promise<number> {
    const cached = this.balanceCache;
    if (cached && Date.now() - cached.cachedAt < this.balanceCacheMs) return cached.usd;
    const res = await this.authedFetch('GET', '/v1/account/balances');
    if (!res.ok) throw new Error(`polymarket-us balances HTTP ${res.status}`);
    const data = (await res.json()) as { balances?: { buyingPower?: number; currency?: string }[] };
    const usd = (data.balances ?? []).find((b) => b.currency === 'USD');
    const value = usd?.buyingPower ?? 0;
    this.balanceCache = { usd: value, cachedAt: Date.now() };
    return value;
  }

  /** Drop the cached balance so the next check re-reads it (post-trade). */
  invalidateBalance(): void {
    this.balanceCache = null;
  }

  /**
   * Open (non-zero) positions as the EXCHANGE sees them. This is the ground
   * truth the ledger reconciles against — after the 2026-07-29 incident where
   * misread rejections left real fills the bot never recorded.
   */
  async openPositions(): Promise<UsOpenPosition[]> {
    const res = await this.authedFetch('GET', '/v1/portfolio/positions');
    if (!res.ok) throw new Error(`polymarket-us positions HTTP ${res.status}`);
    const data = (await res.json()) as {
      positions?: Record<string, { netPositionDecimal?: string; netPosition?: string; cost?: { value?: string } }>;
    };
    const out: UsOpenPosition[] = [];
    for (const [marketSlug, p] of Object.entries(data.positions ?? {})) {
      const net = numOr(p.netPositionDecimal ?? p.netPosition, 0);
      if (net !== 0) out.push({ marketSlug, netPosition: net, costUsd: numOr(p.cost?.value, 0) });
    }
    return out;
  }

  /** Active multi-market events from the public gateway (cached ~60s). */
  async listActiveEvents(): Promise<UsEvent[]> {
    if (this.eventsCache && Date.now() - this.eventsCache.cachedAt < this.eventsCacheMs) {
      return this.eventsCache.events;
    }
    const events: UsEvent[] = [];
    // ~1,450 active events as of 2026-07 — 20 pages covers the lot; the loop
    // still stops early on a short page, and the 60s cache keeps request
    // volume far under the public limit.
    const maxPages = 20;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        active: 'true',
        closed: 'false',
        limit: '100',
        offset: String(page * 100),
      });
      const res = await fetch(`${GATEWAY_BASE}/v1/events?${params.toString()}`);
      if (!res.ok) throw new Error(`polymarket-us events HTTP ${res.status}`);
      const data = (await res.json()) as { events?: RawEvent[] };
      const rows = data.events ?? [];
      for (const r of rows) {
        const parsed = parseEvent(r);
        if (parsed) events.push(parsed);
      }
      if (rows.length < 100) break;
    }
    this.eventsCache = { events, cachedAt: Date.now() };
    return events;
  }

  /**
   * Top-of-book for each market slug, from the full public book (the bbo
   * endpoint reports level COUNTS, not sizes, so it can't cap trade size).
   * Fetched with bounded concurrency to respect the public 20 req/s limit.
   * Slugs with an empty or one-sided book are omitted.
   */
  async topOfBooks(slugs: string[]): Promise<Map<string, UsTopOfBook>> {
    const out = new Map<string, UsTopOfBook>();
    const concurrency = 8;
    for (let i = 0; i < slugs.length; i += concurrency) {
      const batch = slugs.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (slug) => {
          try {
            const res = await fetch(`${GATEWAY_BASE}/v1/markets/${encodeURIComponent(slug)}/book`);
            if (!res.ok) return null;
            const data = (await res.json()) as {
              marketData?: {
                bids?: { px?: { value?: string }; qty?: string }[];
                offers?: { px?: { value?: string }; qty?: string }[];
              };
            };
            const md = data.marketData;
            if (!md) return null;
            // Don't assume sort order — take the true best level.
            let bestAsk = Infinity;
            let askSize = 0;
            for (const o of md.offers ?? []) {
              const p = numOr(o.px?.value, NaN);
              if (!isFinite(p) || p <= 0) continue;
              if (p < bestAsk) {
                bestAsk = p;
                askSize = numOr(o.qty, 0);
              }
            }
            let bestBid = 0;
            let bidSize = 0;
            for (const b of md.bids ?? []) {
              const p = numOr(b.px?.value, NaN);
              if (!isFinite(p) || p <= 0) continue;
              if (p > bestBid) {
                bestBid = p;
                bidSize = numOr(b.qty, 0);
              }
            }
            if (!isFinite(bestAsk) || bestAsk === Infinity) return null;
            return { slug, book: { bestAsk, askSize, bestBid, bidSize } };
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) {
        if (r) out.set(r.slug, r.book);
      }
    }
    return out;
  }

  async ticker(symbol: string): Promise<MarketTicker> {
    // Symbol is "<marketSlug>:LONG" (only long positions are traded/held).
    const slug = symbol.split(':')[0];
    if (!slug) throw new Error(`polymarket-us ticker: bad symbol ${symbol}`);
    const books = await this.topOfBooks([slug]);
    const b = books.get(slug);
    if (!b) throw new Error(`polymarket-us ticker: no book for ${slug}`);
    const last = b.bestBid > 0 ? (b.bestAsk + b.bestBid) / 2 : b.bestAsk;
    return { symbol, bid: b.bestBid, ask: b.bestAsk, last, ts: Date.now() };
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
      return { ok: false, error: 'polymarket-us: live trading disabled (paper mode)' };
    }
    if (!this.keyId || !this.secretKey) {
      return { ok: false, error: 'polymarket-us: missing API credentials' };
    }
    const slug = leg.symbol.split(':')[0];
    if (!slug) {
      return { ok: false, error: `polymarket-us: bad leg symbol ${leg.symbol}` };
    }

    // Contracts are whole units on the regulated exchange; never round UP
    // into a bigger position than the opportunity sized.
    const qty = Math.floor(leg.qty);
    if (qty <= 0) {
      return { ok: false, error: `polymarket-us: leg qty ${leg.qty} rounds to 0 contracts` };
    }
    // Marketable limit: cross the book but cap what we'll pay (buy) or
    // accept (sell). IOC so nothing rests — the arb wants an immediate fill.
    const isSell = leg.side === 'sell';
    const slip = this.slippageBps / 10_000;
    const limitPrice = isSell
      ? Math.max(0.001, leg.price * (1 - slip))
      : Math.min(0.999, leg.price * (1 + slip));

    // DRY RUN: everything above ran for real; stop before signing/submitting.
    if (this.dryRun) {
      return {
        ok: true,
        fill: {
          venue: this.venue,
          symbol: leg.symbol,
          side: leg.side,
          qty,
          price: leg.price,
          feeUsd: 0,
          filledAt: Date.now(),
        },
      };
    }

    try {
      const res = await this.authedFetch('POST', '/v1/orders', {
        marketSlug: slug,
        // Entries buy long; unwinds sell the long back. We never go short.
        intent: isSell ? 'ORDER_INTENT_SELL_LONG' : 'ORDER_INTENT_BUY_LONG',
        type: 'ORDER_TYPE_LIMIT',
        price: { value: limitPrice.toFixed(3), currency: 'USD' },
        quantity: qty,
        tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
        // Block until the matching engine reports executions so the response
        // tells us the actual fill instead of requiring a follow-up poll.
        synchronousExecution: true,
      });
      const bodyText = await res.text();
      const data = (JSON.parse(bodyText || '{}') as UsCreateOrderResponse) ?? {};
      if (!res.ok) {
        // QCEX returns a bare "The server was unable to process your request."
        // for most order faults, including an account with no cash. Carry the
        // status code and the raw body through so the ledger records something
        // a human can act on, and name the balance case explicitly — it is by
        // far the most common cause and the only one the bot can pre-empt.
        let hint = '';
        try {
          const bp = await this.buyingPowerUsd();
          const cost = qty * limitPrice;
          if (bp < cost) hint = ` — insufficient buying power: $${bp.toFixed(2)} available, order needs $${cost.toFixed(2)}`;
        } catch {
          /* balance lookup is best-effort; never mask the original error */
        }
        return {
          ok: false,
          error: `polymarket-us: order HTTP ${res.status}: ${bodyText.slice(0, 200)}${hint}`,
        };
      }
      // Every execution carries `orderRejectReason` even on success — it is a
      // protobuf enum whose zero value serializes as
      // ORD_REJECT_REASON_EXCHANGE_OPTION, so its mere presence means nothing.
      // Only an execution of type REJECTED is an actual rejection; the real
      // reason (price band, buying power, …) arrives in its `text` field.
      const rejected = (data.executions ?? []).find((e) => e.type === 'EXECUTION_TYPE_REJECTED');
      if (rejected) {
        const detail = rejected.text || rejected.orderRejectReason || 'no reason given';
        return { ok: false, error: `polymarket-us: order rejected: ${detail}` };
      }
      // Aggregate fills across executions; IOC may fill partially or not at all.
      let filled = 0;
      let spent = 0;
      let feeUsd = 0;
      for (const e of data.executions ?? []) {
        const shares = numOr(e.lastShares, 0);
        const px = numOr(e.lastPx?.value, NaN);
        if (shares > 0 && isFinite(px)) {
          filled += shares;
          spent += shares * px;
        }
        feeUsd += numOr(e.commissionNotionalCollected?.value, 0);
      }
      if (filled <= 0) {
        return { ok: false, error: 'polymarket-us: IOC order did not fill (book moved)' };
      }
      const fill: Fill = {
        venue: this.venue,
        symbol: leg.symbol,
        side: leg.side,
        qty: filled,
        price: spent / filled,
        feeUsd,
        filledAt: Date.now(),
      };
      return { ok: true, fill };
    } catch (err) {
      return { ok: false, error: `polymarket-us: order failed: ${(err as Error).message}` };
    }
  }
}

interface RawEvent {
  slug?: string;
  title?: string;
  category?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  markets?: {
    slug?: string;
    question?: string;
    marketType?: string;
    active?: boolean;
    closed?: boolean;
    endDate?: string;
  }[];
}

function parseEvent(r: RawEvent): UsEvent | null {
  if (!r.slug || r.closed || r.active === false) return null;
  const markets: UsMarket[] = [];
  for (const m of r.markets ?? []) {
    if (!m.slug || m.closed || m.active === false) continue;
    markets.push({
      slug: m.slug,
      question: m.question ?? m.slug,
      marketType: m.marketType ?? '',
      active: m.active ?? true,
      closed: m.closed ?? false,
      endDate: normalizeGatewayIsoDate(m.endDate),
    });
  }
  if (markets.length === 0) return null;
  return {
    slug: r.slug,
    title: r.title ?? r.slug,
    category: r.category ?? '',
    endDate: normalizeGatewayIsoDate(r.endDate),
    markets,
  };
}

export function normalizeGatewayIsoDate(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.padEnd(3, '0'));
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) return null;
  if (!zone) return null;
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if ((zoneHour ?? 24) > 23 || (zoneMinute ?? 60) > 59) return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : fallback;
}
