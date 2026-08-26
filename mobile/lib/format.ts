/**
 * Symbol for an ISO 4217 code, from the platform's own tables.
 *
 * React Native ships a trimmed ICU on some Android builds, so this can return
 * the code itself — never wrong, just less pretty.
 */
function currencySymbol(code: string): string {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency: code })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? code
    );
  } catch {
    return code;
  }
}

/**
 * Formats an amount that arrived from the API as a string.
 *
 * Deliberately identical to web/lib/format.ts. Money never touches a float,
 * even for display: passing the string through Intl.NumberFormat.format()
 * would mean Number("1234.56") first, and the rule in CLAUDE.md is not one to
 * relax at the one place a user reads the figure.
 *
 * `currency` is an ISO code, not a symbol — that is what the hospital stores.
 */
export function money(amount: string, currency = 'GBP'): string {
  const symbol = currencySymbol(currency);
  const negative = amount.startsWith('-');
  const [whole, fraction = '00'] = amount.replace('-', '').split('.');

  // Indian grouping is 2,2,3 — ₹12,34,567.00. A single three-digit rule
  // renders a lakh wrongly for a very large number of users.
  const grouped =
    currency === 'INR'
      ? whole.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,')
      : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '-' : ''}${symbol}${grouped}.${fraction.padEnd(2, '0')}`;
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function date(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "just now" / "4 min ago" — the queue may be cached, so its age matters. */
export function relativeAge(from: Date | null, now: Date = new Date()): string {
  if (!from) return 'never';
  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
