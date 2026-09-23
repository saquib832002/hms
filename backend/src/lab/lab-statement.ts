/**
 * A month's work, billed as one thing.
 *
 * WHY A STATEMENT EXISTS AT ALL
 * -----------------------------
 * A reference laboratory raises an invoice per referral — that is what
 * `chargeReferredOrder` does, and it has to, because a charge is captured at
 * accession against the prices in force that day. What it then *sends* the
 * referring hospital is not forty invoices. It is one statement a month, and
 * the hospital pays it as one item.
 *
 * Reported by the product owner from the other side of it: the payable notice
 * arrived per referral, so "what do we owe them" was a column of figures to add
 * up by eye, and there was nothing either party could put in an envelope.
 *
 * DERIVED, NOT STORED
 * -------------------
 * There is no `Statement` table and no migration. A statement over a closed
 * month is completely determined by the invoices already in it, exactly as
 * `Invoice.labAccessions` is determined by its own line descriptions. Storing
 * one would mean a row that has to be kept in step with the invoices it
 * duplicates, and every historical month holding a value nobody generated.
 *
 * The cost is that a statement cannot be *amended* independently of the
 * invoices on it — which is the correct behaviour rather than a limitation. The
 * lab's invoices remain authoritative, and a statement that disagreed with them
 * would be the one thing worse than no statement.
 *
 * IT HAS NO NUMBER, DELIBERATELY
 * ------------------------------
 * The obvious next field is a statement reference, and there is nowhere honest
 * to get one. A number the issuing laboratory invents cannot be looked up by
 * the receiving hospital, whose own records are keyed on the partnership and
 * the month; a number derived from a tenant id would leak one hospital's
 * position in the platform's sequence to another. What identifies a statement
 * is the three facts both sides already hold — **this laboratory, that
 * hospital, that month** — and both screens print exactly those, so the
 * telephone call works without either party quoting an identifier the other
 * cannot resolve.
 *
 * This module imports nothing, so the period arithmetic can be unit-tested
 * without a database and read without a Prisma client to hand.
 */

/** `2026-09` — the only shape either client sends. */
const MONTH_KEY = /^(\d{4})-(\d{2})$/;

export interface MonthKey {
  year: number;
  month: number;
}

export function isMonthKey(value: string): boolean {
  const m = MONTH_KEY.exec(value.trim());
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export function parseMonthKey(value: string): MonthKey | null {
  const m = MONTH_KEY.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * An instant that is unambiguously inside the given hospital-local month.
 *
 * `hospitalMonthRange` takes an instant and answers with that instant's month,
 * which is the right shape for "this month" and the wrong one for "September".
 * Noon UTC on the 15th is inside the 15th in every timezone on earth — the
 * extremes are UTC-12 and UTC+14, so the local time is somewhere between 00:00
 * on the 15th and 02:00 on the 16th — and therefore inside the month wherever
 * the hospital is. Building a date at midnight on the 1st, which is the obvious
 * thing to write, lands in the *previous* month for every hospital east of
 * Greenwich.
 */
export function monthAnchor({ year, month }: MonthKey): Date {
  return new Date(Date.UTC(year, month - 1, 15, 12, 0, 0));
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `September 2026`, for a heading and for the printed page. */
export function monthLabel({ year, month }: MonthKey): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * A period is a **range of hospital-local days**, and a month is one shape of it.
 *
 * WHY THIS STOPPED BEING A MONTH
 * ------------------------------
 * Reported by the product owner: *"Some partner lab may have, as an agreement,
 * a statement every week or every ten days or biweekly."* That is how referral
 * contracts are actually written, and a month-only picker cannot express any of
 * them. A laboratory on a weekly agreement was reduced to reading four weeks of
 * lines and adding up the ones inside the week by eye — the exact work the
 * statement was built to remove, one level in.
 *
 * The month remains the default and the shorthand, because it is the commonest
 * arrangement and it is one parameter rather than two.
 *
 * WHAT A RANGE COSTS, AND WHY IT IS STILL RIGHT
 * ---------------------------------------------
 * Two months cannot overlap; two ranges can. Issue 1–15 and then 1–30 and the
 * same fortnight appears on two statements. That is a real hazard and it is not
 * a reason to refuse ranges — a laboratory on a ten-day cycle has to be able to
 * express a ten-day cycle. It is mitigated where it actually bites: the invoices
 * are authoritative and each carries its own paid state, so a line that was
 * settled off the first statement shows `outstanding` of zero on the second.
 * The recipient pays invoices, not pages.
 *
 * There is deliberately no record of which statements were issued. Storing that
 * would make a `Statement` row the thing to keep in step with the invoices it
 * duplicates — the reason this is derived at all — to buy a warning about
 * something the amounts already answer.
 */
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateKey {
  year: number;
  month: number;
  day: number;
}

export function parseDateKey(value: string): DateKey | null {
  const m = DATE_KEY.exec(value.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  /*
   * The calendar has to agree, not just the digits. `2026-02-30` passes the
   * pattern and every bound above, and `new Date` would roll it into March —
   * which on a financial period silently moves the boundary by two days.
   */
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;

  return { year, month, day };
}

/**
 * The day after this one, on the calendar.
 *
 * WHY THERE IS NO `dayAnchor` HERE
 * --------------------------------
 * The obvious mirror of `monthAnchor` is noon UTC on the day itself, and it is
 * **wrong** — caught by its own test. Noon on the 15th is 02:00 on the *16th*
 * at UTC+14, so `hospitalDayRange` of it resolves to the following day and a
 * statement silently starts a day late. Mid-month at noon survives ±14 hours
 * because a month is thirty days wide; a single day has no such slack, and
 * copying the pattern across is exactly the mistake it invites.
 *
 * So a day boundary is *constructed* rather than anchored: `zonedTimeToUtc`
 * turns a wall-clock date in the hospital's zone into the instant it began, and
 * the end of a range is the start of the day after its last. Both are exact at
 * every offset, and neither depends on a safety margin.
 */
export function nextDay({ year, month, day }: DateKey): DateKey {
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** `2026-09-01`, for sending a resolved boundary back to a client. */
export function formatDateKey({ year, month, day }: DateKey): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * What the period is called, on screen and at the head of the printed page.
 *
 * This is not decoration: a statement has **no number**, deliberately, so what
 * identifies it is the laboratory, the hospital and the period — and the period
 * has to be printed precisely enough for both parties to mean the same days.
 * "September" was sufficient while a period was a month; a fortnight is not.
 *
 * Three shapes, narrowest first, because the shortest true description is the
 * one people quote back correctly:
 *
 *   September 2026                  a whole calendar month
 *   1–15 September 2026             within one month
 *   26 September – 2 October 2026   across a boundary
 *   15 September 2026               a single day
 */
export function periodLabel(from: DateKey, to: DateKey, wholeMonth: boolean): string {
  if (wholeMonth) return monthLabel(from);

  const monthOf = (d: DateKey) => MONTH_NAMES[d.month - 1];

  if (from.year === to.year && from.month === to.month) {
    if (from.day === to.day) return `${from.day} ${monthOf(from)} ${from.year}`;
    return `${from.day}–${to.day} ${monthOf(from)} ${from.year}`;
  }

  // The year is repeated on the left only when it differs, so the commonest
  // cross-boundary case — one month into the next — stays short.
  const left =
    from.year === to.year
      ? `${from.day} ${monthOf(from)}`
      : `${from.day} ${monthOf(from)} ${from.year}`;

  return `${left} – ${to.day} ${monthOf(to)} ${to.year}`;
}

/**
 * Group rows into one entry per counterparty.
 *
 * Written as a fold over an explicit key rather than as a Prisma `groupBy`
 * because the amounts have to be summed in **integer minor units** — a
 * database `sum` over `Decimal` is exact, but the paid and credited columns
 * have to be subtracted from the total in the same pass, and doing that half in
 * SQL and half here is how two screens come to disagree about one month.
 */
export function groupBy<T, K extends string | number>(
  rows: T[],
  key: (row: T) => K,
): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}
