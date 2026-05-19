import type { Config } from 'tailwindcss';

// NATHAN-I "intelligence terminal" theme — gradient dark-blue base with a
// brass-gold accent (per client mockup). Semantic token names are preserved
// (accent, bg, ink, danger, ok) so pages re-skin automatically.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#C9A24B', // brass gold
          hover: '#E3BE6A',
          dim: 'rgba(201,162,75,0.12)',
        },
        gold: {
          DEFAULT: '#C9A24B',
          soft: '#E3BE6A',
        },
        // Dark-blue base. `bg` is the page; `card` / `elevated` are surfaces.
        bg: {
          DEFAULT: '#070B16',
          card: '#0C1322',
          elevated: '#111B2E',
        },
        // Chart-surface blue (the gradient panels in the mockup).
        chart: {
          DEFAULT: '#2E5BD8',
          glow: 'rgba(46,91,216,0.55)',
          ink: '#7FA6F5',
        },
        line: {
          DEFAULT: 'rgba(150,180,255,0.10)',
          gold: 'rgba(201,162,75,0.22)',
        },
        ink: {
          DEFAULT: '#ECE8DF',
          muted: '#8E897C',
          subtle: '#5E5A51',
        },
        danger: '#F2555A',
        ok: '#3FB770',
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      fontSize: {
        base: ['16px', { lineHeight: '24px' }],
        h1: ['24px', { lineHeight: '30px', fontWeight: '600' }],
        hero: ['64px', { lineHeight: '0.95', fontWeight: '800', letterSpacing: '-0.02em' }],
      },
      borderRadius: {
        card: '14px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 0 0 1px rgba(150,180,255,0.06), 0 10px 40px rgba(2,6,18,0.6)',
        cardHover: '0 0 0 1px rgba(201,162,75,0.18), 0 14px 50px rgba(2,6,18,0.7)',
        glow: '0 0 60px rgba(201,162,75,0.16)',
        chart: '0 10px 40px rgba(2,6,18,0.6), inset 0 1px 0 rgba(150,180,255,0.10)',
      },
      keyframes: {
        sweep: {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        ping2: {
          '0%': { transform: 'scale(0.6)', opacity: '0.7' },
          '70%': { transform: 'scale(2.4)', opacity: '0' },
          '100%': { transform: 'scale(2.4)', opacity: '0' },
        },
        flicker: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        sweep: 'sweep 6s linear infinite',
        'sweep-slow': 'sweep 14s linear infinite',
        ping2: 'ping2 3.2s ease-out infinite',
        flicker: 'flicker 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
