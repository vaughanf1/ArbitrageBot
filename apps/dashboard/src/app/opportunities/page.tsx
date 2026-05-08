'use client';

import { useEffect, useState } from 'react';
import type { Opportunity } from '@cesar-arb/shared';
import { api } from '@/lib/api';
import { fmtUsd, fmtPct, fmtAge } from '@/lib/format';

export default function OpportunitiesPage() {
  const [live, setLive] = useState<Opportunity[]>([]);
  const [recent, setRecent] = useState<Opportunity[]>([]);
  const [candidates, setCandidates] = useState<Opportunity[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [opps, cands] = await Promise.all([api.opportunities(), api.candidates()]);
        if (!cancelled) {
          setLive(opps.live);
          setRecent(opps.recent);
          setCandidates(cands.recent);
        }
      } catch {
        /* ignore */
      }
    }
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-h1">Opportunities</h1>

      <section className="card">
        <h2 className="mb-3 text-lg font-semibold">Tradable now ({live.length})</h2>
        {live.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No opportunities clearing the spread threshold right now. The scan feed below
            shows everything the engine is evaluating, including sub-threshold edges.
          </p>
        ) : (
          <OppTable opps={live} live />
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 text-lg font-semibold">Live scan feed ({candidates.length})</h2>
        <p className="mb-3 text-xs text-ink-muted">
          All evaluated candidates from the last few scans — including those below the spread threshold.
        </p>
        <OppTable opps={candidates.slice(0, 100)} />
      </section>

      <section className="card">
        <h2 className="mb-3 text-lg font-semibold">Tradable history</h2>
        <OppTable opps={recent.slice(0, 50)} />
      </section>
    </div>
  );
}

function OppTable({ opps, live }: { opps: Opportunity[]; live?: boolean }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wider text-ink-muted">
        <tr>
          <th className="py-2">{live ? 'Detected' : 'Time'}</th>
          <th>Strategy</th>
          <th>Description</th>
          <th>Venues</th>
          <th className="text-right">Edge</th>
          <th className="text-right">Est P&amp;L</th>
          <th className="text-right">Size</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-black/5">
        {opps.map((o) => (
          <tr key={o.id}>
            <td className="py-2 text-ink-muted">{fmtAge(o.detectedAt)}</td>
            <td>
              <span className="pill bg-accent-dim text-accent">{o.strategy}</span>
            </td>
            <td className="max-w-md truncate" title={o.description}>{o.description}</td>
            <td className="text-ink-muted">{o.venues.join(', ')}</td>
            <td className="text-right font-medium text-accent">{fmtPct(o.edgePct)}</td>
            <td className="text-right">{fmtUsd(o.estProfitUsd, { signed: true })}</td>
            <td className="text-right text-ink-muted">{fmtUsd(o.sizeUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
