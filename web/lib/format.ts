/**
 * All times from the API are UTC ISO strings. They are rendered in the
 * hospital's local zone — which for the browser means the user's zone, and
 * staff are physically at the hospital. Never render a raw ISO string to a
 * clinician; "2026-08-12T08:00:00Z" is not a time anyone reads at speed.
 */

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function date(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(iso: string): string {
  return `${date(iso)} · ${time(iso)}`;
}

export function longDate(d: Date = new Date()): string {
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** YYYY-MM-DD in the browser's local zone, for date query params. */
export function isoDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Formats a currency string for display.
 *
 * Takes a string and returns a string — it never converts to a number. The API
 * sends `"1250.00"` precisely so nothing in the client has to, and
 * `Number("1250.00").toLocaleString()` would reintroduce the float the string
 * exists to avoid.
 */
/**
 * Symbol for an ISO 4217 code, from the browser's own tables.
 *
 * Formatting zero and taking the currency part avoids hard-coding a symbol
 * list that would go stale, and gets the right glyph for ₹, ₦, ﷼ and the rest.
 * Falls back to the code itself, which is never wrong — just less pretty.
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
 * STILL NO FLOATS, EVEN FOR DISPLAY
 * ---------------------------------
 * The amount is grouped as text and never converted to a number. Passing it
 * through `Intl.NumberFormat.format()` would mean `Number("1234.56")` first,
 * and the rule in CLAUDE.md — money never touches a float — is not one to
 * relax for the one place a user actually reads the figure.
 *
 * `currency` is an ISO code, not a symbol, because that is what the hospital
 * stores and what the API sends.
 */
export function money(amount: string, currency = 'GBP'): string {
  const symbol = currencySymbol(currency);
  const negative = amount.startsWith('-');
  const [whole, fraction = '00'] = amount.replace('-', '').split('.');

  /*
   * Indian grouping is 2,2,3 — ₹12,34,567.00, not ₹1,234,567.00.
   * A single three-digit rule renders a lakh wrongly for a very large number
   * of users, and it is the sort of wrongness that reads as amateurish rather
   * than as a bug.
   */
  const grouped =
    currency === 'INR'
      ? whole.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,')
      : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '-' : ''}${symbol}${grouped}.${fraction.padEnd(2, '0')}`;
}
