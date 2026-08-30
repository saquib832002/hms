/**
 * Timezone handling for appointment times.
 *
 * Everything is stored in UTC. "Today's queue" is a question about the
 * hospital's local day, not the server's — a server in UTC and a hospital in
 * Europe/London disagree about which appointments belong to today for one
 * hour of every day in summer, and by more elsewhere. Computing the day
 * boundary naively with `setHours(0,0,0,0)` uses the *server's* zone, which
 * is the bug this module exists to avoid.
 */

interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

/**
 * Wall-clock parts of an instant in a given zone.
 *
 * Exported because booking has to answer "what time does this instant read as
 * on the hospital's clock" — 14:05 is a valid slot in one hospital and off-grid
 * in another, and the answer depends on the hospital's zone, not the server's.
 */
export function zonedParts(
  instant: Date,
  timeZone: string,
): DateParts & { hour: number; minute: number; second: number } {
  return partsIn(instant, timeZone);
}

function partsIn(instant: Date, timeZone: string): DateParts & { hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // Intl renders midnight as "24" in some locales/engines.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Milliseconds the zone is ahead of UTC at this instant (DST-aware). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant.getTime();
}

/** The UTC instant corresponding to a wall-clock time in the hospital's zone. */
export function zonedTimeToUtc(
  parts: DateParts & { hour?: number; minute?: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    0,
    0,
  );
  // Two passes: the offset depends on the instant, and the instant depends on
  // the offset. One correction is enough except exactly at a DST boundary.
  let guess = new Date(naive - offsetMs(new Date(naive), timeZone));
  guess = new Date(naive - offsetMs(guess, timeZone));
  return guess;
}

/** Calendar date in the hospital's zone for a given instant. */
export function hospitalDate(instant: Date, timeZone: string): DateParts {
  const { year, month, day } = partsIn(instant, timeZone);
  return { year, month, day };
}

/**
 * [start, end) covering one hospital-local day.
 * `end` is exclusive — use `lt`, not `lte`, or an appointment at exactly
 * midnight lands in two days at once.
 */
export function hospitalDayRange(instant: Date, timeZone: string): { start: Date; end: Date } {
  const d = hospitalDate(instant, timeZone);
  const start = zonedTimeToUtc(d, timeZone);
  const nextDay = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  const end = zonedTimeToUtc(
    { year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1, day: nextDay.getUTCDate() },
    timeZone,
  );
  return { start, end };
}

/**
 * `YYYY-MM` for the hospital's local month.
 *
 * Revenue is reported by month, and a month is a local idea. A payment taken at
 * 23:30 on the 31st in Asia/Kolkata is already the 1st in UTC — bucketing on the
 * stored instant would move that clinic's takings into the next month, which is
 * exactly the figure someone reconciles against a bank statement.
 */
export function hospitalMonthKey(instant: Date, timeZone: string): string {
  const { year, month } = hospitalDate(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** [start, end) covering one hospital-local calendar month. */
export function hospitalMonthRange(instant: Date, timeZone: string): { start: Date; end: Date } {
  const { year, month } = hospitalDate(instant, timeZone);
  const start = zonedTimeToUtc({ year, month, day: 1 }, timeZone);
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return { start, end: zonedTimeToUtc({ ...next, day: 1 }, timeZone) };
}

/**
 * The last `count` month keys ending with the one containing `instant`, oldest
 * first, along with the instant the window opens at.
 *
 * Generated rather than derived from the rows, so a month with no payments
 * appears as a zero instead of vanishing. A trend with the quiet months missing
 * is not a trend — it reads as though the clinic was busy every month it
 * appears in.
 */
export function recentMonths(
  instant: Date,
  timeZone: string,
  count: number,
): { keys: string[]; start: Date } {
  const { year, month } = hospitalDate(instant, timeZone);
  const keys: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    // Date.UTC normalises an out-of-range month, so month-13 and month-0 roll
    // the year without a special case.
    const d = new Date(Date.UTC(year, month - 1 - back, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const first = new Date(Date.UTC(year, month - count, 1));
  const start = zonedTimeToUtc(
    { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: 1 },
    timeZone,
  );
  return { keys, start };
}

/** Parses a `YYYY-MM-DD` query param into a hospital-local day range. */
export function parseDateParam(value: string | undefined, timeZone: string): { start: Date; end: Date } {
  if (!value) return hospitalDayRange(new Date(), timeZone);

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return hospitalDayRange(new Date(), timeZone);

  const day = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const start = zonedTimeToUtc(day, timeZone);
  const next = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
  const end = zonedTimeToUtc(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
    timeZone,
  );
  return { start, end };
}
