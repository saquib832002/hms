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
        /**
         * The wordmark, one token per part, used by `Wordmark` and nothing else.
         *
         * WHY THESE ARE THEIR OWN TOKENS AND NOT `primary` / `text` / `danger`
         * -------------------------------------------------------------------
         * The paragraph at the top of this file is the reason: a colour here
         * means exactly one thing. `one` happens to be the same blue as
         * `primary` today, and pointing the wordmark at `primary` would mean
         * retuning the button blue silently restyles the logo — two unrelated
         * decisions welded together. The same argument is sharper for the red:
         * `danger` means "this failed", and a brand mark sharing that token
         * makes the logo read as a warning and a real warning stop standing
         * out.
         *
         * `hms` is `#A4161A`, the same red as the medical cross in the app icon
         * (`cross` in the mobile theme, `BRAND_RED` in `make-icons.mjs`),
         * deliberately darker and less orange than `danger` so the two never
         * sit at the same visual pitch.
         *
         * `brand.spec.ts` asserts all three against the mobile theme, because a
         * wordmark that is one set of colours on a desktop and another on a
         * phone is the drift nobody notices until somebody holds the two side
         * by side — usually in front of a customer.
         */
        brand: {
          one: '#1E6FD9',
          care: '#14181D',
          hms: '#A4161A',
        },
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
