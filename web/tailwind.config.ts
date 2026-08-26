import type { Config } from 'tailwindcss';

/**
 * Tokens from docs/ui-design.md §2.
 *
 * Semantic colours mean exactly one thing each. Green is "completed", never
 * "brand green" somewhere else. In a clinical UI, colour ambiguity is a
 * safety problem, not a style preference.
 */
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f7f8fa',
        surface: '#ffffff',
        border: { DEFAULT: '#e3e6ea', strong: '#cfd4da' },
        text: { DEFAULT: '#14181d', muted: '#5b6672', subtle: '#8a939e' },
        primary: { DEFAULT: '#1e6fd9', hover: '#1a5fb8', soft: '#e8f1fd' },
        success: { DEFAULT: '#1a7f47', soft: '#e6f4ec' },
        warning: { DEFAULT: '#b06f00', soft: '#fdf3e2' },
        danger: { DEFAULT: '#c0392b', soft: '#fdecea' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Body is 13px, not 16. This is a dense data tool — 16px body wastes a
        // third of a patient list, and staff scan these all day.
        xxs: ['10.5px', '1.4'],
        xs: ['11.5px', '1.45'],
        sm: ['12px', '1.45'],
        base: ['13px', '1.5'],
        md: ['14px', '1.5'],
        lg: ['16px', '1.4'],
        xl: ['20px', '1.3'],
        '2xl': ['24px', '1.25'],
      },
      borderRadius: { DEFAULT: '6px', sm: '4px' },
    },
  },
  plugins: [],
} satisfies Config;
