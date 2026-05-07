'use client';

import { useEffect, useState } from 'react';
import type { EngineStatus, Opportunity, Trade } from '@cesar-arb/shared';
import { api } from '@/lib/api';
import { fmtUsd, fmtPct, fmtTime } from '@/lib/format';

export default function OverviewPage() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [s, o, t] = await Promise.all([
          api.status(),
          api.opportunities(),
          api.trades(20),
        ]);
        if (cancelled) return;
        setStatus(s);
        setOpps(o.live);
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
      <div className="card border border-danger/20">
        <h2 className="text-h1">Engine unreachable</h2>
        <p className="mt-2 text-ink-muted">
          Couldn&apos;t reach the engine API. Make sure it&apos;s running:
          <code className="ml-2 rounded bg-black/5 px-2 py-0.5 text-sm">pnpm dev:engine</code>
        </p>
        <p className="mt-2 text-sm text-ink-subtle">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-h1">Overview</h1>
          <p className="text-sm text-ink-muted">
            {status?.mode === 'paper' ? 'Paper trading' : 'Live trading'} · {status?.running ? 'Running' : 'Stopped'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ModePill mode={status?.mode ?? 'paper'} />
          <button
            onClick={toggleKillSwitch}
            className={status?.killSwitch ? 'btn-primary' : 'btn-danger'}
          >
            {status?.killSwitch ? 'Resume trading' : 'Kill switch'}
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="P&L today"
          value={status ? fmtUsd(status.realizedPnlTodayUsd, { signed: true }) : '—'}
          tone={status && status.realizedPnlTodayUsd >= 0 ? 'pos' : 'neg'}
        />
        <Stat
          label="Exposure today"
          value={status ? fmtUsd(status.exposureTodayUsd) : '—'}
          sub={status ? `of ${fmtUsd(status.limits.maxDailyExposureUsd)} cap` : undefined}
        />
        <Stat
          label="Trades"
          value={status ? String(status.tradedCount) : '—'}
          sub={status ? `${status.scannedCount} scanned` : undefined}
        />
        <Stat
          label="Min spread"
          value={status ? fmtPct(status.limits.minSpreadPct) : '—'}
          sub={status ? `trail ${status.limits.trailingStopPct}%` : undefined}
        />
      </section>

      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Live opportunities</h2>
          <span className="text-xs text-ink-muted">{opps.length} fresh</span>
        </div>
        {opps.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No opportunities meeting your {fmtPct(status?.limits.minSpreadPct ?? 1)} threshold right now.
            Scanners are running — this is normal at retail thresholds.
          </p>
        ) : (
          <ul className="divide-y divide-black/5">
            {opps.slice(0, 8).map((o) => (
              <li key={o.id} className="grid grid-cols-12 items-center gap-3 py-3">
                <div className="col-span-12 md:col-span-7">
                  <div className="font-medium">{o.description}</div>
                  <div className="text-xs text-ink-muted">{o.reasoning}</div>
                </div>
                <div className="col-span-4 md:col-span-2">
                  <span className="pill bg-accent-dim text-accent">{o.strategy}</span>
                </div>
                <div className="col-span-4 md:col-span-1 text-right text-sm font-medium text-accent">
                  {fmtPct(o.edgePct)}
                </div>
                <div className="col-span-4 md:col-span-2 text-right text-sm">
                  {fmtUsd(o.estProfitUsd, { signed: true })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent trades</h2>
          <a href="/trades" className="text-sm text-accent hover:underline">View all →</a>
        </div>
        {trades.length === 0 ? (
          <p className="text-sm text-ink-muted">No trades yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink-muted">
              <tr>
                <th className="py-2">Time</th>
                <th>Strategy</th>
                <th>Asset</th>
                <th className="text-right">Notional</th>
                <th className="text-right">P&amp;L</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5">
              {trades.slice(0, 8).map((t) => (
                <tr key={t.id}>
                  <td className="py-2">{fmtTime(t.openedAt)}</td>
                  <td>{t.strategy}</td>
                  <td className="text-ink-muted">{t.assetClass}</td>
                  <td className="text-right">{fmtUsd(t.notionalUsd)}</td>
                  <td className={`text-right font-medium ${(t.pnlUsd ?? 0) >= 0 ? 'text-accent' : 'text-danger'}`}>
                    {t.pnlUsd === null ? '—' : fmtUsd(t.pnlUsd, { signed: true })}
                  </td>
                  <td>
                    <span className={`pill ${statusTone(t.status)}`}>{t.status}</span>
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

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'pos' | 'neg' }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value mt-2 ${tone === 'pos' ? 'text-accent' : tone === 'neg' ? 'text-danger' : ''}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

function ModePill({ mode }: { mode: 'paper' | 'live' }) {
  return (
    <span className={`pill ${mode === 'paper' ? 'bg-accent-dim text-accent' : 'bg-danger/10 text-danger'}`}>
      {mode === 'paper' ? '● Paper' : '● Live'}
    </span>
  );
}

function statusTone(s: Trade['status']): string {
  if (s === 'closed') return 'bg-accent-dim text-accent';
  if (s === 'open') return 'bg-black/5 text-ink-muted';
  if (s === 'failed') return 'bg-danger/10 text-danger';
  return 'bg-black/5 text-ink-muted';
}
