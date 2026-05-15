'use client';

import { useEffect, useState } from 'react';
import type { EngineStatus } from '@cesar-arb/shared';
import { api } from '@/lib/api';
import { fmtUsd, fmtPct } from '@/lib/format';

export default function SettingsPage() {
  const [status, setStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const s = await api.status();
        if (!cancelled) setStatus(s);
      } catch {
        /* ignore */
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">System controls</div>
        <h1 className="mt-2 text-h1 uppercase tracking-tight">Settings</h1>
      </header>

      <section className="card">
        <h2 className="panel-title mb-4">Risk limits</h2>
        <p className="mb-5 text-sm text-ink-muted">
          Limits are read from <code className="rounded bg-white/[0.05] px-1.5 py-0.5 text-accent">.env</code>.
          Edit and restart the engine to change. The setup-bot can do this for you:
          <code className="ml-2 rounded bg-white/[0.05] px-1.5 py-0.5 text-accent">pnpm setup</code>
        </p>
        <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
          <Field label="Max trade size" value={status ? fmtUsd(status.limits.maxTradeSizeUsd) : '—'} />
          <Field label="Max daily exposure" value={status ? fmtUsd(status.limits.maxDailyExposureUsd) : '—'} />
          <Field label="Max daily loss" value={status ? fmtPct(status.limits.maxDailyLossPct) : '—'} />
          <Field label="Trailing stop" value={status ? fmtPct(status.limits.trailingStopPct) : '—'} />
          <Field label="Min spread threshold" value={status ? fmtPct(status.limits.minSpreadPct) : '—'} />
          <Field label="Mode" value={status?.mode ?? '—'} />
        </dl>
      </section>

      <section className="card">
        <h2 className="panel-title mb-2">Daily report</h2>
        <p className="mb-5 text-sm text-ink-muted">
          A formatted daily summary is available at{' '}
          <code className="rounded bg-white/[0.05] px-1.5 py-0.5 text-accent">/api/report/html</code>.
        </p>
        <a
          href={(process.env.NEXT_PUBLIC_ENGINE_URL ?? 'http://localhost:4000') + '/api/report/html'}
          target="_blank"
          rel="noreferrer"
          className="btn-primary"
        >
          Open today&apos;s report
        </a>
      </section>

      <section className="card">
        <h2 className="panel-title mb-2">Going live</h2>
        <p className="text-sm text-ink-muted">
          v1 ships paper-only. To go live: (1) fund your BitGet, Polymarket, and Kalshi accounts,
          (2) run <code className="rounded bg-white/[0.05] px-1.5 py-0.5 text-accent">pnpm setup</code> to add API keys,
          (3) set <code className="rounded bg-white/[0.05] px-1.5 py-0.5 text-accent">TRADING_MODE=live</code>, and
          (4) wait at least one week of healthy paper-trade results before flipping the switch.
        </p>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-card px-5 py-4">
      <dt className="stat-label">{label}</dt>
      <dd className="mt-2 text-lg font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}
