import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import kleur from 'kleur';

const ENV_PATH = resolve(process.cwd(), '.env');
const ENV_EXAMPLE_PATH = resolve(process.cwd(), '.env.example');

const AFFILIATE_BITGET =
  process.env.BITGET_AFFILIATE_URL ?? 'https://partner.bitget.com/bg/<your-affiliate-tag>';

const rl = createInterface({ input: stdin, output: stdout });

async function ask(q: string, fallback?: string): Promise<string> {
  const suffix = fallback ? kleur.gray(` [${fallback}]`) : '';
  const a = (await rl.question(kleur.cyan('? ') + q + suffix + ' ')).trim();
  return a === '' && fallback ? fallback : a;
}

async function askYesNo(q: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const a = (await rl.question(kleur.cyan('? ') + q + ' ' + kleur.gray(hint) + ' ')).trim().toLowerCase();
  if (!a) return defaultYes;
  return a.startsWith('y');
}

function banner() {
  console.log();
  console.log(kleur.bold().blue('  Cesar Arb Bot — setup'));
  console.log(kleur.gray('  This walks you through the .env file. You can re-run any time.'));
  console.log();
}

interface EnvMap {
  [key: string]: string;
}

function loadExisting(): EnvMap {
  const path = existsSync(ENV_PATH) ? ENV_PATH : ENV_EXAMPLE_PATH;
  if (!existsSync(path)) return {};
  const out: EnvMap = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function writeEnv(map: EnvMap): void {
  // Preserve comments from .env.example as section headers.
  const template = existsSync(ENV_EXAMPLE_PATH) ? readFileSync(ENV_EXAMPLE_PATH, 'utf8') : '';
  const lines: string[] = [];
  for (const raw of template.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      lines.push(raw);
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) { lines.push(raw); continue; }
    const key = trimmed.slice(0, eq).trim();
    const value = map[key] ?? '';
    lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_PATH, lines.join('\n'));
}

async function main() {
  banner();
  const env = loadExisting();

  // ── 1. Trading mode ──────────────────────────────────────────────
  console.log(kleur.bold('1. Trading mode'));
  console.log(kleur.gray('   Paper-trade simulates fills against live prices. Strongly recommended for v1.'));
  const goLive = await askYesNo('   Run in LIVE trading mode? (paper recommended)', false);
  env.TRADING_MODE = goLive ? 'live' : 'paper';
  if (goLive) {
    console.log(kleur.yellow('   ⚠ Live trading is unimplemented in v1 — order placement methods will return errors.'));
    console.log(kleur.yellow('     Setting mode=live is fine, but no real orders are placed until v2.'));
  }
  console.log();

  // ── 2. Risk limits ───────────────────────────────────────────────
  console.log(kleur.bold('2. Risk limits'));
  console.log(kleur.gray('   Defaults match the spec: $100/trade, $500/day, 5% daily-loss kill, 5% trail.'));
  if (await askYesNo('   Use defaults?', true)) {
    env.MAX_TRADE_SIZE_USD = '100';
    env.MAX_DAILY_EXPOSURE_USD = '500';
    env.MAX_DAILY_LOSS_PCT = '5';
    env.TRAILING_STOP_PCT = '5';
    env.MIN_SPREAD_PCT = '1.0';
  } else {
    env.MAX_TRADE_SIZE_USD = await ask('   Max trade size (USD):', env.MAX_TRADE_SIZE_USD || '100');
    env.MAX_DAILY_EXPOSURE_USD = await ask('   Max daily exposure (USD):', env.MAX_DAILY_EXPOSURE_USD || '500');
    env.MAX_DAILY_LOSS_PCT = await ask('   Max daily loss (%):', env.MAX_DAILY_LOSS_PCT || '5');
    env.TRAILING_STOP_PCT = await ask('   Trailing stop (%):', env.TRAILING_STOP_PCT || '5');
    env.MIN_SPREAD_PCT = await ask('   Min spread threshold (%):', env.MIN_SPREAD_PCT || '1.0');
  }
  console.log();

  // ── 3. BitGet ────────────────────────────────────────────────────
  console.log(kleur.bold('3. BitGet (crypto venue)'));
  console.log(kleur.gray('   Used for triangular arb on liquid spot pairs.'));
  console.log(kleur.gray('   Affiliate signup: ') + kleur.blue().underline(AFFILIATE_BITGET));
  if (await askYesNo('   Do you already have a BitGet account?', false)) {
    console.log(kleur.gray('   Create an API key at: BitGet → API Management → Create.'));
    console.log(kleur.gray('   Permissions: enable "Spot trade" and "Read". Restrict by IP.'));
    env.BITGET_API_KEY = await ask('   API key:', env.BITGET_API_KEY);
    env.BITGET_API_SECRET = await ask('   API secret:', env.BITGET_API_SECRET);
    env.BITGET_PASSPHRASE = await ask('   API passphrase:', env.BITGET_PASSPHRASE);
  } else {
    console.log(kleur.gray('   Skipping for now. Re-run setup after you sign up.'));
  }
  console.log();

  // ── 4. Polymarket ────────────────────────────────────────────────
  console.log(kleur.bold('4. Polymarket (prediction markets)'));
  console.log(kleur.gray('   Used for one side of the prediction-pair arb (Poly ↔ Kalshi).'));
  console.log(kleur.gray('   Public market data needs no auth — these creds are only used for live trading (v2).'));
  if (await askYesNo('   Do you have a Polymarket wallet ready?', false)) {
    env.POLYMARKET_PRIVATE_KEY = await ask('   Wallet private key (0x...):', env.POLYMARKET_PRIVATE_KEY);
    env.POLYMARKET_API_KEY = await ask('   CLOB API key (optional, leave blank to derive):', env.POLYMARKET_API_KEY);
    env.POLYMARKET_API_SECRET = await ask('   CLOB API secret:', env.POLYMARKET_API_SECRET);
    env.POLYMARKET_API_PASSPHRASE = await ask('   CLOB API passphrase:', env.POLYMARKET_API_PASSPHRASE);
  }
  console.log();

  // ── 5. Kalshi ────────────────────────────────────────────────────
  console.log(kleur.bold('5. Kalshi (prediction markets)'));
  console.log(kleur.gray('   Used for the other side of prediction-pair arb. US KYC required.'));
  if (await askYesNo('   Do you have a Kalshi account ready?', false)) {
    env.KALSHI_API_KEY_ID = await ask('   API key ID:', env.KALSHI_API_KEY_ID);
    env.KALSHI_PRIVATE_KEY_PATH = await ask('   Path to private key file:', env.KALSHI_PRIVATE_KEY_PATH || './kalshi.pem');
  }
  console.log();

  // ── 6. Reporting ─────────────────────────────────────────────────
  console.log(kleur.bold('6. Daily report email (optional)'));
  if (await askYesNo('   Set up daily email reports?', false)) {
    env.REPORT_EMAIL_TO = await ask('   Send report to:', env.REPORT_EMAIL_TO);
    env.REPORT_EMAIL_FROM = await ask('   Send from:', env.REPORT_EMAIL_FROM || 'reports@cesar-arb.local');
    env.RESEND_API_KEY = await ask('   Resend API key:', env.RESEND_API_KEY);
  }
  console.log();

  // ── 7. Engine + dashboard ────────────────────────────────────────
  env.ENGINE_PORT = env.ENGINE_PORT || '4000';
  env.ENGINE_HOST = env.ENGINE_HOST || '0.0.0.0';
  env.NEXT_PUBLIC_ENGINE_URL = env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:4000';
  env.DASHBOARD_PORT = env.DASHBOARD_PORT || '3000';

  writeEnv(env);
  console.log(kleur.green('✓ Wrote ' + ENV_PATH));
  console.log();
  console.log(kleur.bold('Next steps:'));
  console.log('  1. ' + kleur.cyan('pnpm install'));
  console.log('  2. ' + kleur.cyan('pnpm dev:engine') + kleur.gray('   # in one terminal'));
  console.log('  3. ' + kleur.cyan('pnpm dev:dashboard') + kleur.gray(' # in another terminal'));
  console.log('  4. Open ' + kleur.blue().underline('http://localhost:3000'));
  console.log();
  rl.close();
}

main().catch((err) => {
  console.error(kleur.red('Setup failed: ' + (err as Error).message));
  rl.close();
  process.exit(1);
});
