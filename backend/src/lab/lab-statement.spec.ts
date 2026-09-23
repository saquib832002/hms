import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  formatDateKey,
  groupBy,
  isMonthKey,
  monthAnchor,
  monthLabel,
  nextDay,
  parseDateKey,
  parseMonthKey,
  periodLabel,
} from './lab-statement';

/**
 * A month of referred work, billed as one thing.
 *
 * WHAT WAS REPORTED
 * -----------------
 * "The partner lab should send an invoice to the partner hospital as a
 * collection." A reference laboratory raises an invoice per referral — it has
 * to, because a charge is captured at accession against the prices in force
 * that day — and then posts **one statement a month**, which is what the
 * recipient actually pays. Neither side of this product had that: the
 * laboratory had forty invoices and the hospital had forty notices, and
 * reconciling meant adding a column of figures up by eye.
 *
 * WHAT THIS FILE PROTECTS
 * -----------------------
 * Two things, and the first is the one that matters most.
 *
 * A statement is a document that **leaves the building**. It is posted or
 * emailed to another company and filed by whoever opens it, so no test name may
 * appear anywhere on it — a test name is frequently the clinical question
 * itself, which is why `labSummaryDescription` is built from a count and
 * nothing else and why `PartnerLabCharge` carries `testCount` rather than the
 * tests. The same rule, applied where the blast radius is largest.
 *
 * And the period arithmetic is the hospital's, never UTC's. A referral
 * accessioned at 23:40 on the 30th in Asia/Kolkata is already the 1st in UTC,
 * and bucketing on the stored instant posts it onto the wrong statement — which
 * is the figure somebody reconciles against a bank transfer.
 */

const read = (f: string) => readFileSync(path.join(__dirname, f), 'utf8');
const LAB = read('lab.service.ts');
const DOCUMENTS = readFileSync(
  path.join(__dirname, '../documents/documents.service.ts'),
  'utf8',
);

/** Comments quote the very strings these assertions look for. Strip them. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** One method's body, so a neighbour cannot satisfy an assertion about it. */
function methodBody(src: string, declaration: string): string {
  const start = src.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} is gone — this test is stale`);
  const rest = src.slice(start + declaration.length);
  const next = rest.search(/\n {2}(?:private |public |async |\/\*\*)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe('a month key is a hospital-local period, not an instant', () => {
  it('accepts YYYY-MM and refuses everything else', () => {
    expect(isMonthKey('2026-09')).toBe(true);
    expect(isMonthKey(' 2026-01 ')).toBe(true);
    // 13 is the realistic typo, and a Date would happily roll it into January.
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-00')).toBe(false);
    expect(isMonthKey('2026-9')).toBe(false);
    expect(isMonthKey('September 2026')).toBe(false);
    expect(parseMonthKey('2026-09')).toEqual({ year: 2026, month: 9 });
  });

  it('anchors inside the month for every hospital on earth', () => {
    /*
     * The obvious implementation is midnight on the 1st, and it lands in the
     * *previous* month for every hospital east of Greenwich. Noon on the 15th
     * is inside the 15th at UTC-12 and inside the 16th at UTC+14 — inside the
     * month either way, which is all the anchor has to be.
     */
    const anchor = monthAnchor({ year: 2026, month: 9 });
    for (const offsetHours of [-12, -5, 0, 5.5, 14]) {
      const local = new Date(anchor.getTime() + offsetHours * 3_600_000);
      expect(local.getUTCFullYear()).toBe(2026);
      expect(local.getUTCMonth()).toBe(8);
    }
  });

  it('labels a month the way the printed page says it', () => {
    expect(monthLabel({ year: 2026, month: 9 })).toBe('September 2026');
    expect(monthLabel({ year: 2026, month: 1 })).toBe('January 2026');
    expect(monthLabel({ year: 2026, month: 12 })).toBe('December 2026');
  });

  it('groups without losing or reordering anything', () => {
    const rows = [
      { k: 'a', n: 1 },
      { k: 'b', n: 2 },
      { k: 'a', n: 3 },
    ];
    const grouped = groupBy(rows, (r) => r.k);
    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')!.map((r) => r.n)).toEqual([1, 3]);
  });

  it('resolves the period in the hospital’s own timezone', () => {
    // Not `new Date(...)`, which is UTC and moves a clinic's boundary. Both
    // ends of a range go through `hospitalDayRange`, and a month still goes
    // through `hospitalMonthRange`.
    const body = strip(methodBody(LAB, 'private async statementPeriod('));
    expect(body).toMatch(/zonedTimeToUtc\(from, tz\)/);
    expect(body).toMatch(/zonedTimeToUtc\(nextDay\(to\), tz\)/);
    expect(body).toMatch(/hospitalMonthRange\(anchor, tz\)/);
  });
});

describe('a period is a range of hospital-local days', () => {
  it('accepts a date and refuses one the calendar does not have', () => {
    expect(parseDateKey('2026-09-01')).toEqual({ year: 2026, month: 9, day: 1 });
    expect(parseDateKey(' 2026-12-31 ')).toEqual({ year: 2026, month: 12, day: 31 });

    /*
     * The realistic typo, and the one a bare pattern lets through. `new Date`
     * rolls 2026-02-30 into March — which on a financial period silently moves
     * the boundary by two days and bills somebody for work in another period.
     */
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('2026-04-31')).toBeNull();
    expect(parseDateKey('2026-13-01')).toBeNull();
    expect(parseDateKey('2026-09')).toBeNull();
  });

  it('does not anchor a day the way it anchors a month', () => {
    /*
     * THE BUG THIS TEST FOUND, WRITTEN FIRST AND FAILING.
     *
     * The obvious mirror of `monthAnchor` is noon UTC on the day itself, and
     * it is wrong: at UTC+14 noon on the 15th is 02:00 on the **16th**, so
     * `hospitalDayRange` of it resolves to the following day and a statement
     * silently starts a day late. Mid-month at noon survives ±14 hours because
     * a month is thirty days wide; a single day has no such slack.
     *
     * So there is no day anchor at all — the boundary is constructed with
     * `zonedTimeToUtc`, which is exact at every offset. This asserts the
     * tempting version stayed deleted.
     */
    expect(strip(LAB)).not.toMatch(/dayAnchor/);
    expect(strip(LAB)).toMatch(/const start = zonedTimeToUtc\(from, tz\)/);
    expect(strip(LAB)).toMatch(/const end = zonedTimeToUtc\(nextDay\(to\), tz\)/);
  });

  it('steps to the next day across every kind of boundary', () => {
    expect(nextDay({ year: 2026, month: 9, day: 15 })).toEqual({ year: 2026, month: 9, day: 16 });
    // Month end, year end, and a leap day — the three the arithmetic gets wrong
    // when somebody writes `day + 1` and stops.
    expect(nextDay({ year: 2026, month: 9, day: 30 })).toEqual({ year: 2026, month: 10, day: 1 });
    expect(nextDay({ year: 2026, month: 12, day: 31 })).toEqual({ year: 2027, month: 1, day: 1 });
    expect(nextDay({ year: 2028, month: 2, day: 28 })).toEqual({ year: 2028, month: 2, day: 29 });
    expect(nextDay({ year: 2026, month: 2, day: 28 })).toEqual({ year: 2026, month: 3, day: 1 });
  });

  it('round-trips a date key', () => {
    expect(formatDateKey({ year: 2026, month: 9, day: 1 })).toBe('2026-09-01');
    expect(formatDateKey({ year: 2026, month: 12, day: 31 })).toBe('2026-12-31');
  });
});

describe('the period label is the statement’s identity', () => {
  /*
   * A statement carries **no number**, deliberately — so what identifies it is
   * the laboratory, the hospital and the period. `September 2026` was precise
   * enough while every statement was a month; on a fortnightly agreement two
   * parties disagreeing about which days a bill covers is exactly the failure
   * this label exists to prevent.
   */
  const d = (year: number, month: number, day: number) => ({ year, month, day });

  it('still says the month when the period is one', () => {
    // 1–30 September means September, and a page headed `1–30 September 2026`
    // invites the reader to wonder what happened to the 31st.
    expect(periodLabel(d(2026, 9, 1), d(2026, 9, 30), true)).toBe('September 2026');
  });

  it('names both days inside one month', () => {
    expect(periodLabel(d(2026, 9, 1), d(2026, 9, 15), false)).toBe('1–15 September 2026');
  });

  it('names both months across a boundary, and the year once', () => {
    expect(periodLabel(d(2026, 9, 26), d(2026, 10, 2), false)).toBe(
      '26 September – 2 October 2026',
    );
  });

  it('repeats the year only when it changes', () => {
    expect(periodLabel(d(2026, 12, 28), d(2027, 1, 3), false)).toBe(
      '28 December 2026 – 3 January 2027',
    );
  });

  it('collapses a single day rather than repeating it', () => {
    expect(periodLabel(d(2026, 9, 15), d(2026, 9, 15), false)).toBe('15 September 2026');
  });
});

describe('a statement refuses rather than truncating', () => {
  it('fetches one more row than it will show', () => {
    /*
     * Every statement query had `take: 2000` and nothing said when it bit. A
     * period wide enough to exceed it produced a page that looked complete with
     * a total short by whatever was cut — a wrong number on a financial
     * document that a reader has no way to spot. Survivable while a period was
     * always a month; a range picker makes "the last two years" one click away.
     *
     * The `+ 1` is what distinguishes a full page from an overflowing one:
     * asking for exactly the cap and getting it says nothing about what came
     * after.
     */
    const matches = strip(LAB).match(/take: LabService\.MAX_STATEMENT_LINES \+ 1/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect(strip(LAB)).not.toMatch(/take: 2000/);
  });

  it('refuses with the figure and a period somebody can narrow', () => {
    const body = strip(methodBody(LAB, 'private refuseOversizedPeriod('));
    expect(body).toMatch(/BadRequestException/);
    expect(body).toMatch(/MAX_STATEMENT_LINES/);
    // Named with the period, so the message points at the thing to change.
    expect(body).toMatch(/\$\{label\}/);
  });

  it('checks before it shapes, on every reader', () => {
    for (const declaration of [
      'async statements(',
      'async statement(',
      'async partnerStatements(',
    ]) {
      expect(strip(methodBody(LAB, declaration))).toMatch(/refuseOversizedPeriod\(/);
    }
  });
});

describe('both ends of a range travel together', () => {
  it('refuses one without the other rather than guessing a boundary', () => {
    /*
     * "From there until today" and "the start of that month" are both plausible
     * and neither was chosen by the person about to send a bill.
     */
    const body = strip(methodBody(LAB, 'private async statementPeriod('));
    expect(body).toMatch(/!period\.from \|\| !period\.to[\s\S]{0,160}BadRequestException/);
  });

  it('refuses a period that ends before it starts', () => {
    // Named rather than silently swapped: somebody who typed the dates the
    // wrong way round should see that, not a statement they did not ask for.
    expect(strip(methodBody(LAB, 'private async statementPeriod('))).toMatch(
      /end <= start[\s\S]{0,160}BadRequestException/,
    );
  });

  it('sends the resolved boundaries back, even for a month', () => {
    // One shape for a client to hold and to send when it asks for the printed
    // page — a month comes back as its first and last day like anything else.
    const body = strip(methodBody(LAB, 'private async statementPeriod('));
    expect(body).toMatch(/from: formatDateKey\(hospitalDate\(start, tz\)\)/);
    expect(body).toMatch(/from: formatDateKey\(from\)/);
  });
});

describe('a statement names counts, never tests', () => {
  it.each([['async statements('], ['async statement(']])(
    'selects no test name in %s',
    (declaration) => {
      const body = strip(methodBody(LAB, declaration));
      /*
       * `_count` is the whole point: the shape a laboratory may send another
       * company is how many tests, not which. Selecting `items` — even to count
       * them in JavaScript — puts `testName` one careless spread away from the
       * response, and this is the response that gets printed and posted.
       */
      expect(body).toMatch(/_count: \{ select: \{ items: true \} \}/);
      expect(body).not.toMatch(/testName/);
      expect(body).not.toMatch(/items: \{ select/);
    },
  );

  it('prints no test name on the page either', () => {
    const body = strip(methodBody(DOCUMENTS, 'async labStatementPdf('));
    expect(body).not.toMatch(/testName/);
    // A count is what each line carries, beside the two specimen numbers.
    expect(body).toMatch(/String\(l\.tests\)/);
  });

  it('prints no patient on the page', () => {
    /*
     * Absent for a stronger reason than the test names. Under ORIGIN_PAYS the
     * referring hospital already knows whose sample it was — they drew it — so
     * a name buys nothing and puts a patient onto a document that travels by
     * post.
     */
    const body = strip(methodBody(DOCUMENTS, 'async labStatementPdf('));
    expect(body).not.toMatch(/patient/i);
  });

  it('carries both accessions on every line', () => {
    // Ours keys our own records; theirs is the only number the recipient can
    // match to anything. A statement quoting only the issuer's numbers is one
    // the payer has to telephone about.
    const body = strip(methodBody(DOCUMENTS, 'async labStatementPdf('));
    expect(body).toMatch(/l\.sourceAccession/);
    expect(body).toMatch(/l\.accession/);
  });
});

describe('the arithmetic is the one the rest of billing uses', () => {
  it.each([['async statements('], ['async statement(']])(
    'subtracts credits as well as payments in %s',
    (declaration) => {
      const body = strip(methodBody(LAB, declaration));
      // `total - paid` is the arithmetic that made a refund reopen a balance
      // nobody was chasing. On a statement it would demand money already
      // given back, from another company.
      expect(body).toMatch(/creditedMinor/);
      expect(body).not.toMatch(/totalMinor - paidMinor(?!\s*-)/);
    },
  );

  it('bills only the institution, never work a patient already settled', () => {
    /*
     * Under PATIENT_PAYS the patient pays at this counter and the referring
     * hospital owes nothing, so putting that work on their statement invoices
     * them for money somebody else has already handed over. `patientId: null`
     * is the test that distinguishes the two arrangements, and it is the same
     * one `?payer=institution` uses.
     */
    for (const declaration of ['async statements(', 'async statement(']) {
      expect(strip(methodBody(LAB, declaration))).toMatch(/patientId: null/);
    }
  });
});

describe('settling a month moves no money', () => {
  it('writes no Payment row', () => {
    /*
     * Takings are counted from `Payment`, and this money never passed through
     * a till — it is a bank transfer between two companies. Writing one here
     * would put a number into the day's takings that nobody collected.
     */
    const body = strip(methodBody(LAB, 'async settlePartnerMonth('));
    expect(body).not.toMatch(/payment\./i);
    expect(body).toMatch(/partnerLabCharge\.updateMany/);
  });

  it('is reversible, and leaves rows it did not change alone', () => {
    const body = strip(methodBody(LAB, 'async settlePartnerMonth('));
    // Only rows on the wrong side of the switch are touched, so undoing a
    // month cannot overwrite who settled an individual row, or when.
    expect(body).toMatch(/settledAt: settled \? null : \{ not: null \}/);
    expect(body).toMatch(/settledAt: null, settledById: null, settledNote: null/);
  });

  it('refuses rather than reporting success over nothing', () => {
    // Reporting "settled" while changing no rows is how the original unbilled
    // referral went unnoticed for a month.
    expect(strip(methodBody(LAB, 'async settlePartnerMonth('))).toMatch(
      /rows\.length === 0[\s\S]{0,200}ConflictException/,
    );
  });
});
