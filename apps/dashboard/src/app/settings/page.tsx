'use client';

import { useEffect, useRef, useState } from 'react';
import type { EngineStatus, RiskLimits } from '@cesar-arb/shared';
import { api } from '@/lib/api';

type FormKey = keyof RiskLimits;

const FIELDS: { key: FormKey; label: string; unit: '$' | '%'; hint: string }[] = [
  { key: 'maxTradeSizeUsd', label: 'Max trade size', unit: '$', hint: 'Largest notional placed on any single opportunity.' },
  { key: 'maxDailyExposureUsd', label: 'Max daily exposure', unit: '$', hint: 'Total notional deployed per day before new trades are blocked.' },
  { key: 'maxDailyLossPct', label: 'Max daily loss', unit: '%', hint: 'Loss vs starting equity that trips the kill switch.' },
  { key: 'trailingStopPct', label: 'Trailing stop', unit: '%', hint: 'How far price can retrace from its peak before exit.' },
  { key: 'minSpreadPct', label: 'Min spread threshold', unit: '%', hint: 'Smallest edge (after fees) the bot will trade.' },
];

export default function SettingsPage() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [form, setForm] = useState<Record<FormKey, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const s = await api.status();
        if (cancelled) return;
        setStatus(s);
        // Seed the form once so the 5s poll never clobbers an in-progress edit.
        if (!seeded.current) {
          seeded.current = true;
          setForm({
            maxTradeSizeUsd: String(s.limits.maxTradeSizeUsd),
            maxDailyExposureUsd: String(s.limits.maxDailyExposureUsd),
            maxDailyLossPct: String(s.limits.maxDailyLossPct),
            trailingStopPct: String(s.limits.trailingStopPct),
            minSpreadPct: String(s.limits.minSpreadPct),
          });
        }
      } catch {
        /* ignore poll errors */
      }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const dirty =
    !!form &&
    !!status &&
    FIELDS.some((f) => Number(form[f.key]) !== status.limits[f.key]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const patch: Partial<RiskLimits> = {};
      for (const f of FIELDS) {
        const v = Number(form[f.key]);
        if (Number.isFinite(v)) patch[f.key] = v;
      }
      const res = await api.updateLimits(patch);
      // Reseed from what the engine actually accepted (it sanitises input).
      setForm({
        maxTradeSizeUsd: String(res.limits.maxTradeSizeUsd),
        maxDailyExposureUsd: String(res.limits.maxDailyExposureUsd),
        maxDailyLossPct: String(res.limits.maxDailyLossPct),
        trailingStopPct: String(res.limits.trailingStopPct),
        minSpreadPct: String(res.limits.minSpreadPct),
      });
      setStatus((s) => (s ? { ...s, limits: res.limits } : s));
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!status) return;
    setForm({
      maxTradeSizeUsd: String(status.limits.maxTradeSizeUsd),
      maxDailyExposureUsd: String(status.limits.maxDailyExposureUsd),
      maxDailyLossPct: String(status.limits.maxDailyLossPct),
      trailingStopPct: String(status.limits.trailingStopPct),
      minSpreadPct: String(status.limits.minSpreadPct),
    });
    setError(null);
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="eyebrow">System controls</div>
        <h1 className="mt-2 text-h1 uppercase tracking-tight">Controls</h1>
      </header>

      <section className="card">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="panel-title">Risk limits</h2>
          <span className="text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
            Mode: {status?.mode ?? '—'}
          </span>
        </div>
        <p className="mb-5 text-sm text-ink-muted">
          Set these to whatever you want — changes apply to the live engine
          immediately and survive a restart. Min-spread and trade-size feed
          straight into the scanners; the rest gate every trade through the
          risk guard.
        </p>

        {!form ? (
          <p className="text-sm text-ink-subtle">Loading current limits…</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="stat-label">{f.label}</span>
                  <span className="relative mt-2 flex items-center">
                    <span className="pointer-events-none absolute left-3 text-sm text-ink-subtle">
                      {f.unit === '$' ? '$' : ''}
                    </span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      min="0"
                      value={form[f.key]}
                      onChange={(e) =>
                        setForm((p) => (p ? { ...p, [f.key]: e.target.value } : p))
                      }
                      className={`w-full rounded-lg border border-line bg-bg-elevated py-2.5 text-base tabular-nums text-ink outline-none focus:border-accent ${
                        f.unit === '$' ? 'pl-7 pr-3' : 'px-3'
                      }`}
                    />
                    {f.unit === '%' && (
                      <span className="pointer-events-none absolute right-3 text-sm text-ink-subtle">
                        %
                      </span>
                    )}
                  </span>
                  <span className="mt-1.5 block text-xs text-ink-muted">{f.hint}</span>
                </label>
              ))}
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button onClick={save} disabled={!dirty || saving} className="btn-primary disabled:opacity-40">
                {saving ? 'Applying…' : 'Apply changes'}
              </button>
              <button onClick={reset} disabled={!dirty || saving} className="btn-ghost disabled:opacity-40">
                Revert
              </button>
              {error && <span className="text-sm text-danger">⚠ {error}</span>}
              {!error && savedAt && !dirty && (
                <span className="text-sm text-ok">
                  ✓ Applied {new Date(savedAt).toLocaleTimeString()} — live now
                </span>
              )}
              {dirty && !saving && (
                <span className="text-sm text-ink-subtle">Unsaved changes</span>
              )}
            </div>
          </>
        )}
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
          v1 ships paper-only. To go live: (1) fund your exchange and
          prediction-market accounts, (2) run{' '}
          <code className="rounded bg-white/[0.05] px-1.5 py-0.5 text-accent">pnpm setup</code> to add API keys,
          (3) set <code className="rounded bg-white/[0.05] px-1.5 py-0.5 text-accent">TRADING_MODE=live</code>, and
          (4) wait at least one week of healthy paper-trade results before flipping the switch.
        </p>
      </section>
    </div>
  );
}
