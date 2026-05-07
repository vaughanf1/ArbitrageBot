export function fmtUsd(n: number, opts: { signed?: boolean } = {}): string {
  const abs = Math.abs(n);
  const fixed = abs >= 1000 ? abs.toFixed(0) : abs.toFixed(2);
  const sign = opts.signed ? (n >= 0 ? '+' : '−') : n < 0 ? '−' : '';
  return `${sign}$${fixed}`;
}

export function fmtPct(n: number, digits = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtAge(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
