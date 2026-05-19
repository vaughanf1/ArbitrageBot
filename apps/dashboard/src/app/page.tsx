'use client';

import { useEffect, useState } from 'react';
import type { EngineStatus, Opportunity, Trade } from '@cesar-arb/shared';
import { api } from '@/lib/api';
import { fmtUsd, fmtPct, fmtTime, fmtAge } from '@/lib/format';
import { useSessionSeries, AnalyticsRow, ActivityTimeline } from '@/components/Charts';

export default function CommandPage() {
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

  const series = useSessionSeries(status);

  async function toggleKillSwitch() {
    if (!status) return;
    await api.setKillSwitch(!status.killSwitch);
    setStatus(await api.status());
  }

  if (error && !status) {
    return (
      <div className="card" style={{ boxShadow: 'inset 0 0 0 1px rgba(242,85,90,0.4)' }}>
        <div className="eyebrow text-danger">System offline</div>
        <h2 className="mt-2 text-h1">Engine unreachable</h2>
        <p className="mt-2 text-sm text-ink-subtle">{error}</p>
      </div>
    );
  }

  const pnl = status?.realizedPnlTodayUsd ?? 0;
  const minSpread = status?.limits.minSpreadPct ?? 1;

  // "Positions to enter" = live, tradable opportunities (the engine already
  // filtered these to edge ≥ min-spread and not review-only).
  const positions = [...opps].sort((a, b) => b.edgePct - a.edgePct);

  // When there's nothing actionable, show the single closest near-miss so the
  // screen proves it's working — clearly marked as NOT a position to enter.
  const nearest = [...candidates]
    .filter((c) => !c.requiresReview && c.edgePct < minSpread)
    .sort((a, b) => b.edgePct - a.edgePct)[0];

  const reviewCount = candidates.filter((c) => c.requiresReview).length;
  const venueCount = status ? Object.keys(status.marketCounts).length : 0;

  return (
    <div className="space-y-8">
      {/* ── Status bar: the only numbers that matter at a glance ───── */}
      <section className="flex flex-wrap items-center gap-x-8 gap-y-4 rounded-card border border-line bg-bg-card px-6 py-5">
        <div>
          <div className="stat-label">P&amp;L Today</div>
          <div className={`mt-1 text-3xl font-semibold tabular-nums ${pnl >= 0 ? 'text-accent' : 'text-danger'}`}>
            {status ? fmtUsd(pnl, { signed: true }) : '—'}
          </div>
        </div>
        <div>
          <div className="stat-label">Exposure</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-ink">
            {status ? fmtUsd(status.exposureTodayUsd) : '—'}
            <span className="ml-1 text-sm text-ink-subtle">
              / {status ? fmtUsd(status.limits.maxDailyExposureUsd) : '—'}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className={status?.running ? 'pill-ok' : 'pill-mute'}>
            {status?.running ? '● Scanning' : '○ Stopped'}
          </span>
          {status?.killSwitch && <span className="pill-danger">● Halted</span>}
          <button onClick={toggleKillSwitch} className={status?.killSwitch ? 'btn-primary' : 'btn-danger'}>
            {status?.killSwitch ? 'Resume' : 'Kill switch'}
          </button>
        </div>
      </section>

      {/* ── THE list: positions to enter ──────────────────────────── */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h1 className="text-h1 font-extrabold uppercase tracking-tight">
            Positions to enter
          </h1>
          <span className="pill-gold">{positions.length}</span>
        </div>

        {positions.length === 0 ? (
          <div className="card text-center">
            <div className="text-lg font-semibold text-ink">No position to enter right now</div>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
              Markets are efficient — nothing clears your {fmtPct(minSpread)} threshold.
              NATHAN-I is scanning {venueCount} venues and will surface a position
              here the instant one does. This is normal, not a fault.
            </p>
            {nearest && (
              <div className="mx-auto mt-5 max-w-md rounded-lg border border-line bg-white/[0.02] px-4 py-3 text-left">
                <div className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
                  Closest so far · not yet tradable
                </div>
                <div className="mt-1 text-sm text-ink">{nearest.description}</div>
                <div className="mt-1 text-xs text-ink-muted">
                  {fmtPct(nearest.edgePct)} edge — needs {fmtPct(minSpread)} to enter
                </div>
              </div>
            )}
          </div>
        ) : (
          <ul className="space-y-3">
            {positions.map((o) => (
              <PositionCard key={o.id} o={o} />
            ))}
          </ul>
        )}

        {reviewCount > 0 && (
          <p className="mt-3 text-xs text-ink-subtle">
            {reviewCount} cross-venue match{reviewCount === 1 ? '' : 'es'} flagged for manual
            review — see the <a href="/opportunities" className="text-accent hover:text-accent-hover">Signals</a> tab.
            Never auto-entered.
          </p>
        )}
      </section>

      {/* ── Everything below here is secondary analysis ───────────── */}
      <section className="space-y-6 border-t border-line pt-8">
        <div className="flex items-center gap-3">
          <h2 className="panel-title">Analysis</h2>
          <span className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
            reference only — you don&apos;t need this to act
          </span>
        </div>

        <ActivityTimeline series={series} />
        <AnalyticsRow series={series} status={status} candidates={candidates} />

        <div className="card">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="panel-title">Recent trades</h3>
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
        </div>
      </section>
    </div>
  );
}

/** One actionable position: what to do, where, how big, the edge. */
function PositionCard({ o }: { o: Opportunity }) {
  return (
    <li className="card transition-shadow hover:shadow-cardHover">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-ink">{o.description}</span>
            <span className="pill-mute">{o.strategy}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {o.legs.map((leg, i) => (
              <span key={i} className="text-ink-muted">
                <span className={leg.side === 'buy' ? 'font-semibold text-ok' : 'font-semibold text-danger'}>
                  {leg.side.toUpperCase()}
                </span>{' '}
                {leg.symbol} <span className="text-ink-subtle">·</span> {leg.venue}
              </span>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-6">
          <Metric label="Size" value={fmtUsd(o.sizeUsd)} />
          <Metric label="Edge" value={fmtPct(o.edgePct)} accent />
          <Metric label="Est. profit" value={fmtUsd(o.estProfitUsd, { signed: true })} accent />
          <span className="pill-gold whitespace-nowrap">● Enter</span>
        </div>
      </div>
      <p className="mt-3 border-t border-line pt-3 text-xs text-ink-muted">
        {o.reasoning} · seen {fmtAge(o.detectedAt)}
      </p>
    </li>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-[0.16em] text-ink-subtle">{label}</div>
      <div className={`mt-0.5 text-base font-semibold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>
        {value}
      </div>
    </div>
  );
}

function statusPill(s: Trade['status']): string {
  if (s === 'closed') return 'pill-gold';
  if (s === 'open') return 'pill-mute';
  if (s === 'failed') return 'pill-danger';
  return 'pill-mute';
}
