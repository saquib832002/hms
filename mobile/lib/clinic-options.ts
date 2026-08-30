/**
 * Choices for the clinic settings form.
 *
 * A copy of the lists the web settings screen uses. They are presentation, not
 * contract — the server accepts any valid ISO 4217 code and any IANA zone and
 * validates both itself, so these being a shorter list on a phone costs
 * nothing. That is why they are not in `types.ts` under the drift test: the
 * drift test exists for shapes the API returns, and widening it to cover
 * cosmetic lists would make it noisier without making it stricter.
 */

export interface Currency {
  code: string;
  name: string;
}

/**
 * A short list rather than every ISO 4217 code.
 *
 * ~180 currencies exist and a hospital uses exactly one, so an exhaustive
 * picker is all cost and no benefit. Adding one is a one-line change.
 */
export const CURRENCIES: Currency[] = [
  { code: 'GBP', name: 'Pound sterling' },
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'INR', name: 'Indian rupee' },
  { code: 'CAD', name: 'Canadian dollar' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'AED', name: 'UAE dirham' },
  { code: 'SAR', name: 'Saudi riyal' },
  { code: 'PKR', name: 'Pakistani rupee' },
  { code: 'BDT', name: 'Bangladeshi taka' },
  { code: 'LKR', name: 'Sri Lankan rupee' },
  { code: 'NPR', name: 'Nepalese rupee' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'ZAR', name: 'South African rand' },
  { code: 'NGN', name: 'Nigerian naira' },
  { code: 'KES', name: 'Kenyan shilling' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'BRL', name: 'Brazilian real' },
];

/** The symbol a hospital will actually see on its invoices. */
export function symbolFor(code: string): string {
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
 * Timezones.
 *
 * `Intl.supportedValuesOf` is used where the runtime has it, but on Hermes it
 * usually does not exist — so unlike the web picker, the hard-coded list here
 * is the expected path rather than a rare fallback. It is therefore long enough
 * to be genuinely usable, and a zone already saved on the tenant is always
 * added to it: silently changing a hospital's clock because the phone's
 * runtime has a thin ICU build would be far worse than showing one unfamiliar
 * entry.
 */
const COMMON_ZONES = [
  'UTC',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Calcutta',
  'Asia/Colombo',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Jakarta',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kuala_Lumpur',
  'Asia/Manila',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Dublin',
  'Europe/Istanbul',
  'Europe/Kiev',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Europe/Rome',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
];

/**
 * Extra search words per zone.
 *
 * IANA names a zone after a city, and often the city it was named decades ago.
 * India is `Asia/Calcutta` on most platforms, Vietnam is `Asia/Saigon`, Ukraine
 * is `Europe/Kiev`. An administrator searching for "India" in a list of city
 * names finds nothing and concludes their country is missing — which is exactly
 * what happened on the web screen before these hints existed.
 *
 * These are search terms only. The value saved is always the IANA id.
 */
const HINTS: Record<string, string> = {
  'Asia/Calcutta': 'India Kolkata Mumbai Delhi Bengaluru Chennai Hyderabad IST',
  'Asia/Kolkata': 'India Kolkata Mumbai Delhi Bengaluru Chennai Hyderabad IST',
  'Asia/Karachi': 'Pakistan Lahore Islamabad',
  'Asia/Dhaka': 'Bangladesh',
  'Asia/Colombo': 'Sri Lanka',
  'Asia/Kathmandu': 'Nepal',
  'Asia/Saigon': 'Vietnam Ho Chi Minh Hanoi',
  'Asia/Ho_Chi_Minh': 'Vietnam Saigon Hanoi',
  'Asia/Dubai': 'UAE Emirates Abu Dhabi',
  'Asia/Riyadh': 'Saudi Arabia',
  'Asia/Shanghai': 'China Beijing',
  'Asia/Tokyo': 'Japan',
  'Asia/Seoul': 'South Korea',
  'Asia/Singapore': 'Singapore',
  'Asia/Kuala_Lumpur': 'Malaysia',
  'Asia/Manila': 'Philippines',
  'Asia/Jakarta': 'Indonesia',
  'Europe/London': 'United Kingdom UK England Britain GMT BST',
  'Europe/Dublin': 'Ireland',
  'Europe/Paris': 'France',
  'Europe/Berlin': 'Germany',
  'Europe/Madrid': 'Spain',
  'Europe/Lisbon': 'Portugal',
  'Europe/Rome': 'Italy',
  'Europe/Zurich': 'Switzerland',
  'Europe/Warsaw': 'Poland',
  'Europe/Amsterdam': 'Netherlands Holland',
  'Europe/Kiev': 'Ukraine Kyiv',
  'Europe/Moscow': 'Russia',
  'Europe/Istanbul': 'Turkey',
  'America/New_York': 'USA United States Eastern EST EDT',
  'America/Chicago': 'USA United States Central CST CDT Texas Houston Dallas',
  'America/Denver': 'USA United States Mountain MST MDT Colorado',
  'America/Los_Angeles': 'USA United States Pacific PST PDT California',
  'America/Toronto': 'Canada Ontario',
  'America/Vancouver': 'Canada British Columbia',
  'America/Mexico_City': 'Mexico',
  'America/Sao_Paulo': 'Brazil',
  'Africa/Lagos': 'Nigeria',
  'Africa/Cairo': 'Egypt',
  'Africa/Johannesburg': 'South Africa',
  'Africa/Nairobi': 'Kenya',
  'Australia/Sydney': 'Australia NSW',
  'Australia/Melbourne': 'Australia Victoria',
  'Australia/Perth': 'Australia Western',
  'Pacific/Auckland': 'New Zealand',
};

export function timezones(current?: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (k: string) => string[] };
  let list = COMMON_ZONES;
  try {
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones?.length) list = zones.filter((z) => z.includes('/') || z === 'UTC');
  } catch {
    // Thin ICU build — the curated list stands.
  }
  const all = current && !list.includes(current) ? [...list, current] : [...list];
  return all.sort();
}

/** Matches a zone against its id and its country/city hints. */
export function matchesZone(zone: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${zone} ${HINTS[zone] ?? ''}`.toLowerCase().replace(/_/g, ' ').includes(q);
}

/** Current offset, so the right "Chicago" is obvious at a glance. */
export function offsetLabel(zone: string): string {
  try {
    return (
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? ''
    );
  } catch {
    return '';
  }
}
