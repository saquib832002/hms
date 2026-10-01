import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The admin revenue card picks a period, and both clients must pick it the same
 * way.
 *
 * WHAT WAS REPORTED
 * -----------------
 * Two things, by the product owner. *"If it is selected today, then it should
 * show only today's data — but the unpaid amount coming in was from a past
 * month, and the customer may get confused where it is coming from."* And:
 * *"instead of this month, could the customer select a date range, or a month
 * and year."*
 *
 * WHAT THIS FILE PROTECTS
 * -----------------------
 * Three things that a typecheck cannot see and that would each produce a wrong
 * number rather than a broken screen.
 *
 * The **unpaid split**: of what was billed in the period, how much is unpaid,
 * kept apart from everything owed all-time. Collapsing them back is the
 * reported bug; dropping the all-time figure is the opposite error, because
 * last month's unpaid invoice is still money owed today and a clinic looking at
 * *Today* must not conclude it is square.
 *
 * The **shared picker stays shared**. `statement-period.spec.ts` pins the three
 * presets in `components/period-picker.tsx` by name on both clients, so the
 * admin card must consume that component rather than declare its own presets —
 * a second preset array is how two screens come to disagree about which days
 * "last 7 days" covers, and a statement has no number, so the disagreement
 * surfaces as a payment that is short.
 *
 * The **server's resolution is what gets printed**. A preset computes "today"
 * from the device's clock; the server resolves it in the hospital's timezone.
 * Those differ by a day for anybody not sitting in their own clinic, and a
 * screen printing its own guess hides that rather than making it correctable.
 */
const root = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const WEB = read('web/app/(app)/admin/page.tsx');
const MOBILE = read('mobile/app/(tabs)/overview.tsx');
const STREAMS = read('backend/src/admin/revenue-streams.ts');

/** Comments removed, so prose cannot satisfy a matcher. This repo has been caught twice. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CLIENTS: [string, string][] = [
  ['web', WEB],
  ['mobile', MOBILE],
];

describe('the revenue card asks for a period', () => {
  it('found both screens', () => {
    // Vacuous-pass guard. An empty read makes every `not.toMatch` below true
    // while comparing nothing.
    expect(WEB.length).toBeGreaterThan(5_000);
    expect(MOBILE.length).toBeGreaterThan(5_000);
    expect(STREAMS.length).toBeGreaterThan(2_000);
  });

  it.each(CLIENTS)('%s calls the revenue endpoint with the shared period query', (_name, src) => {
    /*
     * One query string, computed once from the screen's single period, and used
     * by every period-driven call. This asserted the inline
     * `periodQuery(period)` while the revenue card held its own period; the
     * card no longer does, and a screen that computed the query twice is how
     * the tiles and the table came to describe different spans.
     */
    const code = strip(src);
    expect(code).toMatch(/const query = periodQuery\(period\)/);
    expect(code).toMatch(/\/admin\/reports\/revenue\$\{query\}/);
  });

  it.each(CLIENTS)('%s reuses the shared picker instead of its own presets', (_name, src) => {
    const code = strip(src);
    expect(code).toMatch(/from '@\/components\/period-picker'/);
    expect(code).toMatch(/<PeriodPicker\b/);
    /*
     * No second preset array. `statement-period.spec.ts` pins the shared one's
     * three labels on both clients; a copy here would drift silently and the
     * person meeting the difference would be an owner comparing two screens.
     */
    expect(code).not.toMatch(/const PRESETS\b/);
  });

  it.each(CLIENTS)('%s prints the period the server resolved, not its own', (_name, src) => {
    /*
     * A preset computes "today" from the device's clock; the server resolves it
     * in the hospital's timezone. Those differ by a day for anybody not sitting
     * in their own clinic, so the label on screen has to be the server's.
     *
     * Either response carries it — the dashboard and the revenue report resolve
     * the same period — so the assertion is "a server-resolved label", not one
     * particular variable, which is what made this go stale.
     */
    const code = strip(src);
    expect(code).toMatch(/(?:dashboard|report)\?\.period\.label/);
    // Never a locally formatted span standing in for it.
    expect(code).not.toMatch(/toLocaleDateString\(\)[\s\S]{0,40}–/);
  });

  it.each(CLIENTS)('%s reaches a whole calendar month without typing dates', (_name, src) => {
    /*
     * The second half of what was asked for. Web uses a native `type="month"`
     * input; mobile steps months with arrows, because a phone has room for one
     * control and "the month before this one" is the move somebody makes. Both
     * derive the range from the chosen year and month rather than from "now",
     * so neither consults the device clock to answer a question about August.
     */
    const code = strip(src);
    expect(code).toMatch(/function monthPeriod\(/);
    expect(code).toMatch(/new Date\(year, month(?: \+ 1)?, 0\)/);
  });

  it('web offers the month as a month input and mobile as steppers', () => {
    expect(strip(WEB)).toMatch(/type="month"/);
    expect(strip(MOBILE)).toMatch(/stepMonth\(-1\)/);
    expect(strip(MOBILE)).toMatch(/stepMonth\(1\)/);
  });
});

describe('unpaid is windowed and owed is not', () => {
  it.each(CLIENTS)('%s renders both figures, distinctly', (_name, src) => {
    const code = strip(src);
    /*
     * Both, and labelled apart. The reported confusion was one figure in a row
     * of period figures that did not move with the period; showing only the
     * windowed one would answer that and lose the number a clinic chases on.
     */
    expect(code).toMatch(/outstandingInPeriod/);
    expect(code).toMatch(/outstandingAllTime/);
  });

  it.each(CLIENTS)('%s says which of the two ignores the period', (_name, src) => {
    // A reader must be able to tell from the screen, not from this file.
    expect(src.toLowerCase()).toMatch(/all time|any period|in total/);
  });

  it('keeps the two as separate fields on the server', () => {
    const code = strip(STREAMS);
    expect(code).toMatch(/outstandingInPeriod:/);
    expect(code).toMatch(/outstandingAllTime:/);
    /*
     * And the windowed one is windowed by *issue date*, which is what makes it
     * belong on a row of period figures: of what we charged then, this much has
     * not arrived.
     */
    expect(code).toMatch(/!range \|\| within\(i\.issuedAt, range\)/);
  });

  it('computes the all-time figure with no range at all', () => {
    // Not "a very wide range", which would be a number that quietly depends on
    // how wide somebody made it.
    const code = strip(STREAMS);
    expect(code).toMatch(/outstandingFor\(members, invoices\)/);
    expect(code).toMatch(/outstandingFor\(members, invoices, period\)/);
  });
});

describe('one period, not three fixed windows', () => {
  it('takes a single range', () => {
    const code = strip(STREAMS);
    expect(code).toMatch(/period: WindowRange,/);
    /*
     * The three fixed windows are gone rather than kept beside the chosen one.
     * Leaving them would mean two ways to ask the same question, and the stale
     * one is what a screen would keep reading.
     */
    expect(code).not.toMatch(/REVENUE_WINDOWS|WindowRanges|sevenDays:|thisMonth:/);
  });

  it('resolves it through the module lab statements use', () => {
    const service = strip(read('backend/src/admin/admin.service.ts'));
    const lab = strip(read('backend/src/lab/lab.service.ts'));
    // One implementation of "which days does this period cover", consumed by
    // both. Two copies produce two screens quoting different totals for the
    // same named period.
    expect(service).toMatch(/resolvePeriod\(/);
    expect(lab).toMatch(/resolvePeriod\(/);
    for (const src of [service, lab]) {
      expect(src).not.toMatch(/zonedTimeToUtc\(/);
    }
  });
});
