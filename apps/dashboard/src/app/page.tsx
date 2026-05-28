'use client';

import { useEffect, useState } from 'react';
import type { EngineStatus, Opportunity } from '@cesar-arb/shared';
import { api } from '@/lib/api';
import { fmtUsd, fmtPct, fmtTime, fmtAge, fmtCount } from '@/lib/format';
import { useSessionSeries, SignalsPanel, Sparkline } from '@/components/Charts';

export default function CommandPage() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [candidates, setCandidates] = useState<Opportunity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [s, o, c] = await Promise.all([
          api.status(),
          api.opportunities(),
          api.candidates(),
        ]);
        if (cancelled) return;
        setStatus(s);
        setOpps(o.live);
        setCandidates(c.recent);
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
  const positions = [...opps].sort((a, b) => b.edgePct - a.edgePct);
  const nearest = [...candidates]
    .filter((c) => !c.requiresReview && c.edgePct < minSpread)
    .sort((a, b) => b.edgePct - a.edgePct)[0];
  const reviewCount = candidates.filter((c) => c.requiresReview).length;
  const venueCount = status ? Object.keys(status.marketCounts).length : 0;
  const totalMarkets = status ? Object.values(status.marketCounts).reduce((a, b) => a + b, 0) : 0;
  const bestEdge = candidates.length ? Math.max(...candidates.map((c) => c.edgePct)) : 0;
  const cap = status?.limits.maxDailyExposureUsd ?? 0;
  const exposurePct = status && cap > 0 ? (status.exposureTodayUsd / cap) * 100 : 0;

  return (
    <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
      {/* ── 1 · Live ticker strip ──────────────────────────────────── */}
      <section className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 rounded-card border border-line bg-bg-card/80 px-4 py-2 text-[11px] uppercase tracking-[0.14em]">
        <Tick label="Mode" value={status?.mode ?? '—'} tone="gold" />
        <Sep />
        <Tick label="Engine" value={status?.running ? 'Scanning' : 'Stopped'} tone={status?.running ? 'ok' : 'mute'} />
        <Sep />
        <Tick label="Venues" value={String(venueCount || '—')} />
        <Sep />
        <Tick label="Markets" value={status ? fmtCount(totalMarkets) : '—'} />
        <Sep />
        <Tick label="Candidates" value={status ? fmtCount(status.candidateCount) : '—'} />
        <Sep />
        <Tick label="Tradable" value={String(positions.length)} tone="gold" />
        <Sep />
        <Tick label="Best edge" value={bestEdge ? fmtPct(bestEdge) : '—'} tone="gold" />
        <Sep />
        <Tick label="Min spread" value={fmtPct(minSpread)} />
        <Sep />
        <Tick label="Scan" value={status ? `${status.lastScanMs}ms` : '—'} />
      </section>

      {/* ── 2 · KPI row ────────────────────────────────────────────── */}
      <section className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="P&L Today" value={status ? fmtUsd(pnl, { signed: true }) : '—'} sub="booked · paper" tone={pnl >= 0 ? 'gold' : 'neg'} />
        <Kpi label="Exposure" value={status ? fmtUsd(status.exposureTodayUsd) : '—'} sub={status ? `${exposurePct.toFixed(0)}% of ${fmtUsd(cap)} cap` : '—'} />
        <Kpi label="Positions to enter" value={String(positions.length)} sub={`clear ${fmtPct(minSpread)} edge`} tone="gold" />
        <Kpi label="Candidates" value={status ? fmtCount(status.candidateCount) : '—'} sub="evaluated · session" />
        <Kpi label="Trades filled" value={status ? fmtCount(status.tradedCount) : '—'} sub="this session" />
        <Kpi label="Best edge" value={bestEdge ? fmtPct(bestEdge) : '—'} sub="top live signal" tone="gold" />
      </section>

      {/* ── 3 · Scan pipeline funnel ───────────────────────────────── */}
      <section className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-line bg-bg-card px-4 py-3">
        <span className="mr-1 text-[11px] uppercase tracking-[0.16em] text-ink-subtle">Scan pipeline</span>
        <Funnel label="Markets watched" value={status ? fmtCount(totalMarkets) : '—'} />
        <Arrow />
        <Funnel label="Candidates" value={status ? fmtCount(status.candidateCount) : '—'} />
        <Arrow />
        <Funnel label="Tradable" value={String(positions.length)} accent />
        <Arrow />
        <Funnel label="Filled" value={status ? fmtCount(status.tradedCount) : '—'} accent />
        {reviewCount > 0 && <span className="pill-review ml-auto">{reviewCount} flagged for review</span>}
      </section>

      {/* ── 4 · Command deck: act · analyse · control ──────────────── */}
      <div className="grid min-h-0 grid-cols-1 gap-3 lg:flex-1 lg:grid-cols-12">
        {/* LEFT — positions to enter (scrolls inside its own panel) */}
        <section className="card flex min-h-0 flex-col lg:col-span-5">
          <div className="mb-3 flex shrink-0 items-baseline justify-between">
            <h1 className="text-h1 font-extrabold uppercase tracking-tight">Positions to enter</h1>
            <span className="pill-gold">{positions.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {positions.length === 0 ? (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <div className="text-lg font-semibold text-ink">No position to enter right now</div>
                  <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
                    Markets are efficient — nothing clears your {fmtPct(minSpread)} threshold.
                    NATHAN-I is scanning {venueCount} venues and will surface one the instant it appears.
                  </p>
                  {nearest && (
                    <div className="mx-auto mt-4 max-w-md rounded-lg border border-line bg-white/[0.02] px-4 py-3 text-left">
                      <div className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">Closest so far · not yet tradable</div>
                      <div className="mt-1 text-sm text-ink">{nearest.description}</div>
                      <div className="mt-1 text-xs text-ink-muted">{fmtPct(nearest.edgePct)} edge — needs {fmtPct(minSpread)} to enter</div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <ul className="space-y-3">
                {positions.map((o) => (
                  <PositionCard key={o.id} o={o} />
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* MIDDLE — live signals analytics */}
        <section className="flex min-h-0 flex-col lg:col-span-4">
          <div className="mb-2 flex shrink-0 items-center gap-3">
            <h2 className="panel-title">Live signals</h2>
            <span className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">reference only</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <SignalsPanel status={status} candidates={candidates} />
          </div>
        </section>

        {/* RIGHT — system status / action hub */}
        <aside className="card flex min-h-0 flex-col lg:col-span-3">
          <div className="flex shrink-0 items-center justify-between">
            <h2 className="panel-title">System status</h2>
            <span className={status?.running ? 'pill-ok' : 'pill-mute'}>{status?.running ? '● Live' : '○ Idle'}</span>
          </div>
          <dl className="mt-4 space-y-2.5 text-sm">
            <StatusRow k="Mode" v={(status?.mode ?? '—').toUpperCase()} />
            <StatusRow k="Last scan" v={status?.lastScanAt ? fmtTime(status.lastScanAt) : '—'} />
            <StatusRow k="Scan latency" v={status ? `${status.lastScanMs} ms` : '—'} />
            <StatusRow k="Candidates" v={status ? fmtCount(status.candidateCount) : '—'} />
            <StatusRow k="Trades filled" v={status ? fmtCount(status.tradedCount) : '—'} />
            <StatusRow k="Flagged for review" v={String(reviewCount)} />
          </dl>
          {status?.killSwitch && <div className="pill-danger mt-3 self-start">● Trading halted</div>}
          <button onClick={toggleKillSwitch} className={`mt-4 w-full ${status?.killSwitch ? 'btn-primary' : 'btn-danger'}`}>
            {status?.killSwitch ? 'Resume trading' : 'Kill switch'}
          </button>
          <div className="mt-auto pt-4">
            <div className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">P&L · session</div>
            <Sparkline values={series.map((s) => s.pnl)} stroke="#C9A24B" height={44} />
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ── small presentational pieces ──────────────────────────────────────── */

function Tick({ label, value, tone }: { label: string; value: string; tone?: 'gold' | 'ok' | 'mute' }) {
  const c = tone === 'gold' ? 'text-accent' : tone === 'ok' ? 'text-ok' : tone === 'mute' ? 'text-ink-muted' : 'text-ink';
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-ink-subtle">{label}</span>
      <span className={`font-semibold tabular-nums ${c}`}>{value}</span>
    </span>
  );
}

function Sep() {
  return <span className="text-ink-subtle">·</span>;
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'gold' | 'neg' }) {
  const color = tone === 'gold' ? 'text-accent' : tone === 'neg' ? 'text-danger' : 'text-ink';
  return (
    <div className="rounded-card border border-line bg-bg-card px-4 py-3">
      <div className="stat-label truncate">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] uppercase tracking-[0.12em] text-ink-subtle">{sub}</div>}
    </div>
  );
}

function Funnel({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className={`text-base font-semibold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>{value}</span>
      <span className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">{label}</span>
    </span>
  );
}

function Arrow() {
  return <span className="text-ink-subtle">→</span>;
}

function StatusRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="font-semibold tabular-nums text-ink">{v}</dd>
    </div>
  );
}

/** One actionable position: what to do, where, how big, the edge. */
function PositionCard({ o }: { o: Opportunity }) {
  return (
    <li className="rounded-card border border-line bg-white/[0.02] p-4 transition-shadow hover:shadow-cardHover">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
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

        <div className="flex shrink-0 items-center gap-5">
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
