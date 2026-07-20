import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RiskLimits, TradingMode, Venue } from '@cesar-arb/shared';
import type { PredictionMatchMode } from '@cesar-arb/scanners';

// Resolve the repo root .env regardless of where the engine is started from.
// Engine cwd is apps/engine when run via `pnpm dev:engine`, but we want to
// share a single root .env across the workspace.
function findRepoEnv(): string | undefined {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(__dirname, '../../../.env'),
    resolve(__dirname, '../../.env'),
  ];
  return candidates.find((p) => existsSync(p));
}

const envPath = findRepoEnv();
if (envPath) loadDotenv({ path: envPath });

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export interface EngineConfig {
  mode: TradingMode;
  port: number;
  host: string;
  databaseUrl: string;
  startingEquityUsd: number;
  limits: RiskLimits;
  bitget: { apiKey: string; apiSecret: string; passphrase: string };
  polymarket: {
    privateKey: string;
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    /** Proxy wallet address that holds funds (order funder). */
    funderAddress: string;
  };
  kalshi: { apiKeyId: string; privateKeyPath: string };
  report: { to: string; from: string; resendKey: string };
  predictionMatchMode: PredictionMatchMode;
  /**
   * Live-execution safety gate. Two independent switches must BOTH be set
   * before a single real order can leave the engine:
   *   - mode === 'live' (the global paper/live switch), AND
   *   - the venue is listed in `liveVenues` (LIVE_VENUES env, comma-sep).
   * On top of that, `dryRun` (default ON) makes every live-enabled executor
   * build + sign the real request but stop short of sending it — so the
   * signing path can be exercised against real credentials with zero risk
   * before any money moves. Flip EXECUTION_DRY_RUN=false only after a clean
   * dry-run, and start with tiny size.
   */
  execution: { dryRun: boolean; liveVenues: Venue[] };
}

export function loadConfig(): EngineConfig {
  return {
    mode: (str('TRADING_MODE', 'paper') as TradingMode),
    // Railway / most PaaS platforms inject PORT. Honor it first, fall back to
    // ENGINE_PORT for local dev where 4000 keeps API/dashboard ports distinct.
    port: num('PORT', num('ENGINE_PORT', 4000)),
    host: str('ENGINE_HOST', '0.0.0.0'),
    databaseUrl: str('DATABASE_URL', ''),
    startingEquityUsd: num('STARTING_EQUITY_USD', 10_000),
    limits: {
      maxTradeSizeUsd: num('MAX_TRADE_SIZE_USD', 100),
      maxDailyExposureUsd: num('MAX_DAILY_EXPOSURE_USD', 500),
      maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 5),
      trailingStopPct: num('TRAILING_STOP_PCT', 5),
      minSpreadPct: num('MIN_SPREAD_PCT', 1.0),
    },
    bitget: {
      apiKey: str('BITGET_API_KEY'),
      apiSecret: str('BITGET_API_SECRET'),
      passphrase: str('BITGET_PASSPHRASE'),
    },
    polymarket: {
      privateKey: str('POLYMARKET_PRIVATE_KEY'),
      apiKey: str('POLYMARKET_API_KEY'),
      apiSecret: str('POLYMARKET_API_SECRET'),
      apiPassphrase: str('POLYMARKET_API_PASSPHRASE'),
      funderAddress: str('POLYMARKET_FUNDER_ADDRESS'),
    },
    kalshi: {
      apiKeyId: str('KALSHI_API_KEY_ID'),
      privateKeyPath: str('KALSHI_PRIVATE_KEY_PATH'),
    },
    report: {
      to: str('REPORT_EMAIL_TO'),
      from: str('REPORT_EMAIL_FROM'),
      resendKey: str('RESEND_API_KEY'),
    },
    predictionMatchMode: parseMatchMode(str('PREDICTION_MATCH_MODE', 'allowlist')),
    execution: {
      // Default ON. Must be explicitly set to the string "false" to allow a
      // real order to be transmitted — any other value keeps the dry run.
      dryRun: str('EXECUTION_DRY_RUN', 'true') !== 'false',
      liveVenues: parseVenueList(str('LIVE_VENUES', '')),
    },
  };
}

function parseMatchMode(v: string): PredictionMatchMode {
  return v === 'strict' ? 'strict' : 'allowlist';
}

const KNOWN_VENUES: ReadonlySet<string> = new Set<Venue>([
  'bitget', 'binance', 'coinbase', 'kraken', 'okx', 'bybit', 'polymarket', 'kalshi', 'paper',
]);

/** Parse LIVE_VENUES="kalshi,polymarket" → validated Venue[]. Unknown names are dropped. */
function parseVenueList(v: string): Venue[] {
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => KNOWN_VENUES.has(s)) as Venue[];
}
