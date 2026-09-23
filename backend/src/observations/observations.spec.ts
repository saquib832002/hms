import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_FREQUENCY,
  FREQUENCY_LABEL,
  FREQUENCY_MINUTES,
  isOverdue,
  isTighter,
  minutesOverdue,
  nextDueAt,
} from './observation-frequency';

/**
 * How closely a patient is watched.
 *
 * THE BUG THIS CLOSES
 * -------------------
 * `OBSERVATION_INTERVAL_HOURS = 4` lived in `wards.service.ts` and the board
 * applied it to every patient in the hospital — somebody four hours
 * post-operative and somebody waiting for a lift home, on the same timer, with
 * nobody able to change it. The single number deciding whether a nurse gets
 * chased about a deteriorating patient was a constant in a source file.
 */

const SERVICE = path.resolve(__dirname, 'observations.service.ts');
const WARDS = path.resolve(__dirname, '..', 'wards', 'wards.service.ts');

/** Comments describe the rules and would match every assertion below. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('observation frequency', () => {
  it('gives every frequency a real interval and a label', () => {
    // A member with no minutes is one the board cannot reason about, and a
    // member with no label reaches a screen as an enum constant.
    for (const key of Object.keys(FREQUENCY_MINUTES)) {
      expect(FREQUENCY_MINUTES[key as keyof typeof FREQUENCY_MINUTES]).toBeGreaterThan(0);
      expect(FREQUENCY_LABEL[key as keyof typeof FREQUENCY_LABEL]).toBeTruthy();
    }
    expect(Object.keys(FREQUENCY_MINUTES).sort()).toEqual(Object.keys(FREQUENCY_LABEL).sort());
  });

  it('has no CONTINUOUS member', () => {
    /*
     * Deliberately absent. "Continuous monitoring" means the patient is on a
     * monitor, which is a different fact from how often somebody writes a set
     * down — and mapping it to a guessed interval would make the board
     * confidently wrong about the sickest patient on the ward.
     */
    expect(Object.keys(FREQUENCY_MINUTES)).not.toContain('CONTINUOUS');
  });

  it('defaults to four-hourly, unchanged from the constant it replaced', () => {
    // Applying this feature must re-time nobody. The default is a floor to be
    // overridden by a doctor, not a recommendation.
    expect(DEFAULT_FREQUENCY).toBe('FOUR_HOURLY');
    expect(FREQUENCY_MINUTES[DEFAULT_FREQUENCY]).toBe(240);
  });

  it('orders tightest to loosest by minutes', () => {
    expect(isTighter('HOURLY', 'FOUR_HOURLY')).toBe(true);
    expect(isTighter('FOUR_HOURLY', 'HOURLY')).toBe(false);
    // Same frequency is not tighter — a nurse "changing" to what it already is
    // must not slip through as an escalation.
    expect(isTighter('FOUR_HOURLY', 'FOUR_HOURLY')).toBe(false);
  });

  describe('overdue', () => {
    const now = new Date('2026-09-04T12:00:00Z');

    it('counts a patient with no observations as overdue', () => {
      /*
       * The case that matters most, not an edge one. Somebody admitted an hour
       * ago whose baseline was never taken is exactly who the board should be
       * shouting about, and reading "no data" as "nothing to worry about" is
       * how they stay invisible.
       */
      expect(isOverdue(null, 'FOUR_HOURLY', now)).toBe(true);
      expect(isOverdue(null, 'DAILY', now)).toBe(true);
    });

    it('measures from the last set against that patient own frequency', () => {
      const threeHoursAgo = new Date(now.getTime() - 3 * 3600_000);
      // Three hours is fine on 4-hourly and long overdue on hourly. One
      // hospital-wide constant could not express both.
      expect(isOverdue(threeHoursAgo, 'FOUR_HOURLY', now)).toBe(false);
      expect(isOverdue(threeHoursAgo, 'HOURLY', now)).toBe(true);
    });

    it('computes when the next set is due', () => {
      const last = new Date('2026-09-04T10:00:00Z');
      expect(nextDueAt(last, 'TWO_HOURLY')?.toISOString()).toBe('2026-09-04T12:00:00.000Z');
      expect(nextDueAt(null, 'TWO_HOURLY')).toBeNull();
    });

    it('reports how late, for ranking a board by who needs seeing first', () => {
      const last = new Date(now.getTime() - 5 * 3600_000);
      expect(minutesOverdue(last, 'FOUR_HOURLY', now)).toBe(60);
      // Not yet due is zero rather than negative — "how overdue" has no
      // meaningful negative, and a negative would sort above genuinely late
      // patients in a naive comparison.
      expect(minutesOverdue(new Date(now.getTime() - 60_000), 'FOUR_HOURLY', now)).toBe(0);
    });
  });
});

describe('who may change the plan', () => {
  const service = strip(readFileSync(SERVICE, 'utf8'));

  it('lets a nurse tighten and refuses to let one relax', () => {
    /*
     * The load-bearing rule. Watching somebody more closely because they look
     * unwell is the entire reason there is a nurse at the bedside and must not
     * wait for a doctor to be found. Deciding somebody needs *less* watching is
     * a judgement about their condition, and getting it wrong is silent —
     * nothing looks broken until the patient is found deteriorated between two
     * sets nobody was asked to take.
     */
    expect(service).toMatch(/isNurse\s*&&\s*!isTighter\(/);
    expect(service).toMatch(/ForbiddenException/);
  });

  it('records which of the two happened', () => {
    // So a chart shows a doctor's plan and a nurse's concern as different
    // things rather than one undifferentiated list of frequency changes.
    expect(service).toMatch(/isEscalation:\s*isNurse/);
  });

  it('never updates an order in place', () => {
    /*
     * Each change is a new row and the newest wins. An update would lose "who
     * moved this patient to hourly obs, and when" — the first question asked
     * after a deterioration nobody caught.
     */
    expect(service).not.toMatch(/observationOrder\.update/);
    expect(service).toMatch(/observationOrder\.create/);
  });
});

describe('escalations', () => {
  const service = strip(readFileSync(SERVICE, 'utf8'));

  it('keeps raising and answering as separate acts', () => {
    /*
     * The gap between them is the finding. An escalation with no response is a
     * nurse who rang somebody and got nothing, which is exactly what a review
     * looks for — writing both in one go once the answer arrives would quietly
     * lose every unanswered call.
     */
    expect(service).toMatch(/raiseEscalation/);
    expect(service).toMatch(/recordResponse/);
    expect(service).toMatch(/respondedAt/);
  });

  it('refuses to overwrite a response that was already recorded', () => {
    expect(service).toMatch(/already been recorded/);
  });
});

describe('the ward board reads the order, not a constant', () => {
  const wards = strip(readFileSync(WARDS, 'utf8'));

  it('no longer carries its own observation interval', () => {
    // The exact constant this work removed. If it comes back, the board has
    // stopped honouring per-patient plans and nothing else would say so.
    expect(wards).not.toMatch(/OBSERVATION_INTERVAL_HOURS/);
  });

  it('uses the shared overdue rule', () => {
    expect(wards).toMatch(/isOverdue\(/);
    expect(wards).toMatch(/observationOrders/);
  });
});
