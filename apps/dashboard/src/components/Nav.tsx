'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const links = [
  { href: '/', label: 'Command' },
  { href: '/opportunities', label: 'Signals' },
  { href: '/trades', label: 'Ledger' },
  { href: '/settings', label: 'Controls' },
];

export function Nav() {
  const pathname = usePathname();
  const [utc, setUtc] = useState('');

  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'UTC',
      });
    setUtc(fmt());
    const id = setInterval(() => setUtc(fmt()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-4 px-4 py-3 md:px-8">
        <Link href="/" className="flex items-center gap-3">
          <span className="relative grid h-8 w-8 place-items-center rounded-md bg-accent-dim">
            <span className="block h-3 w-3 rotate-45 bg-accent" style={{ boxShadow: '0 0 12px rgba(201,162,75,0.7)' }} />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-bold uppercase tracking-[0.18em] text-ink">Cesar Arb</span>
            <span className="block text-[10px] uppercase tracking-[0.22em] text-ink-muted">Arbitrage Intelligence</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {links.map((l) => {
            const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={
                  'rounded-pill px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition-colors ' +
                  (active
                    ? 'bg-accent-dim text-accent'
                    : 'text-ink-muted hover:text-ink')
                }
                style={active ? { boxShadow: 'inset 0 0 0 1px rgba(201,162,75,0.32)' } : undefined}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.16em]">
          <span className="flex items-center gap-2 text-accent">
            <span className="h-1.5 w-1.5 animate-flicker rounded-full bg-accent" style={{ boxShadow: '0 0 8px rgba(201,162,75,0.9)' }} />
            Live
          </span>
          <span className="hidden tabular-nums text-ink-muted md:inline">{utc} UTC</span>
        </div>
      </div>
    </header>
  );
}
