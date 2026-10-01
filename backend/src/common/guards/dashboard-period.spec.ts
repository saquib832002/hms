import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One period drives the whole dashboard, and the figures that cannot take one
 * say so.
 *
 * WHAT WAS REPORTED
 * -----------------
 * *"You have applied the date range only for the below sections, streams like
 * clinic and laboratory. This should be common to all the dashboards — even top
 * sections where you have zero tests ordered today, kept today, outstanding."*
 *
 * The period control drove the revenue card alone, so the tiles above it
 * reported today while the card below reported August, with nothing on screen
 * saying which was which. The same fault as the unpaid column one change
 * earlier: a figure that does not move with the period, sitting among ones that
 * do, unlabelled.
 *
 * WHAT THIS FILE PROTECTS
 * -----------------------
 * **One period, one query string.** Two controls on one screen are two answers
 * to "which dates", and the reader believes whichever they looked at first. So
 * the screen holds the period and every period-driven call gets the same
 * `periodQuery(period)`.
 *
 * **The split is honest.** Bed occupancy is how many beds are full *now*;
 * "occupancy for last month" would have to mean an average or a peak, which is
 * a different figure wearing the same label. Silently ignoring the dates is the
 * reported bug — and substituting an average would be worse, because a
 * plausible number answering a question nobody asked is the error the finance
 * report was rewritten to fix. So `rightNow` is separate, and both clients head
 * it with the fact that the period does not apply.
 *
 * **No key is named for a window it no longer covers.** `dispensesToday`,
 * `ordersToday`, `collectedLastSevenDays` were all honest when the dashboard
 * reported a fixed window and became false names the moment the period became a
 * parameter. This project has recorded four false names as the cause of a real
 * incident.
 */
const root = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const WEB = read('web/app/(app)/admin/page.tsx');
const MOBILE = read('mobile/app/(tabs)/overview.tsx');
const SERVICE = read('backend/src/admin/admin.service.ts');
const TYPES = read('web/lib/types.ts');

/** Comments removed, so prose cannot satisfy a matcher. Caught three times here. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CLIENTS: [string, string][] = [
  ['web', WEB],
  ['mobile', MOBILE],
];

describe('the period drives the whole dashboard', () => {
  it('found every file', () => {
    // Vacuous-pass guard. An empty read makes every `not.toMatch` below true
    // while comparing nothing.
    for (const src of [WEB, MOBILE, SERVICE, TYPES]) {
      expect(src.length).toBeGreaterThan(5_000);
    }
  });

  it.each(CLIENTS)('%s sends the period to the dashboard as well as the revenue', (_n, src) => {
    const code = strip(src);
    expect(code).toMatch(/\/admin\/dashboard\$\{query\}/);
    expect(code).toMatch(/\/admin\/reports\/revenue\$\{query\}/);
    /*
     * The *same* string, computed once. Two calls to `periodQuery` with two
     * pieces of state is how the tiles and the card came to describe different
     * spans in the first place.
     */
    expect(code).toMatch(/const query = periodQuery\(period\)/);
  });

  it.each(CLIENTS)('%s holds exactly one period, at the top of the screen', (_n, src) => {
    const code = strip(src);
    expect(code.match(/useState<Period \| null>/g) ?? []).toHaveLength(1);
    // And the revenue card takes the resolved report rather than fetching it.
    expect(code).toMatch(/<RevenueStreams report=\{/);
  });

  it.each(CLIENTS)('%s renders both halves of the split', (_n, src) => {
    const code = strip(src);
    expect(code).toMatch(/overPeriod/);
    expect(code).toMatch(/rightNow/);
  });

  it.each(CLIENTS)('%s says on screen that the fixed figures ignore the period', (_n, src) => {
    /*
     * The whole point. A reader must be able to tell from the screen which
     * figures the dates apply to — not from this file, and not by noticing that
     * one number never changes.
     */
    expect(src.toLowerCase()).toMatch(/right now/);
    expect(src.toLowerCase()).toMatch(/whatever period|does not apply|ignores? it/);
  });

  it('splits the response on the server rather than leaving it to the clients', () => {
    /*
     * Comments stripped *before* slicing. The note above `rightNow` explains
     * why occupancy belongs there, so an unstripped `overPeriod` slice contains
     * the word and the assertion below fails against its own documentation —
     * which is how this guard first ran. Fourth time in this repo.
     */
    const body = strip(methodBody(SERVICE, 'async dashboard('));
    expect(body).toMatch(/overPeriod: \{/);
    expect(body).toMatch(/rightNow: \{/);

    const over = body.slice(body.indexOf('overPeriod: {'), body.indexOf('rightNow: {'));
    const fixed = body.slice(body.indexOf('rightNow: {'));

    // Period-scoped things in the period half...
    for (const key of ['activity', 'referralsOut', 'dispenses', 'ordersPlaced']) {
      expect(over).toContain(key);
    }
    // ...and point-in-time things in the other, never both.
    for (const key of ['occupancy', 'staff', 'security', 'catalogue']) {
      expect(fixed).toContain(key);
      expect(over).not.toContain(key);
    }
  });

  it('names no period key for a window it no longer covers', () => {
    /*
     * `dispensesToday` inside a block covering August is a false name, and a
     * false name is what sent three incident reports in this project to the
     * wrong feature. Comments are stripped because the note explaining the
     * rename mentions the old names.
     */
    const body = strip(methodBody(SERVICE, 'async dashboard('));
    const over = body.slice(body.indexOf('overPeriod: {'), body.indexOf('rightNow: {'));
    expect(over).not.toMatch(/Today|LastSevenDays|ThisMonth/);
  });

  it('keeps the denied-requests window fixed, and says why', () => {
    // Deliberately 24 hours and not the chosen period: a spike only means
    // anything against a recent baseline, and "412 denials in August" tells an
    // administrator nothing they can act on today.
    const body = methodBody(SERVICE, 'async dashboard(');
    expect(body).toMatch(/dayAgo/);
    expect(body.slice(body.indexOf('rightNow: {'))).toContain('deniedRequestsLastDay');
  });
});

describe('patients, doctors and where the work went', () => {
  it.each(CLIENTS)('%s shows patients seen and registered', (_n, src) => {
    const code = strip(src);
    expect(code).toMatch(/patientsSeen/);
    expect(code).toMatch(/registered/);
  });

  it.each(CLIENTS)('%s shows billed beside collected per doctor', (_n, src) => {
    /*
     * Payment is deliberately not required before a consultation, so the gap
     * between them is real — and reporting only what was charged is how a
     * clinic mistakes invoices raised for money in the bank.
     */
    const code = strip(src);
    expect(code).toMatch(/\.billed/);
    expect(code).toMatch(/\.collected/);
  });

  it.each(CLIENTS)('%s names no patient on the aggregate', (_n, src) => {
    /*
     * The named drill-down is `GET /admin/reports/consultations`, which carries
     * `ADMIN_CONSULTATION_LEDGER` as its own audit action so "who looked up our
     * patient list, and when" stays answerable. A name rendered straight onto
     * the dashboard would step around that.
     */
    const code = strip(src);
    expect(code).not.toMatch(/activity\.patients\[|\.patientName|patient\.fullName/);
  });

  it.each(CLIENTS)('%s separates each destination, including the unnamed one', (_n, src) => {
    const code = strip(src);
    expect(code).toMatch(/inHouse/);
    expect(code).toMatch(/\.external/);
    expect(code).toMatch(/partners\.map/);
  });

  it.each(CLIENTS)('%s keeps "not ours to charge" apart from "nobody charged"', (_n, src) => {
    /*
     * Under PATIENT_PAYS no line is raised on purpose; an unpriced one is a
     * real loss. A screen that added them together would make every "went out
     * uncharged" figure report the first forever, and people stop reading the
     * figure that catches the second. Third time in this project: blank is not
     * zero for `Medicine.sellingPrice` and `Doctor.consultationFee` either.
     */
    const code = strip(src);
    expect(code).toMatch(/payableElsewhere/);
    expect(code).toMatch(/referredBilling\.unpriced/);
    // Never summed into one figure.
    expect(code).not.toMatch(/payableElsewhere\s*\+\s*[\w.]*unpriced/);
  });

  it('declares the shapes in the shared types, so both clients agree', () => {
    for (const name of [
      'PatientActivity',
      'DoctorActivityRow',
      'DestinationBreakdown',
      'PartnerOwing',
      'ReferralsOut',
    ]) {
      expect(TYPES).toContain(`interface ${name}`);
    }
  });
});

/**
 * The text of one method, so an assertion about `dashboard()` cannot be
 * satisfied by something true of `financeReport()` hundreds of lines below.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`${signature} not found — this guard is asserting nothing`);
  const rest = source.slice(start);
  const end = rest.search(/\n {2}(?:private |public |async |\/\*\*)/);
  return end > 0 ? rest.slice(0, end) : rest;
}
