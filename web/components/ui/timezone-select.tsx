'use client';

import { useMemo, useState } from 'react';

/**
 * Timezone picker, built from the browser's own IANA database.
 *
 * `Intl.supportedValuesOf('timeZone')` returns the real list — around 420
 * zones — so there is no hard-coded table to fall out of date when a country
 * changes its rules.
 *
 * WHY THERE IS A SEARCH BOX AND A HINT TABLE
 * ------------------------------------------
 * IANA names a zone after a city, and often after the city it was named
 * decades ago. India is `Asia/Calcutta` on most platforms, not `Asia/Kolkata`;
 * Vietnam is `Asia/Saigon`; Ukraine is `Europe/Kiev`. An administrator looking
 * for "India" in an alphabetical list of cities finds nothing and concludes
 * their country is missing — which is exactly what happened here.
 *
 * So the filter matches against country and major-city hints as well as the
 * zone id. The hints are only search terms: the value saved is always the IANA
 * id, and the server validates it against the same database.
 *
 * Abbreviations like CST are excluded, matching the server. They are ambiguous
 * (US Central and China Standard) and, being fixed offsets, ignore daylight
 * saving.
 */

const FALLBACK = [
  'UTC',
  'America/Chicago',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Asia/Calcutta',
  'Asia/Dubai',
  'Australia/Sydney',
];

/**
 * Extra words that should find a zone. Not a country database — just enough
 * that searching for the obvious thing works.
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
  'Asia/Manila': 'Philippines',
  'Asia/Jakarta': 'Indonesia',
  'Europe/London': 'United Kingdom UK England Britain GMT BST',
  'Europe/Dublin': 'Ireland',
  'Europe/Paris': 'France',
  'Europe/Berlin': 'Germany',
  'Europe/Madrid': 'Spain',
  'Europe/Rome': 'Italy',
  'Europe/Amsterdam': 'Netherlands Holland',
  'Europe/Kiev': 'Ukraine Kyiv',
  'Europe/Kyiv': 'Ukraine Kiev',
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
  'Pacific/Auckland': 'New Zealand',
};

function allZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (k: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones?.length) return zones.filter((z) => z.includes('/'));
  } catch {
    // Older browser — fall through.
  }
  return FALLBACK;
}

/** Current offset, so the right "Chicago" is obvious at a glance. */
function offsetLabel(zone: string): string {
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

export function TimezoneSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (zone: string) => void;
  id?: string;
}) {
  const [filter, setFilter] = useState('');

  const zones = useMemo(() => {
    const list = allZones();
    // A saved zone this browser does not list must stay selectable — silently
    // changing a hospital's clock because the browser is old would be worse
    // than showing an unfamiliar entry.
    if (value && !list.includes(value)) list.push(value);
    return list.sort();
  }, [value]);

  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter((z) => {
      const haystack = `${z} ${HINTS[z] ?? ''}`.toLowerCase().replace(/_/g, ' ');
      return haystack.includes(q);
    });
  }, [zones, filter]);

  const grouped = useMemo(() => {
    const byArea = new Map<string, string[]>();
    for (const z of matches) {
      const area = z.split('/')[0];
      byArea.set(area, [...(byArea.get(area) ?? []), z]);
    }
    return [...byArea.entries()];
  }, [matches]);

  return (
    <div className="space-y-1.5">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search country or city — e.g. India, Chicago, London"
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
        aria-label="Filter timezones"
      />
      <select
        id={id}
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        size={filter ? Math.min(8, Math.max(2, matches.length)) : undefined}
      >
        {grouped.map(([area, list]) => (
          <optgroup key={area} label={area}>
            {list.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')} ({offsetLabel(z)})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {filter && matches.length === 0 ? (
        <p className="text-xs text-text-subtle">
          Nothing matches “{filter}”. Zones are named after cities — India is listed as
          Asia/Calcutta on most systems.
        </p>
      ) : null}
      <p className="text-xs text-text-subtle">
        Selected: <span className="font-mono">{value}</span> ({offsetLabel(value)})
      </p>
    </div>
  );
}
