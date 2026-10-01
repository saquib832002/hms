import { BadRequestException } from '@nestjs/common';
import {
  formatDateKey,
  monthAnchor,
  monthLabel,
  nextDay,
  parseDateKey,
  parseMonthKey,
  periodLabel,
} from '../../lab/lab-statement';
import {
  hospitalDate,
  hospitalMonthKey,
  hospitalMonthRange,
  zonedTimeToUtc,
} from './hospital-time';

/**
 * Resolve `?from=&to=` or `?month=` into a hospital-local range, defaulting to
 * this month.
 *
 * WHY THIS IS A FUNCTION AND NOT A METHOD ON LabService
 * ----------------------------------------------------
 * It was `private async statementPeriod` on `LabService`, which was right while
 * partner statements were the only thing with a period. The admin dashboard now
 * needs the identical resolution, and the alternative was eighty-five lines of
 * timezone boundary arithmetic copied into a second service.
 *
 * That copy is the thing this repo keeps paying for. Two implementations of
 * "which days does this period cover" do not produce a visible formatting
 * difference — they produce two screens quoting different totals for the same
 * named period, and the person who has to explain it is a finance clerk who did
 * nothing wrong. Same reasoning as `resolveAuditTarget`, `resolveTreatingScope`,
 * `course-quantity.ts` and `matchReferralItems`, every one of which became a
 * module for exactly this reason.
 *
 * THREE WAYS TO ASK, AND THE MONTH IS THE SHORTHAND
 * -------------------------------------------------
 * `?from=&to=` is the general form: any span of hospital-local days, which is
 * what referral agreements actually use — weekly, ten-day and fortnightly
 * cycles are all ordinary, and none of them is expressible as a month.
 *
 * `?month=` stays because a calendar month is the commonest arrangement and one
 * parameter is better than two for it. Nothing is lost: it expands to the same
 * range, and the label still reads *September 2026* rather than
 * *1–30 September 2026*, because the shortest true description of a period is
 * the one both parties quote back correctly.
 *
 * Neither: this month, resolved on the server. A client computing "now" a
 * second apart from the server across a month boundary asks for the wrong
 * period, which is why the screens send back what this returns.
 *
 * THE HOSPITAL'S DAYS, NEVER UTC'S
 * --------------------------------
 * A payment taken at 23:40 on the 30th in Asia/Kolkata is already the 1st in
 * UTC, and bucketing on the stored instant puts it in the wrong period — the
 * number somebody reconciles against a bank statement.
 */
export interface PeriodQuery {
  month?: string;
  from?: string;
  to?: string;
}

export interface ResolvedPeriod {
  /** Half-open `[start, end)`, like every range in this system. */
  start: Date;
  end: Date;
  /** The boundaries as `YYYY-MM-DD`, so a client can echo what was used. */
  from: string;
  to: string;
  /** What to print. A whole calendar month reads as the month. */
  label: string;
  /** True when the range is exactly one calendar month in the hospital's zone. */
  wholeMonth: boolean;
}

export function resolvePeriod(timeZone: string, period?: PeriodQuery): ResolvedPeriod {
  if (period?.from || period?.to) {
    /*
     * Both or neither. One end of a range is not a range, and guessing the
     * other — "from there until today", "the start of that month" — is a
     * boundary the caller did not choose on a figure about money.
     */
    if (!period.from || !period.to) {
      throw new BadRequestException('A period needs both a start and an end date');
    }

    const from = parseDateKey(period.from);
    const to = parseDateKey(period.to);
    if (!from || !to) {
      throw new BadRequestException(
        `${period.from} to ${period.to} is not a period. Dates look like 2026-09-01`,
      );
    }

    /*
     * Constructed, never anchored. `zonedTimeToUtc` turns a wall-clock date in
     * the hospital's zone into the instant that day began; the end is the start
     * of the day *after* the last one, so the range is [start, end) like every
     * other range here and a payment taken at 23:59 on the final day is inside
     * it.
     *
     * The mirror of `monthAnchor` — noon UTC on the day — is wrong here and its
     * own test caught it: at UTC+14 noon on the 15th is already the 16th. A
     * month has thirty days of slack; a single day has none.
     */
    const start = zonedTimeToUtc(from, timeZone);
    const end = zonedTimeToUtc(nextDay(to), timeZone);

    if (end <= start) {
      // Named rather than silently swapped: somebody who typed the dates the
      // wrong way round should see that, not a total they did not ask for.
      throw new BadRequestException('The period ends before it starts');
    }

    /*
     * A whole calendar month asked for as a range still reads as a month.
     * Somebody picking 1–30 September from the date fields means September, and
     * a heading of *1–30 September 2026* invites the reader to wonder what
     * happened to the 31st.
     */
    const monthRange = hospitalMonthRange(start, timeZone);
    const wholeMonth =
      start.getTime() === monthRange.start.getTime() && end.getTime() === monthRange.end.getTime();

    return {
      start,
      end,
      from: formatDateKey(from),
      to: formatDateKey(to),
      label: periodLabel(from, to, wholeMonth),
      wholeMonth,
    };
  }

  const key = period?.month ? parseMonthKey(period.month) : null;
  if (period?.month && !key) {
    throw new BadRequestException(`${period.month} is not a month. They look like 2026-09`);
  }

  const anchor = key ? monthAnchor(key) : new Date();
  const { start, end } = hospitalMonthRange(anchor, timeZone);
  const resolved = key ?? parseMonthKey(hospitalMonthKey(anchor, timeZone))!;

  /*
   * The resolved boundaries travel back as dates even for a month, so a client
   * has one shape to hold and to send. `end` is exclusive and the last *day* is
   * what a person means, so it steps back one millisecond before being named.
   */
  const lastDay = new Date(end.getTime() - 1);
  return {
    start,
    end,
    from: formatDateKey(hospitalDate(start, timeZone)),
    to: formatDateKey(hospitalDate(lastDay, timeZone)),
    label: monthLabel(resolved),
    wholeMonth: true,
  };
}
