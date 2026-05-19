'use client';

/**
 * NATHAN-I analytics suite.
 *
 * The engine exposes no history endpoint, so we accumulate a session
 * time-series client-side from the 3s status poll (`useSessionSeries`) and
 * derive the distribution / share charts from the current snapshot.
 *
 * All charts are hand-rolled SVG — no charting dependency — to keep the
 * Railway build lean and match the no-canvas radar already in the app.
 */

import { useEffect, useRef, useState } from 'react';
import type { EngineStatus, Opportunity } from '@cesar-arb/shared';
import { fmtUsd, fmtCount } from '@/lib/format';

const GOLD = '#C9A24B';
const BLUE = '#7FA6F5';
const MAX_POINTS = 160; // ~8 min of history at a 3s poll

export interface Sample {
  t: number;
  pnl: number;
  exposure: number;
  candidates: number;
  scanned: number;
  traded: number;
  scanMs: number;
}

/** Append-only ring of status snapshots for the current session. */
export function useSessionSeries(status: EngineStatus | null): Sample[] {
  const [series, setSeries] = useState<Sample[]>([]);
  const lastScanAt = useRef<number | null>(null);

  useEffect(() => {
    if (!status) return;
    // Only push a new point when the engine has completed a fresh scan,
    // so the series tracks real engine activity rather than poll jitter.
    if (status.lastScanAt === lastScanAt.current) return;
    lastScanAt.current = status.lastScanAt;
    setSeries((prev) => {
      const next = [
        ...prev,
        {
          t: status.lastScanAt ?? Date.now(),
          pnl: status.realizedPnlTodayUsd,
          exposure: status.exposureTodayUsd,
          candidates: status.candidateCount,
          scanned: status.scannedCount,
          traded: status.tradedCount,
          scanMs: status.lastScanMs,
        },
      ];
      return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
    });
  }, [status]);

  return series;
}

/* ── Primitives ──────────────────────────────────────────────────────── */

function Sparkline({
  values,
  stroke = GOLD,
  height = 56,
  fill = true,
}: {
  values: number[];
  stroke?: string;
  height?: number;
  fill?: boolean;
}) {
  const W = 240;
  const H = height;
  if (values.length < 2) {
    return (
      <div className="grid h-14 place-items-center text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
        Awaiting samples…
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = W / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = H - 4 - ((v - min) / span) * (H - 8);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const gid = `sg-${stroke.replace('#', '')}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.6" fill={stroke} />
    </svg>
  );
}

function MultiLine({
  series,
  height = 200,
}: {
  series: { values: number[]; stroke: string; label: string }[];
  height?: number;
}) {
  const W = 720;
  const H = height;
  const len = Math.max(...series.map((s) => s.values.length), 0);
  if (len < 2) {
    return (
      <div className="grid place-items-center text-[11px] uppercase tracking-[0.16em] text-ink-subtle" style={{ height }}>
        Building session timeline — first scans incoming…
      </div>
    );
  }
  const all = series.flatMap((s) => s.values);
  const max = Math.max(...all, 1);
  const stepX = W / (len - 1);
  const path = (vals: number[]) =>
    vals
      .map((v, i) => {
        const x = i * stepX;
        const y = H - 8 - (v / max) * (H - 16);
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="rgba(150,180,255,0.08)" strokeWidth="1" />
        ))}
        {series.map((s) => (
          <path
            key={s.label}
            d={path(s.values)}
            fill="none"
            stroke={s.stroke}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </svg>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-ink-muted">
            <span className="h-1.5 w-3 rounded-full" style={{ background: s.stroke }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Donut({ slices }: { slices: { label: string; value: number; color: string }[] }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 110 110" className="h-[110px] w-[110px] -rotate-90">
        <circle cx="55" cy="55" r={R} fill="none" stroke="rgba(150,180,255,0.10)" strokeWidth="13" />
        {total > 0 &&
          slices.map((s) => {
            const frac = s.value / total;
            const dash = `${frac * C} ${C}`;
            const el = (
              <circle
                key={s.label}
                cx="55"
                cy="55"
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth="13"
                strokeDasharray={dash}
                strokeDashoffset={-offset * C}
                strokeLinecap="butt"
              />
            );
            offset += frac;
            return el;
          })}
      </svg>
      <div className="space-y-1.5">
        {slices.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            <span className="text-ink-muted">{s.label}</span>
            <span className="ml-auto pl-3 font-semibold tabular-nums text-ink">{fmtCount(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Histogram({ edges, minSpread }: { edges: number[]; minSpread: number }) {
  if (edges.length === 0) {
    return (
      <div className="grid h-[110px] place-items-center text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
        No candidates scanned yet
      </div>
    );
  }
  const lo = Math.min(...edges, 0);
  const hi = Math.max(...edges, minSpread * 1.2);
  const BINS = 14;
  const span = hi - lo || 1;
  const counts = new Array(BINS).fill(0);
  for (const e of edges) {
    const idx = Math.min(BINS - 1, Math.max(0, Math.floor(((e - lo) / span) * BINS)));
    counts[idx]++;
  }
  const peak = Math.max(...counts, 1);
  const markerPct = ((minSpread - lo) / span) * 100;
  return (
    <div>
      <div className="relative flex h-[110px] items-end gap-[3px]">
        {counts.map((c, i) => {
          const binLo = lo + (i / BINS) * span;
          const tradable = binLo >= minSpread;
          return (
            <div
              key={i}
              className="flex-1 rounded-t-sm"
              style={{
                height: `${(c / peak) * 100}%`,
                minHeight: c > 0 ? 3 : 0,
                background: tradable
                  ? 'linear-gradient(180deg,#E3BE6A,#C9A24B)'
                  : 'linear-gradient(180deg,#5682F5,#2E5BD8)',
              }}
              title={`${c} signal${c === 1 ? '' : 's'} near ${binLo.toFixed(2)}%`}
            />
          );
        })}
        {markerPct >= 0 && markerPct <= 100 && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
            style={{ left: `${markerPct}%`, boxShadow: '0 0 8px rgba(201,162,75,0.8)' }}
          />
        )}
      </div>
      <div className="mt-2 flex justify-between text-[10px] uppercase tracking-[0.14em] text-ink-subtle">
        <span>{lo.toFixed(1)}%</span>
        <span className="text-accent">▲ min {minSpread.toFixed(2)}%</span>
        <span>{hi.toFixed(1)}%</span>
      </div>
    </div>
  );
}

/* ── Card wrapper ────────────────────────────────────────────────────── */

function ChartCard({
  title,
  figure,
  sub,
  children,
}: {
  title: string;
  figure?: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="chart-card">
      <div className="relative z-10">
        <div className="flex items-baseline justify-between">
          <span className="chart-title">{title}</span>
          {figure && <span className="chart-figure">{figure}</span>}
        </div>
        <div className="mt-3">{children}</div>
        {sub && <div className="mt-3 text-[11px] uppercase tracking-[0.14em] text-ink-subtle">{sub}</div>}
      </div>
    </div>
  );
}

/* ── Composed suite ──────────────────────────────────────────────────── */

export function AnalyticsRow({
  series,
  status,
  candidates,
}: {
  series: Sample[];
  status: EngineStatus | null;
  candidates: Opportunity[];
}) {
  const pnl = status?.realizedPnlTodayUsd ?? 0;
  const lastScanMs = status?.lastScanMs ?? 0;

  const byStrategy = [
    {
      label: 'Cross-exchange',
      value: candidates.filter((c) => c.strategy === 'cross-exchange').length,
      color: '#5682F5',
    },
    {
      label: 'Prediction-pair',
      value: candidates.filter((c) => c.strategy === 'prediction-pair').length,
      color: '#7FA6F5',
    },
    {
      label: 'Triangular',
      value: candidates.filter((c) => c.strategy === 'triangular').length,
      color: GOLD,
    },
  ];

  // Dynamic venue mix — new exchanges appear automatically. Cycle a small
  // blue→gold palette so the donut stays legible as venues grow.
  const VENUE_PALETTE = ['#5682F5', '#7FA6F5', '#9CC0FF', '#3E63C8', '#C9A24B', '#E3BE6A', '#6E8FE8', '#B98F3C'];
  const venueSlices = Object.entries(status?.marketCounts ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({
      label: label.charAt(0).toUpperCase() + label.slice(1),
      value,
      color: VENUE_PALETTE[i % VENUE_PALETTE.length] as string,
    }));

  return (
    <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <ChartCard
        title="Cumulative P&L"
        figure={fmtUsd(pnl, { signed: true })}
        sub="Booked paper profit · this session"
      >
        <Sparkline values={series.map((s) => s.pnl)} stroke={GOLD} />
      </ChartCard>

      <ChartCard
        title="Edge distribution"
        figure={`${candidates.length}`}
        sub="Gold bars clear your min-spread; blue is sub-threshold"
      >
        <Histogram
          edges={candidates.map((c) => c.edgePct)}
          minSpread={status?.limits.minSpreadPct ?? 1}
        />
      </ChartCard>

      <ChartCard title="Signals by strategy" sub="Live candidate mix">
        <Donut slices={byStrategy} />
      </ChartCard>

      <ChartCard title="Markets by venue" sub={`${venueSlices.length} venues under watch`}>
        <Donut slices={venueSlices} />
      </ChartCard>

      <ChartCard
        title="Scan latency"
        figure={`${lastScanMs}ms`}
        sub="Engine heartbeat · ms per scan loop"
      >
        <Sparkline values={series.map((s) => s.scanMs)} stroke={BLUE} />
      </ChartCard>

      <ChartCard
        title="Exposure deployed"
        figure={fmtUsd(status?.exposureTodayUsd ?? 0)}
        sub={`of ${fmtUsd(status?.limits.maxDailyExposureUsd ?? 0)} daily cap`}
      >
        <Sparkline values={series.map((s) => s.exposure)} stroke={BLUE} />
      </ChartCard>
    </section>
  );
}

export function ActivityTimeline({ series }: { series: Sample[] }) {
  return (
    <section className="chart-card">
      <div className="relative z-10">
        <div className="mb-4 flex items-center justify-between">
          <span className="chart-title">Activity timeline · session</span>
          <span className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
            {series.length} scan{series.length === 1 ? '' : 's'} recorded
          </span>
        </div>
        <MultiLine
          series={[
            { label: 'Candidates evaluated', stroke: '#5682F5', values: series.map((s) => s.candidates) },
            { label: 'Tradable signals', stroke: '#7FA6F5', values: series.map((s) => s.scanned) },
            { label: 'Trades filled', stroke: GOLD, values: series.map((s) => s.traded) },
          ]}
        />
      </div>
    </section>
  );
}
