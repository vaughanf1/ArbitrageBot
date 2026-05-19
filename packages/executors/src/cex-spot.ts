import type { OpportunityLeg, Venue } from '@cesar-arb/shared';
import type { Executor, MarketTicker, PlaceOrderResult } from './base.js';

/**
 * Read-only spot executors for the major centralised exchanges
 * (Binance / Coinbase / Kraken / OKX / Bybit).
 *
 * These exist to feed the cross-exchange spot scanner: the same asset
 * (e.g. BTC) priced against USD/USDT on several venues at once. All five
 * expose a free, unauthenticated ticker endpoint, so no API keys are
 * required for the data path — identical posture to the BitGet executor
 * (data source only; live placement intentionally unimplemented in v1).
 *
 * Contract note: unlike the BitGet executor (which keys on native pair
 * symbols like `BTCUSDT`), these key on the *canonical asset code*
 * (`BTC`, `ETH`, …). The per-venue symbol quirks — Kraken's `XBT`, OKX's
 * `BTC-USDT`, Coinbase's USD quote — are normalised inside each spec so
 * the scanner can compare like for like.
 */

type Quote = { bid: number; ask: number; last: number };

interface SpotVenueSpec {
  venue: Venue;
  /** Human label for the quote currency these prices are against. */
  quoteCcy: 'USDT' | 'USD';
  /** Fetch quotes for the requested canonical assets. Missing assets are omitted. */
  fetch(assets: string[]): Promise<Map<string, Quote>>;
}

function n(v: unknown): number {
  const x = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(x) ? x : NaN;
}

function mid(bid: number, ask: number, last: number): number {
  if (Number.isFinite(last) && last > 0) return last;
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  return Number.isFinite(bid) ? bid : ask;
}

const UA = { 'User-Agent': 'nathan-i-arb/1.0 (+read-only-ticker)' };

/* ── Per-venue specs ─────────────────────────────────────────────────── */

const binance: SpotVenueSpec = {
  venue: 'binance',
  quoteCcy: 'USDT',
  async fetch(assets) {
    const res = await fetch('https://api.binance.com/api/v3/ticker/bookTicker', { headers: UA });
    if (!res.ok) throw new Error(`binance HTTP ${res.status}`);
    const rows = (await res.json()) as { symbol: string; bidPrice: string; askPrice: string }[];
    const want = new Map(assets.map((a) => [`${a}USDT`, a]));
    const out = new Map<string, Quote>();
    for (const r of rows) {
      const asset = want.get(r.symbol);
      if (!asset) continue;
      const bid = n(r.bidPrice);
      const ask = n(r.askPrice);
      out.set(asset, { bid, ask, last: mid(bid, ask, NaN) });
    }
    return out;
  },
};

const bybit: SpotVenueSpec = {
  venue: 'bybit',
  quoteCcy: 'USDT',
  async fetch(assets) {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=spot', { headers: UA });
    if (!res.ok) throw new Error(`bybit HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: { list?: { symbol: string; bid1Price: string; ask1Price: string; lastPrice: string }[] };
    };
    const want = new Map(assets.map((a) => [`${a}USDT`, a]));
    const out = new Map<string, Quote>();
    for (const r of json.result?.list ?? []) {
      const asset = want.get(r.symbol);
      if (!asset) continue;
      out.set(asset, { bid: n(r.bid1Price), ask: n(r.ask1Price), last: n(r.lastPrice) });
    }
    return out;
  },
};

const okx: SpotVenueSpec = {
  venue: 'okx',
  quoteCcy: 'USDT',
  async fetch(assets) {
    const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT', { headers: UA });
    if (!res.ok) throw new Error(`okx HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: { instId: string; bidPx: string; askPx: string; last: string }[];
    };
    const want = new Map(assets.map((a) => [`${a}-USDT`, a]));
    const out = new Map<string, Quote>();
    for (const r of json.data ?? []) {
      const asset = want.get(r.instId);
      if (!asset) continue;
      out.set(asset, { bid: n(r.bidPx), ask: n(r.askPx), last: n(r.last) });
    }
    return out;
  },
};

// Kraken uses XBT for BTC and returns result keyed by its own pair name.
const KRAKEN_ALT: Record<string, string> = { BTC: 'XBT' };
const kraken: SpotVenueSpec = {
  venue: 'kraken',
  quoteCcy: 'USDT',
  async fetch(assets) {
    const pairByAsset = new Map(assets.map((a) => [a, `${KRAKEN_ALT[a] ?? a}USDT`]));
    const pairs = [...pairByAsset.values()].join(',');
    const res = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pairs)}`,
      { headers: UA },
    );
    if (!res.ok) throw new Error(`kraken HTTP ${res.status}`);
    const json = (await res.json()) as {
      error?: string[];
      result?: Record<string, { a: string[]; b: string[]; c: string[] }>;
    };
    if (json.error?.length) throw new Error(`kraken: ${json.error.join(' ')}`);
    const result = json.result ?? {};
    const out = new Map<string, Quote>();
    for (const [asset, pair] of pairByAsset) {
      // Kraken may echo the pair under a slightly different key; match by
      // the requested pair first, then by any key starting with the base.
      const row =
        result[pair] ??
        Object.entries(result).find(([k]) => k.startsWith(KRAKEN_ALT[asset] ?? asset))?.[1];
      if (!row) continue;
      out.set(asset, { bid: n(row.b?.[0]), ask: n(row.a?.[0]), last: n(row.c?.[0]) });
    }
    return out;
  },
};

// Coinbase has no cheap all-tickers endpoint; fetch the requested products
// concurrently. Quote is USD (not USDT) — a small stablecoin basis the
// scanner discloses rather than hides.
const coinbase: SpotVenueSpec = {
  venue: 'coinbase',
  quoteCcy: 'USD',
  async fetch(assets) {
    const out = new Map<string, Quote>();
    await Promise.all(
      assets.map(async (asset) => {
        try {
          const res = await fetch(
            `https://api.exchange.coinbase.com/products/${asset}-USD/ticker`,
            { headers: UA },
          );
          if (!res.ok) return;
          const r = (await res.json()) as { bid: string; ask: string; price: string };
          out.set(asset, { bid: n(r.bid), ask: n(r.ask), last: n(r.price) });
        } catch {
          /* skip this asset on Coinbase this tick */
        }
      }),
    );
    return out;
  },
};

const SPECS: Record<string, SpotVenueSpec> = { binance, bybit, okx, kraken, coinbase };

/* ── Generic executor ────────────────────────────────────────────────── */

export class CexSpotExecutor implements Executor {
  readonly venue: Venue;
  readonly quoteCcy: 'USDT' | 'USD';
  private readonly spec: SpotVenueSpec;
  private cache = new Map<string, { t: MarketTicker; at: number }>();
  private readonly cacheMs = 2_000;

  constructor(spec: SpotVenueSpec) {
    this.spec = spec;
    this.venue = spec.venue;
    this.quoteCcy = spec.quoteCcy;
  }

  async ticker(asset: string): Promise<MarketTicker> {
    const c = this.cache.get(asset);
    if (c && Date.now() - c.at < this.cacheMs) return c.t;
    const got = await this.tickers([asset]);
    const t = got.find((x) => x.symbol === asset);
    if (!t) throw new Error(`${this.venue}: no quote for ${asset}`);
    return t;
  }

  async tickers(assets: string[]): Promise<MarketTicker[]> {
    const fresh: MarketTicker[] = [];
    const stale = assets.filter((a) => {
      const c = this.cache.get(a);
      if (c && Date.now() - c.at < this.cacheMs) {
        fresh.push(c.t);
        return false;
      }
      return true;
    });
    if (stale.length === 0) return fresh;
    const quotes = await this.spec.fetch(stale);
    const now = Date.now();
    for (const [asset, q] of quotes) {
      const t: MarketTicker = {
        symbol: asset,
        bid: q.bid,
        ask: q.ask,
        last: mid(q.bid, q.ask, q.last),
        ts: now,
      };
      this.cache.set(asset, { t, at: now });
      fresh.push(t);
    }
    return fresh;
  }

  async placeMarketOrder(_leg: OpportunityLeg): Promise<PlaceOrderResult> {
    // v1: data source only. Live cross-exchange execution needs pre-funded
    // balances on both venues and is intentionally not implemented yet.
    return { ok: false, error: `${this.venue}: live order placement not implemented — paper only in v1` };
  }
}

export function makeCexSpotExecutor(venue: keyof typeof SPECS): CexSpotExecutor {
  const spec = SPECS[venue];
  if (!spec) throw new Error(`unknown cex spot venue: ${venue}`);
  return new CexSpotExecutor(spec);
}

export const CEX_SPOT_VENUES = Object.keys(SPECS) as (keyof typeof SPECS)[];
