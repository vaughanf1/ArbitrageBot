import type { DailyReport, StrategyKind, Trade } from '@cesar-arb/shared';

export function buildDailyReport(date: string, trades: Trade[]): DailyReport {
  const closed = trades.filter((t) => t.status === 'closed');
  const totalPnl = closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0).length;
  const winRate = closed.length === 0 ? 0 : wins / closed.length;
  const sortedByPnl = [...closed].sort((a, b) => (b.pnlUsd ?? 0) - (a.pnlUsd ?? 0));
  const bestTrade = sortedByPnl[0] ?? null;
  const worstTrade = sortedByPnl[sortedByPnl.length - 1] ?? null;
  const byStrategyMap = new Map<StrategyKind, { strategy: StrategyKind; trades: number; pnlUsd: number }>();
  for (const t of closed) {
    const cur = byStrategyMap.get(t.strategy) ?? { strategy: t.strategy, trades: 0, pnlUsd: 0 };
    cur.trades += 1;
    cur.pnlUsd += t.pnlUsd ?? 0;
    byStrategyMap.set(t.strategy, cur);
  }
  return {
    date,
    trades,
    totalPnlUsd: totalPnl,
    winRate,
    bestTrade,
    worstTrade,
    byStrategy: [...byStrategyMap.values()].sort((a, b) => b.pnlUsd - a.pnlUsd),
  };
}

export function renderDailyReportHtml(report: DailyReport): string {
  const fmt = (n: number) =>
    `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  const stratRows = report.byStrategy
    .map(
      (s) =>
        `<tr><td>${s.strategy}</td><td style="text-align:right">${s.trades}</td><td style="text-align:right;color:${s.pnlUsd >= 0 ? '#0A84FF' : '#ff453a'}">${fmt(s.pnlUsd)}</td></tr>`,
    )
    .join('');

  const tradeRows = report.trades
    .slice(0, 20)
    .map((t) => {
      const pnl = t.pnlUsd ?? 0;
      const time = new Date(t.openedAt).toISOString().slice(11, 19);
      return `<tr>
        <td>${time}</td>
        <td>${t.strategy}</td>
        <td>${t.assetClass}</td>
        <td style="text-align:right">$${t.notionalUsd.toFixed(0)}</td>
        <td style="text-align:right;color:${pnl >= 0 ? '#0A84FF' : '#ff453a'}">${fmt(pnl)}</td>
        <td>${t.status}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>Cesar Arb Bot — Daily Report ${report.date}</title>
<style>
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
         background: #f5f5f7; color: #1d1d1f; margin: 0; padding: 24px; }
  .card { background: #fff; border-radius: 16px; padding: 24px;
          box-shadow: 0 4px 24px rgba(0,0,0,.04); max-width: 720px; margin: 0 auto 16px; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; }
  .muted { color: #86868b; font-size: 14px; }
  .stat { display: inline-block; margin-right: 32px; }
  .stat .v { font-size: 32px; font-weight: 600; }
  .stat .l { font-size: 12px; color: #86868b; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px 4px; border-bottom: 1px solid #e5e5e7; text-align: left; }
  th { color: #86868b; font-weight: 500; font-size: 12px; text-transform: uppercase; }
</style>
</head><body>
<div class="card">
  <h1>Daily Report</h1>
  <div class="muted">${report.date}</div>
  <div style="margin-top:24px">
    <div class="stat"><div class="l">P&amp;L</div><div class="v" style="color:${report.totalPnlUsd >= 0 ? '#0A84FF' : '#ff453a'}">${fmt(report.totalPnlUsd)}</div></div>
    <div class="stat"><div class="l">Trades</div><div class="v">${report.trades.length}</div></div>
    <div class="stat"><div class="l">Win rate</div><div class="v">${pct(report.winRate)}</div></div>
  </div>
</div>
<div class="card">
  <h2 style="font-size:18px;margin:0 0 12px">By strategy</h2>
  <table><thead><tr><th>Strategy</th><th style="text-align:right">Trades</th><th style="text-align:right">P&amp;L</th></tr></thead>
    <tbody>${stratRows || '<tr><td colspan="3" class="muted">No closed trades.</td></tr>'}</tbody></table>
</div>
<div class="card">
  <h2 style="font-size:18px;margin:0 0 12px">Recent trades</h2>
  <table><thead><tr><th>Time</th><th>Strategy</th><th>Asset</th><th style="text-align:right">Notional</th><th style="text-align:right">P&amp;L</th><th>Status</th></tr></thead>
    <tbody>${tradeRows || '<tr><td colspan="6" class="muted">No trades today.</td></tr>'}</tbody></table>
</div>
</body></html>`;
}

/**
 * Send the daily report via Resend.
 *
 * Returns `skipped` when the email config isn't fully set — that's the
 * default state on first deploy, and the engine should not crash just
 * because the report channel is unconfigured. Once Cesar provides a
 * Resend API key + verified `from` domain, set the three env vars on
 * Railway (RESEND_API_KEY, REPORT_EMAIL_FROM, REPORT_EMAIL_TO) and the
 * next-day report will land in his inbox.
 */
export async function sendDailyReportEmail(opts: {
  report: DailyReport;
  resendKey: string;
  from: string;
  to: string;
}): Promise<{ sent: true; id: string } | { sent: false; reason: string }> {
  if (!opts.resendKey || !opts.from || !opts.to) {
    return { sent: false, reason: 'email config not set (RESEND_API_KEY / REPORT_EMAIL_FROM / REPORT_EMAIL_TO)' };
  }
  const subject = `Cesar Arb Bot — ${opts.report.date} — ${opts.report.totalPnlUsd >= 0 ? '+' : ''}$${opts.report.totalPnlUsd.toFixed(2)} P&L (${opts.report.trades.length} trades)`;
  const html = renderDailyReportHtml(opts.report);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: opts.from, to: opts.to, subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { sent: false, reason: `resend HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const body = (await res.json()) as { id?: string };
  return { sent: true, id: body.id ?? '' };
}
