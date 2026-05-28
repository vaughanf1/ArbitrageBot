import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/Nav';
import { Radar } from '@/components/Radar';

export const metadata: Metadata = {
  title: 'NATHAN-I — Live Arbitrage Intelligence',
  description: 'NATHAN-I · multi-venue arbitrage intelligence terminal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
      </head>
      <body>
        <div className="relative min-h-screen overflow-hidden">
          <div className="pointer-events-none fixed -right-40 -top-40 z-0">
            <Radar size={620} dim />
          </div>
          <div className="relative z-10 flex min-h-screen flex-col">
            <Nav />
            <main className="mx-auto flex w-full max-w-[1640px] flex-1 flex-col px-4 py-5 md:px-8 md:py-6">
              {children}
            </main>
            <footer className="mx-auto w-full max-w-[1640px] px-4 pb-4 md:px-8">
              <div className="hairline flex flex-col gap-2 pt-4 text-[11px] uppercase tracking-[0.18em] text-ink-subtle sm:flex-row sm:items-center sm:justify-between">
                <span>NATHAN-I · Institutional arbitrage infrastructure · Paper mode</span>
                <span>BitGet · Polymarket · Kalshi</span>
              </div>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
