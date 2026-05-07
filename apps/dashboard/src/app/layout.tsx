import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'Cesar Arb Bot',
  description: 'Multi-venue arbitrage dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://rsms.me/inter/inter.css"
        />
      </head>
      <body>
        <div className="min-h-screen">
          <Nav />
          <main className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-12">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
