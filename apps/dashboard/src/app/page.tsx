'use client';

import { useEffect, useState } from 'react';
import type { EngineStatus, Opportunity, Trade } from '@cesar-arb/shared';
import { api } from '@/lib/api';
import { fmtUsd, fmtPct, fmtTime, fmtAge, fmtCount } from '@/lib/format';
import { Radar } from '@/components/Radar';

export default function OverviewPage() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [candidates, setCandidates] = useState<Opportunity[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [s, o, c, t] = await Promise.all([
          api.status(),
          api.opportunities(),
          api.candidates(),
          api.trades(20),
        ]);
        if (cancelled) return;
        setStatus(s);
        setOpps(o.live);
        setCandidates(c.recent);
        setTrades(t.trades);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function toggleKillSwitch() {
    if (!status) return;
    await api.setKillSwitch(!status.killSwitch);
    const s = await api.status();
    setStatus(s);
  }

  if (error && !status) {
    return (
      <div className="card" style={{ boxShadow: 'inset 0 0 0 1px rgba(242,85,90,0.4)' }}>
        <div className="eyebrow text-danger">System offline</div>
        <h2 className="mt-2 text-h1">Engine unreachable</h2>
        <p className="mt-2 text-ink-muted">
          Couldn&apos;t reach the engine API. Make sure it&apos;s running:
          <code className="ml-2 rounded bg-white/[0.05] px-2 py-0.5 text-sm text-accent">pnpm dev:engine</code>
        </p>
        <p className="mt-2 text-sm text-ink-subtle">{error}</p>
      </div>
    );
  }

  const pnl = status?.realizedPnlTodayUsd ?? 0;
  const expPct = status
    ? Math.min(100, (status.exposureTodayUsd / status.limits.maxDailyExposureUsd) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="relative overflow-hidden rounded-card border border-line bg-bg-card p-7 shadow-card md:p-9">
        <div className="pointer-events-none absolute -right-10 -top-10 hidden md:block">
          <Radar size={300} />
        </div>
        <div className="relative max-w-2xl">
          <div className="eyebrow">Built for Cesar · Powered by real-time market data</div>
          <h1 className="mt-4 text-[44px] font-extrabold uppercase leading-[0.95] tracking-tight md:text-hero">
            Live Arbitrage
            <br />
            <span className="text-accent">Intelligence</span>
          </h1>
          <p className="mt-4 max-w-md text-sm text-ink-muted">
            Real-time cross-venue signals. Verified pairs only. Hard risk caps.
            Paper-mode — no capital at risk.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <ModePill mode={status?.mode ?? 'paper'} />
            <span className={status?.running ? 'pill-ok' : 'pill-mute'}>
              {status?.running ? '● Scanning' : '○ Stopped'}
            </span>
            {status?.killSwitch && <span className="pill-danger">● Kill switch engaged</span>}
            <button
              onClick={toggleKillSwitch}
              className={status?.killSwitch ? 'btn-primary' : 'btn-danger'}
            >
              {status?.killSwitch ? 'Resume trading' : 'Kill switch'}
            </button>
          </div>
        </div>
      </section>

      {/* ── Market strip ───────────────────────────────────── */}
      <section className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-card border border-line bg-bg-card px-6 py-4 text-sm">
        <StripItem label="Mode" value={status?.mode ?? '—'} gold />
        <StripItem label="Min spread" value={status ? fmtPct(status.limits.minSpreadPct) : '—'} />
        <StripItem label="BitGet" value={fmtCount(status?.marketCounts.bitget ?? 0)} />
        <StripItem label="Polymarket" value={fmtCount(status?.marketCounts.polymarket ?? 0)} />
        <StripItem label="Kalshi" value={fmtCount(status?.marketCounts.kalshi ?? 0)} />
        <div className="ml-auto text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
          {status?.lastScanAt ? `Last scan ${fmtAge(status.lastScanAt)} · ${status.lastScanMs}ms` : 'Awaiting first scan…'}
        </div>
      </section>

      {/* ── Stat grid ──────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="P&L Today"
          value={status ? fmtUsd(pnl, { signed: true }) : '—'}
          tone={pnl >= 0 ? 'pos' : 'neg'}
          trend={pnl >= 0 ? 'Booked paper profit' : 'Drawdown'}
        />
        <Stat
          label="Exposure Today"
          value={status ? fmtUsd(status.exposureTodayUsd) : '—'}
          sub={status ? `${expPct.toFixed(0)}% of ${fmtUsd(status.limits.maxDailyExposureUsd)} cap` : undefined}
          bar={expPct}
        />
        <Stat
          label="Trades"
          value={status ? String(status.tradedCount) : '—'}
          trend={status ? `${fmtCount(status.candidateCount)} evaluated` : undefined}
        />
        <Stat
          label="Tradable Signals"
          value={status ? String(status.scannedCount) : '—'}
          sub={status ? `min edge ${fmtPct(status.limits.minSpreadPct)}` : undefined}
        />
      </section>

      {/* ── Pipeline ───────────────────────────────────────── */}
      <section className="card">
        <div className="eyebrow mb-4">Mission flow</div>
        <Pipeline status={status} live={opps.length} />
      </section>

      {/* ── Markets monitored ──────────────────────────────── */}
      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="panel-title">Markets monitored</h2>
          <span className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
            {status?.lastScanAt ? `${status.lastScanMs}ms scan` : 'waiting…'}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <VenueStat label="BitGet pairs" count={status?.marketCounts.bitget ?? 0} />
          <VenueStat label="Polymarket markets" count={status?.marketCounts.polymarket ?? 0} />
          <VenueStat label="Kalshi markets" count={status?.marketCounts.kalshi ?? 0} />
        </div>
      </section>

      {/* ── Live opportunities ─────────────────────────────── */}
      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="panel-title">Live opportunities</h2>
          <span className="pill-gold">{opps.length} fresh</span>
        </div>
        {opps.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No opportunities meeting your {fmtPct(status?.limits.minSpreadPct ?? 1)} threshold right now.
            Scanners are running — this is normal at retail thresholds.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {opps.slice(0, 8).map((o) => (
              <li key={o.id} className="grid grid-cols-12 items-center gap-3 py-3">
                <div className="col-span-12 md:col-span-7">
                  <div className="font-medium">{o.description}</div>
                  <div className="text-xs text-ink-muted">{o.reasoning}</div>
                </div>
                <div className="col-span-4 md:col-span-2">
                  <span className="pill-gold">{o.strategy}</span>
                </div>
                <div className="col-span-4 text-right text-sm font-semibold text-accent md:col-span-1">
                  {fmtPct(o.edgePct)}
                </div>
                <div className="col-span-4 text-right text-sm md:col-span-2">
                  {fmtUsd(o.estProfitUsd, { signed: true })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Scan feed ──────────────────────────────────────── */}
      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="panel-title">Live scan feed</h2>
          <span className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
            {candidates.length} candidate{candidates.length === 1 ? '' : 's'} · sub-threshold included
          </span>
        </div>
        {candidates.length === 0 ? (
          <p className="text-sm text-ink-muted">No candidates yet — first scan in progress.</p>
        ) : (
          <ul className="divide-y divide-line">
            {candidates.slice(0, 12).map((c) => {
              const tradable = status ? c.edgePct >= status.limits.minSpreadPct : false;
              return (
                <li key={c.id} className="grid grid-cols-12 items-center gap-3 py-2">
                  <div className="col-span-12 md:col-span-7">
                    <div className="text-sm font-medium">{c.description}</div>
                    <div className="text-xs text-ink-muted">{c.venues.join(' + ')} · {fmtAge(c.detectedAt)}</div>
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    <span className="pill-mute">{c.strategy}</span>
                  </div>
                  <div className={`col-span-4 text-right text-sm font-medium md:col-span-1 ${c.edgePct >= 0 ? 'text-accent' : 'text-ink-muted'}`}>
                    {fmtPct(c.edgePct)}
                  </div>
                  <div className="col-span-4 text-right md:col-span-2">
                    {c.requiresReview ? (
                      <span className="pill-review" title="Cross-venue heuristic match — resolution criteria not verified. Will not auto-trade.">
                        review only
                      </span>
                    ) : tradable ? (
                      <span className="pill-ok">tradable</span>
                    ) : (
                      <span className="pill-mute">below {fmtPct(status?.limits.minSpreadPct ?? 0)}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Recent trades ──────────────────────────────────── */}
      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="panel-title">Recent trades</h2>
          <a href="/trades" className="text-xs font-semibold uppercase tracking-[0.14em] text-accent hover:text-accent-hover">
            View all →
          </a>
        </div>
        {trades.length === 0 ? (
          <p className="text-sm text-ink-muted">No trades yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
              <tr>
                <th className="py-2">Time</th>
                <th>Strategy</th>
                <th>Asset</th>
                <th className="text-right">Notional</th>
                <th className="text-right">P&amp;L</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {trades.slice(0, 8).map((t) => (
                <tr key={t.id}>
                  <td className="py-2 tabular-nums">{fmtTime(t.openedAt)}</td>
                  <td>{t.strategy}</td>
                  <td className="text-ink-muted">{t.assetClass}</td>
                  <td className="text-right tabular-nums">{fmtUsd(t.notionalUsd)}</td>
                  <td className={`text-right font-semibold tabular-nums ${(t.pnlUsd ?? 0) >= 0 ? 'text-accent' : 'text-danger'}`}>
                    {t.pnlUsd === null ? '—' : fmtUsd(t.pnlUsd, { signed: true })}
                  </td>
                  <td>
                    <span className={statusPill(t.status)}>{t.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
  trend,
  bar,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'pos' | 'neg';
  trend?: string;
  bar?: number;
}) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value mt-3 ${tone === 'pos' ? 'text-accent' : tone === 'neg' ? 'text-danger' : 'text-ink'}`}>
        {value}
      </div>
      {trend && (
        <div className={`mt-2 text-xs ${tone === 'neg' ? 'text-danger' : 'text-accent'}`}>
          {tone === 'neg' ? '▾' : '▴'} {trend}
        </div>
      )}
      {sub && <div className="mt-2 text-xs text-ink-muted">{sub}</div>}
      {typeof bar === 'number' && (
        <div className="mt-3 h-1 w-full overflow-hidden rounded-pill bg-white/[0.06]">
          <div
            className="h-full rounded-pill bg-accent"
            style={{ width: `${bar}%`, boxShadow: '0 0 10px rgba(201,162,75,0.6)' }}
          />
        </div>
      )}
    </div>
  );
}

function StripItem({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${gold ? 'text-accent' : 'text-ink'}`}>{value}</span>
    </div>
  );
}

function VenueStat({ label, count }: { label: string; count: number }) {
  return (
    <div className="rounded-lg border border-line bg-white/[0.02] px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-ink-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{fmtCount(count)}</div>
    </div>
  );
}

function Pipeline({ status, live }: { status: EngineStatus | null; live: number }) {
  const steps = [
    { name: 'Scanning', done: !!status?.running, meta: status ? `${fmtCount(status.candidateCount)} candidates` : '—' },
    { name: 'Signal', done: live > 0, meta: `${live} above threshold` },
    { name: 'Risk gate', done: !status?.killSwitch, meta: status?.killSwitch ? 'halted' : 'caps enforced' },
    { name: 'Paper fill', done: (status?.tradedCount ?? 0) > 0, meta: `${status?.tradedCount ?? 0} filled` },
  ];
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      {steps.map((s, i) => (
        <div key={s.name} className="flex flex-1 items-center gap-3">
          <span
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${
              s.done ? 'bg-accent text-bg' : 'bg-white/[0.05] text-ink-subtle'
            }`}
            style={s.done ? { boxShadow: '0 0 14px rgba(201,162,75,0.5)' } : undefined}
          >
            {i + 1}
          </span>
          <div className="min-w-0">
            <div className={`text-sm font-semibold ${s.done ? 'text-ink' : 'text-ink-muted'}`}>{s.name}</div>
            <div className="truncate text-[11px] uppercase tracking-[0.12em] text-ink-subtle">{s.meta}</div>
          </div>
          {i < steps.length - 1 && <div className="hidden h-px flex-1 bg-line sm:block" />}
        </div>
      ))}
    </div>
  );
}

function ModePill({ mode }: { mode: 'paper' | 'live' }) {
  return (
    <span className={mode === 'paper' ? 'pill-gold' : 'pill-danger'}>
      {mode === 'paper' ? '● Paper' : '● Live'}
    </span>
  );
}

function statusPill(s: Trade['status']): string {
  if (s === 'closed') return 'pill-gold';
  if (s === 'open') return 'pill-mute';
  if (s === 'failed') return 'pill-danger';
  return 'pill-mute';
}
