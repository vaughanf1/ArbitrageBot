import type { OpportunityLeg, Venue } from '@cesar-arb/shared';
import type { Executor, MarketTicker, PlaceOrderResult } from './base.js';

const BITGET_BASE = 'https://api.bitget.com';

interface BitgetTickerRow {
  symbol: string;
  bidPr: string;
  askPr: string;
  lastPr: string;
  ts: string;
}

interface BitgetTickersResponse {
  code: string;
  msg?: string;
  data?: BitgetTickerRow[];
}

/**
 * Read-only BitGet executor.
 *
 * For v1 we use this only as a *data source* — the engine never places real
 * BitGet orders directly. Instead the PaperExecutor wraps this for simulated
 * fills against live BitGet prices. Real order placement is wired up but
 * gated by `enableLive` (off by default) so paper-trade is always the
 * default until Cesar explicitly flips the switch.
 */
export class BitgetExecutor implements Executor {
  readonly venue: Venue = 'bitget';
  private readonly enableLive: boolean;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly passphrase?: string;
  private cache = new Map<string, { ticker: MarketTicker; cachedAt: number }>();
  private readonly cacheMs = 1_000;

  constructor(opts: {
    apiKey?: string;
    apiSecret?: string;
    passphrase?: string;
    enableLive?: boolean;
  } = {}) {
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.passphrase = opts.passphrase;
    this.enableLive = opts.enableLive ?? false;
  }

  async ticker(symbol: string): Promise<MarketTicker> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.cachedAt < this.cacheMs) return cached.ticker;
    const url = `${BITGET_BASE}/api/v2/spot/market/tickers?symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bitget ticker ${symbol} HTTP ${res.status}`);
    const json = (await res.json()) as BitgetTickersResponse;
    if (json.code !== '00000' || !json.data?.[0]) {
      throw new Error(`bitget ticker ${symbol} error: ${json.msg ?? 'unknown'}`);
    }
    const t = parseBitgetTicker(json.data[0]);
    this.cache.set(symbol, { ticker: t, cachedAt: Date.now() });
    return t;
  }

  async tickers(symbols: string[]): Promise<MarketTicker[]> {
    // Single batched call: BitGet returns all tickers if `symbol` is omitted.
    const res = await fetch(`${BITGET_BASE}/api/v2/spot/market/tickers`);
    if (!res.ok) throw new Error(`bitget tickers HTTP ${res.status}`);
    const json = (await res.json()) as BitgetTickersResponse;
    if (json.code !== '00000' || !json.data) {
      throw new Error(`bitget tickers error: ${json.msg ?? 'unknown'}`);
    }
    const wanted = new Set(symbols);
    const now = Date.now();
    const out: MarketTicker[] = [];
    for (const row of json.data) {
      if (!wanted.has(row.symbol)) continue;
      const t = parseBitgetTicker(row);
      this.cache.set(row.symbol, { ticker: t, cachedAt: now });
      out.push(t);
    }
    return out;
  }

  async placeMarketOrder(leg: OpportunityLeg): Promise<PlaceOrderResult> {
    if (!this.enableLive) {
      return { ok: false, error: 'bitget: live trading disabled (paper mode)' };
    }
    if (!this.apiKey || !this.apiSecret || !this.passphrase) {
      return { ok: false, error: 'bitget: missing API credentials' };
    }
    // Live order placement is intentionally unimplemented in v1. When Cesar is
    // ready to flip to live we will wire up signed POSTs to
    // /api/v2/spot/trade/place-order with HMAC auth.
    return { ok: false, error: 'bitget: live order placement not yet implemented — paper only in v1' };
  }
}

function parseBitgetTicker(row: BitgetTickerRow): MarketTicker {
  const bid = parseFloat(row.bidPr);
  const ask = parseFloat(row.askPr);
  const last = parseFloat(row.lastPr);
  return {
    symbol: row.symbol,
    bid: isFinite(bid) ? bid : last,
    ask: isFinite(ask) ? ask : last,
    last,
    ts: parseInt(row.ts, 10) || Date.now(),
  };
}
