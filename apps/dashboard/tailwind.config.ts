import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Apple system blue — primary per project visual principles
        accent: {
          DEFAULT: '#0A84FF',
          hover: '#3395FF',
          dim: '#0A84FF22',
        },
        bg: {
          DEFAULT: '#f5f5f7',
          card: '#ffffff',
        },
        ink: {
          DEFAULT: '#1d1d1f',
          muted: '#86868b',
          subtle: '#a1a1a6',
        },
        danger: '#ff453a',
        ok: '#30d158',
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
        h1: ['24px', { lineHeight: '32px', fontWeight: '600' }],
      },
      borderRadius: {
        card: '16px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 4px 24px rgba(0,0,0,.04)',
        cardHover: '0 8px 32px rgba(0,0,0,.06)',
      },
    },
  },
  plugins: [],
};

export default config;
