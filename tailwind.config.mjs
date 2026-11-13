import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Semantic colour tokens are driven by CSS variables (see globals.css) so that
 * light "paper & ink" and dark "lamplight" themes swap without `dark:` variants.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
const config = {
  darkMode: 'class',
  content: [
    path.join(__dirname, './src/pages/**/*.{js,ts,jsx,tsx,mdx}'),
    path.join(__dirname, './src/components/**/*.{js,ts,jsx,tsx,mdx}'),
    path.join(__dirname, './src/app/**/*.{js,ts,jsx,tsx,mdx}'),
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', 'Georgia', 'serif'],
        serif: ['var(--font-text)', 'Georgia', 'Cambria', 'serif'],
        sans: [
          'var(--font-ui)',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
      },
      colors: {
        // ---- Semantic literary tokens (preferred) ----
        paper: {
          DEFAULT: token('paper'),
          raised: token('paper-raised'),
          sunken: token('paper-sunken'),
        },
        ink: {
          DEFAULT: token('ink'),
          soft: token('ink-soft'),
          muted: token('ink-muted'),
          faint: token('ink-faint'),
        },
        rule: {
          DEFAULT: token('rule'),
          strong: token('rule-strong'),
        },
        claret: {
          DEFAULT: token('claret'),
          deep: token('claret-deep'),
          wash: token('claret-wash'),
        },
        gilt: {
          DEFAULT: token('gilt'),
          wash: token('gilt-wash'),
        },
        moss: {
          DEFAULT: token('moss'),
          wash: token('moss-wash'),
        },
        inverse: {
          DEFAULT: token('inverse'),
          ink: token('inverse-ink'),
        },
      },
      borderRadius: {
        DEFAULT: '2px',
        md: '2px',
        lg: '3px',
        xl: '3px',
        '2xl': '4px',
      },
      boxShadow: {
        sm: '0 1px 0 rgb(var(--shadow) / 0.04), 0 1px 2px rgb(var(--shadow) / 0.06)',
        md: '0 1px 0 rgb(var(--shadow) / 0.05), 0 8px 24px -12px rgb(var(--shadow) / 0.25)',
        lg: '0 2px 0 rgb(var(--shadow) / 0.04), 0 24px 48px -24px rgb(var(--shadow) / 0.35)',
        '2xl': '0 30px 80px -30px rgb(var(--shadow) / 0.5)',
        book: '0 1px 1px rgb(var(--shadow) / 0.10), 0 10px 18px -10px rgb(var(--shadow) / 0.45)',
      },
      letterSpacing: {
        caps: '0.16em',
        wider: '0.06em',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 420ms cubic-bezier(0.2, 0.7, 0.2, 1) both',
      },
    },
  },
  plugins: [],
};

export default config;
