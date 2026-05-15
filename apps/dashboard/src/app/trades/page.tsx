'use client';

import { Fragment, useEffect, useState } from 'react';
import type { Trade } from '@cesar-arb/shared';
import { api } from '@/lib/api';
import { fmtUsd, fmtTime } from '@/lib/format';

export default function TradesPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const t = await api.trades(200);
        if (!cancelled) setTrades(t.trades);
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
        <div className="eyebrow">Execution ledger</div>
        <h1 className="mt-2 text-h1 uppercase tracking-tight">Trades</h1>
      </header>

      <div className="card">
        {trades.length === 0 ? (
          <p className="text-sm text-ink-muted">No trades yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-[0.16em] text-ink-subtle">
              <tr>
                <th className="py-2">Time</th>
                <th>Strategy</th>
                <th>Asset</th>
                <th>Mode</th>
                <th className="text-right">Notional</th>
                <th className="text-right">P&amp;L</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {trades.map((t) => (
                <Fragment key={t.id}>
                  <tr>
                    <td className="py-2">{fmtTime(t.openedAt)}</td>
                    <td>{t.strategy}</td>
                    <td className="text-ink-muted">{t.assetClass}</td>
                    <td>
                      <span className={t.mode === 'paper' ? 'pill-gold' : 'pill-danger'}>
                        {t.mode}
                      </span>
                    </td>
                    <td className="text-right">{fmtUsd(t.notionalUsd)}</td>
                    <td className={`text-right font-semibold tabular-nums ${(t.pnlUsd ?? 0) >= 0 ? 'text-accent' : 'text-danger'}`}>
                      {t.pnlUsd === null ? '—' : fmtUsd(t.pnlUsd, { signed: true })}
                    </td>
                    <td>
                      <span className={`pill ${statusTone(t.status)}`}>{t.status}</span>
                    </td>
                    <td>
                      <button
                        onClick={() => setOpen(open === t.id ? null : t.id)}
                        className="text-xs font-semibold uppercase tracking-wider text-accent hover:text-accent-hover"
                      >
                        {open === t.id ? 'Hide' : 'Details'}
                      </button>
                    </td>
                  </tr>
                  {open === t.id && (
                    <tr key={`${t.id}-detail`}>
                      <td colSpan={8} className="bg-white/[0.02] px-4 py-3">
                        <p className="mb-2 text-xs text-ink-muted">Reasoning</p>
                        <p className="mb-3 text-sm">{t.reasoning}</p>
                        <p className="mb-2 text-xs text-ink-muted">Fills</p>
                        <table className="w-full text-xs">
                          <thead className="text-ink-muted">
                            <tr>
                              <th className="text-left">Venue</th>
                              <th className="text-left">Symbol</th>
                              <th>Side</th>
                              <th className="text-right">Qty</th>
                              <th className="text-right">Price</th>
                              <th className="text-right">Fee</th>
                            </tr>
                          </thead>
                          <tbody>
                            {t.fills.map((f, i) => (
                              <tr key={i}>
                                <td>{f.venue}</td>
                                <td>{f.symbol}</td>
                                <td>{f.side}</td>
                                <td className="text-right">{f.qty.toFixed(6)}</td>
                                <td className="text-right">{f.price.toFixed(6)}</td>
                                <td className="text-right text-ink-muted">{fmtUsd(f.feeUsd)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function statusTone(s: Trade['status']): string {
  if (s === 'closed') return 'pill-gold';
  if (s === 'open') return 'pill-mute';
  if (s === 'failed') return 'pill-danger';
  return 'pill-mute';
}
