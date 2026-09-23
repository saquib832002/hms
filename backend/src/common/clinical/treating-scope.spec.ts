import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ATTENDED, NOT_TREATING, PRESCRIBING_WINDOW_DAYS } from './treating-scope';

/**
 * One rule about who a doctor may write for, in one place.
 *
 * WHAT WENT WRONG
 * ---------------
 * Prescribing and record-writing each carried their own copy of "an
 * appointment with you, today". Two problems, and the second is why this file
 * exists rather than a comment.
 *
 * The rule itself was wrong. A patient rings about a rash that has not
 * settled, or needs another month of the same tablets; that is ordinary
 * practice and had no path through the system. Worse, an admitted patient has
 * no appointment at all, so a doctor could not prescribe for or write about
 * somebody in a bed in their own hospital — and the drug chart is built *from*
 * a prescription, so a newly admitted patient's chart could only ever be
 * filled from an outpatient visit.
 *
 * And two copies drift. This repo has already paid for that: the audit
 * interceptor and the exception filter held separate target extractors, one
 * was wrong for nested routes, and a live run was what found it. Here the
 * drift would be worse than untidy — widening only the prescribing rule gives
 * a doctor the ability to issue a medication and no way to record why.
 */

const SRC = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const PRESCRIPTIONS = strip(SRC('../../prescriptions/prescriptions.service.ts'));
const RECORDS = strip(SRC('../../medical-records/medical-records.service.ts'));

describe('one rule, one place', () => {
  it('is the only definition of the window', () => {
    /*
     * A second `90` beside a date subtraction in either service is the drift
     * this file exists to prevent — it would read as agreeing while being free
     * to stop agreeing.
     */
    for (const service of [PRESCRIPTIONS, RECORDS]) {
      expect(service).not.toMatch(/setDate\(/);
      expect(service).toContain('resolveTreatingScope');
    }
  });

  it('leaves neither service with its own appointment lookup', () => {
    /*
     * The check has to be *gone*, not merely supplemented. A leftover
     * `appointment.findFirst` narrowing on a day range would silently
     * reimpose the old rule underneath the new one, and the symptom would be
     * a refusal that contradicts the error message.
     *
     * Only the lookup is forbidden, not `hospitalDayRange` — these services
     * have every right to ask what "today" means for other reasons, and a
     * test that bans a utility rather than a behaviour is one somebody has to
     * argue with the next time they need it legitimately.
     */
    for (const service of [PRESCRIPTIONS, RECORDS]) {
      expect(service).not.toMatch(/appointment\.findFirst/);
    }
  });

  it('refuses in one wording', () => {
    // Two messages for one rule is how a user learns the rule is two rules.
    for (const service of [PRESCRIPTIONS, RECORDS]) {
      expect(service).toContain('NOT_TREATING');
    }
    expect(NOT_TREATING).toContain(String(PRESCRIBING_WINDOW_DAYS));
  });
});

describe('what counts as an encounter', () => {
  it('does not accept a booking as one', () => {
    /*
     * SCHEDULED absent, and this is the load-bearing one: if a diary entry
     * counted, a doctor could reach any patient in the hospital by having an
     * appointment put in the book, and the relationship check would be
     * decorative. CANCELLED and NO_SHOW are the stronger version — nobody was
     * seen at all.
     */
    expect(ATTENDED).toEqual(['CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']);
  });

  it('counts an open admission, and only an open one', () => {
    const src = strip(SRC('./treating-scope.ts'));
    /*
     * `currentPatientId` is the mirrored column that goes NULL on discharge,
     * so this reads as "in a bed right now". Matching on `patientId` with a
     * status filter would be the same query one refactor away from including
     * every past admission — which is "anyone ever admitted here", a list
     * rather than a relationship.
     */
    expect(src).toContain('currentPatientId');
    expect(src).not.toMatch(/admission\.findFirst\([^)]*patientId:\s*patientId/);
  });

  it('is a window, not a lifetime', () => {
    // Somebody seen once three years ago is not under this doctor's care. The
    // number is a judgement; that there *is* one is the property.
    expect(PRESCRIBING_WINDOW_DAYS).toBeGreaterThan(0);
    expect(PRESCRIBING_WINDOW_DAYS).toBeLessThanOrEqual(365);
  });
});

describe('permitting is wider than linking', () => {
  it('only attaches a prescription to a visit happening today', () => {
    /*
     * A repeat written six weeks later is not part of the consultation it
     * followed from. Attaching it there would put it on that visit's record
     * and — since `Invoice.appointmentId` is unique and billing reads the
     * link — on that visit's bill.
     */
    expect(PRESCRIPTIONS).toMatch(/scope\.sameDay/);
    expect(PRESCRIPTIONS).toMatch(/appointmentId,/);
  });

  it('only attaches a record to a visit happening today', () => {
    // Filing a late note under an old appointment backdates a clinical
    // document — it would appear to have been written at a time it was not.
    expect(RECORDS).toMatch(/scope\.sameDay/);
  });
});
