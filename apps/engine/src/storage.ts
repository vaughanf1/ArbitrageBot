import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Opportunity, Trade } from '@cesar-arb/shared';

/**
 * Append-only persistence for trades and opportunities.
 * Single SQLite file — works locally and on Railway with a mounted volume.
 *
 * Set SQLITE_PATH=/data/cesar-arb.db on Railway after attaching a volume.
 */
export class Storage {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        strategy TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        edge_pct REAL NOT NULL,
        size_usd REAL NOT NULL,
        est_profit_usd REAL NOT NULL,
        description TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        venues TEXT NOT NULL,
        legs_json TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        tradable INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_opp_detected ON opportunities(detected_at DESC);

      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        notional_usd REAL NOT NULL,
        pnl_usd REAL,
        reasoning TEXT NOT NULL,
        fills_json TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

      CREATE TABLE IF NOT EXISTS daily_state (
        date TEXT PRIMARY KEY,
        starting_equity_usd REAL NOT NULL,
        exposure_usd REAL NOT NULL,
        realized_pnl_usd REAL NOT NULL,
        kill_switch INTEGER NOT NULL
      );
    `);
    // Backwards-compat: add columns to legacy DBs.
    // Each ALTER must run BEFORE any index/query that references the new column.
    const cols = this.db.prepare(`PRAGMA table_info(opportunities)`).all() as Array<{ name: string }>;
    const has = (name: string) => cols.some((c) => c.name === name);
    if (!has('tradable')) {
      this.db.exec(`ALTER TABLE opportunities ADD COLUMN tradable INTEGER NOT NULL DEFAULT 1`);
    }
    if (!has('source')) {
      this.db.exec(`ALTER TABLE opportunities ADD COLUMN source TEXT NOT NULL DEFAULT 'confirmed'`);
    }
    if (!has('requires_review')) {
      this.db.exec(`ALTER TABLE opportunities ADD COLUMN requires_review INTEGER NOT NULL DEFAULT 0`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_opp_tradable_detected ON opportunities(tradable, detected_at DESC)`);
  }

  recordOpportunity(o: Opportunity, tradable: boolean = true): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO opportunities
         (id, strategy, asset_class, edge_pct, size_usd, est_profit_usd, description, reasoning, venues, legs_json, detected_at, expires_at, tradable, source, requires_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id,
        o.strategy,
        o.assetClass,
        o.edgePct,
        o.sizeUsd,
        o.estProfitUsd,
        o.description,
        o.reasoning,
        JSON.stringify(o.venues),
        JSON.stringify(o.legs),
        o.detectedAt,
        o.expiresAt,
        tradable ? 1 : 0,
        o.source,
        o.requiresReview ? 1 : 0,
      );
  }

  /** Wipe trades + daily state. Used after the un-deduped run inflated the demo numbers. */
  resetTradeHistory(): void {
    this.db.exec(`DELETE FROM trades; DELETE FROM daily_state;`);
  }

  recentOpportunities(limit = 50): Opportunity[] {
    const rows = this.db
      .prepare(`SELECT * FROM opportunities WHERE tradable = 1 ORDER BY detected_at DESC LIMIT ?`)
      .all(limit) as OpportunityRow[];
    return rows.map(rowToOpportunity);
  }

  recentCandidates(limit = 100): Opportunity[] {
    const rows = this.db
      .prepare(`SELECT * FROM opportunities ORDER BY detected_at DESC LIMIT ?`)
      .all(limit) as OpportunityRow[];
    return rows.map(rowToOpportunity);
  }

  recordTrade(t: Trade): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO trades
         (id, opportunity_id, strategy, asset_class, mode, status, notional_usd, pnl_usd, reasoning, fills_json, opened_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.opportunityId,
        t.strategy,
        t.assetClass,
        t.mode,
        t.status,
        t.notionalUsd,
        t.pnlUsd,
        t.reasoning,
        JSON.stringify(t.fills),
        t.openedAt,
        t.closedAt,
      );
  }

  recentTrades(limit = 100): Trade[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?`)
      .all(limit) as TradeRow[];
    return rows.map(rowToTrade);
  }

  tradesForDate(ymd: string): Trade[] {
    const start = Date.parse(`${ymd}T00:00:00Z`);
    const end = start + 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(`SELECT * FROM trades WHERE opened_at >= ? AND opened_at < ? ORDER BY opened_at ASC`)
      .all(start, end) as TradeRow[];
    return rows.map(rowToTrade);
  }

  saveDailyState(date: string, state: {
    startingEquityUsd: number;
    exposureUsd: number;
    realizedPnlUsd: number;
    killSwitch: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO daily_state (date, starting_equity_usd, exposure_usd, realized_pnl_usd, kill_switch)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(date, state.startingEquityUsd, state.exposureUsd, state.realizedPnlUsd, state.killSwitch ? 1 : 0);
  }

  loadDailyState(date: string): {
    startingEquityUsd: number;
    exposureUsd: number;
    realizedPnlUsd: number;
    killSwitch: boolean;
  } | null {
    const row = this.db.prepare(`SELECT * FROM daily_state WHERE date = ?`).get(date) as
      | DailyStateRow
      | undefined;
    if (!row) return null;
    return {
      startingEquityUsd: row.starting_equity_usd,
      exposureUsd: row.exposure_usd,
      realizedPnlUsd: row.realized_pnl_usd,
      killSwitch: row.kill_switch === 1,
    };
  }

  close(): void {
    this.db.close();
  }
}

interface OpportunityRow {
  id: string;
  strategy: string;
  asset_class: string;
  edge_pct: number;
  size_usd: number;
  est_profit_usd: number;
  description: string;
  reasoning: string;
  venues: string;
  legs_json: string;
  detected_at: number;
  expires_at: number;
  source: string | null;
  requires_review: number | null;
}

interface TradeRow {
  id: string;
  opportunity_id: string;
  strategy: string;
  asset_class: string;
  mode: string;
  status: string;
  notional_usd: number;
  pnl_usd: number | null;
  reasoning: string;
  fills_json: string;
  opened_at: number;
  closed_at: number | null;
}

interface DailyStateRow {
  date: string;
  starting_equity_usd: number;
  exposure_usd: number;
  realized_pnl_usd: number;
  kill_switch: number;
}

function rowToOpportunity(r: OpportunityRow): Opportunity {
  return {
    id: r.id,
    strategy: r.strategy as Opportunity['strategy'],
    assetClass: r.asset_class as Opportunity['assetClass'],
    venues: JSON.parse(r.venues),
    description: r.description,
    edgePct: r.edge_pct,
    estProfitUsd: r.est_profit_usd,
    sizeUsd: r.size_usd,
    legs: JSON.parse(r.legs_json),
    reasoning: r.reasoning,
    detectedAt: r.detected_at,
    expiresAt: r.expires_at,
    source: (r.source as Opportunity['source']) ?? 'confirmed',
    requiresReview: r.requires_review === 1,
  };
}

function rowToTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    opportunityId: r.opportunity_id,
    strategy: r.strategy as Trade['strategy'],
    assetClass: r.asset_class as Trade['assetClass'],
    mode: r.mode as Trade['mode'],
    status: r.status as Trade['status'],
    notionalUsd: r.notional_usd,
    pnlUsd: r.pnl_usd,
    reasoning: r.reasoning,
    fills: JSON.parse(r.fills_json),
    openedAt: r.opened_at,
    closedAt: r.closed_at,
  };
}
