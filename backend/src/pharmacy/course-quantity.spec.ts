import { readFileSync } from 'node:fs';
import path from 'node:path';
import { courseDays, dosesPerDay, estimateQuantity, unitsPerDose } from './course-quantity';

/**
 * The arithmetic behind the quantity a prescriber orders.
 *
 * WHY THIS IS TESTED SO HARD FOR SUCH A SMALL SUM
 * -----------------------------------------------
 * It decides how many tablets a patient goes home with, and — since the
 * prescribing screens fill the field in — it is a number most prescribers will
 * accept without recomputing. A prefilled field is trusted and skimmed. So the
 * refusals matter more than the multiplications: this must produce a number
 * only when it is right, and nothing at all the rest of the time.
 */

describe('doses per day', () => {
  it.each([
    ['Once daily', 1],
    ['OD', 1],
    ['once a day', 1],
    ['Twice daily', 2],
    ['BD', 2],
    ['bid', 2],
    ['Three times daily', 3],
    ['TDS', 3],
    ['Four times daily', 4],
    ['QDS', 4],
    ['every 8 hours', 3],
    ['q6h', 4],
    ['every 4 hours', 6],
  ])('reads "%s" as %i a day', (text, expected) => {
    expect(dosesPerDay(text)).toBe(expected);
  });

  it('never reads an as-needed frequency as a rate', () => {
    /*
     * The same refusal `parseFrequency` makes, for a stronger reason here: a
     * PRN medicine may never be taken at all, so any course total is an
     * invention, and it would be dispensed as though it were an order.
     */
    for (const text of ['PRN', 'as needed', 'when required', 'STAT', 'once only']) {
      expect(dosesPerDay(text)).toBeNull();
    }
  });

  it('stays silent on anything it does not recognise', () => {
    for (const text of ['', 'with food', 'alternate days', '1-1-1', 'five times daily']) {
      expect(dosesPerDay(text)).toBeNull();
    }
  });
});

describe('course length', () => {
  it.each([
    ['7 days', 7],
    ['1 day', 1],
    ['2 weeks', 14],
    ['3 months', 90],
    ['  14   DAYS  ', 14],
  ])('reads "%s" as %i days', (text, expected) => {
    expect(courseDays(text)).toBe(expected);
  });

  it('refuses a course with no end', () => {
    for (const text of ['ongoing', 'as directed', 'until review', 'indefinite', 'continuous']) {
      expect(courseDays(text)).toBeNull();
    }
  });

  it('refuses a bare number and an implausible length', () => {
    // "30" could be days, tablets or milligrams. Reading it as days is a guess
    // with a patient's medicine cabinet on the other end.
    expect(courseDays('30')).toBeNull();
    expect(courseDays('9999 days')).toBeNull();
    expect(courseDays('0 days')).toBeNull();
  });
});

describe('units in one dose', () => {
  it.each([
    ['1 tablet', 1],
    ['2 tablets', 2],
    ['1 cap', 1],
    ['2 capsules', 2],
    ['2 puffs', 2],
    ['3 drops', 3],
    ['1 sachet', 1],
    ['2', 2],
  ])('reads "%s" as %i', (text, expected) => {
    expect(unitsPerDose(text)).toBe(expected);
  });

  it('refuses a strength, which is the dangerous case', () => {
    /*
     * The one that would be catastrophic rather than merely wrong. "500mg"
     * read as a count gives 500 × doses, and a basket multiplied out by that
     * is enormous, confident, and would be dispensed by somebody who trusted
     * the box. How many capsules make 500mg is a property of the product on
     * the shelf, and this system does not model it.
     */
    for (const text of ['500mg', '5 ml', '0.5 g', '10 units', '100 mcg', '2%']) {
      expect(unitsPerDose(text)).toBeNull();
    }
  });

  it('refuses a range, because it has no single answer', () => {
    for (const text of ['1-2 tablets', '1 to 2 puffs', '2–3 drops']) {
      expect(unitsPerDose(text)).toBeNull();
    }
  });

  it('refuses a fraction', () => {
    // Half a course of tablets is half a pack only if the tablet is scored.
    expect(unitsPerDose('0.5 tablet')).toBeNull();
    expect(unitsPerDose('half a tablet')).toBeNull();
  });

  it('refuses an implausible count', () => {
    expect(unitsPerDose('0 tablets')).toBeNull();
    expect(unitsPerDose('500 tablets')).toBeNull();
  });
});

describe('the whole estimate', () => {
  it('multiplies all three parts', () => {
    expect(estimateQuantity('1 tablet', 'Twice daily', '7 days').units).toBe(14);
    expect(estimateQuantity('2 tablets', 'Three times daily', '5 days').units).toBe(30);
    expect(estimateQuantity('1 cap', 'Four times daily', '2 weeks').units).toBe(56);
  });

  it('is the bug it was written for', () => {
    /*
     * `timesPerDay × days` — what this system computed for six phases —
     * answers 15. The patient needs 30. Wrong by the dose size, in the same
     * direction, on every multi-unit prescription ever written here.
     */
    const estimate = estimateQuantity('2 tablets', 'Three times daily', '5 days');
    expect(estimate.doses).toBe(15);
    expect(estimate.units).toBe(30);
  });

  it('reports doses without units when the dosage is a strength', () => {
    /*
     * The useful half of what it knows. 14 doses is exact; how many capsules
     * that is depends on the product. Saying so is what lets the screen ask
     * for the one number a human has and the system does not — the difference
     * between a refusal and a dead end, which this project has now got wrong
     * five times.
     */
    const estimate = estimateQuantity('500mg', 'Twice daily', '7 days');
    expect(estimate.units).toBeNull();
    expect(estimate.doses).toBe(14);
    expect(estimate.reason).toContain('14 doses');
  });

  it('gives no doses at all for an open-ended course', () => {
    const prn = estimateQuantity('1 tablet', 'PRN', '30 days');
    expect(prn.units).toBeNull();
    expect(prn.doses).toBeNull();

    const ongoing = estimateQuantity('1 tablet', 'Twice daily', 'ongoing');
    expect(ongoing.units).toBeNull();
    expect(ongoing.doses).toBeNull();
  });

  it('always says why when it produces no number', () => {
    // A blank field and a considered refusal look identical on screen, and only
    // one of them tells the prescriber what to do next.
    for (const [dosage, frequency, duration] of [
      ['500mg', 'Twice daily', '7 days'],
      ['1 tablet', 'PRN', '7 days'],
      ['1 tablet', 'Twice daily', 'ongoing'],
      ['', '', ''],
    ]) {
      const estimate = estimateQuantity(dosage, frequency, duration);
      expect(estimate.units).toBeNull();
      expect(estimate.reason).toBeTruthy();
    }
  });

  it('carries no reason once it has an answer', () => {
    expect(estimateQuantity('1 tablet', 'Twice daily', '7 days').reason).toBeNull();
  });
});

describe('the three copies do not drift', () => {
  /*
   * The prescribing screens compute this on every keystroke, so it cannot be a
   * request, and Metro cannot resolve a shared package without config nobody
   * has run on a device — the same constraint that duplicates `types.ts`.
   *
   * What must not happen is the counter and the prescription sheet showing
   * different numbers for the same line: the pharmacist would be reconciling
   * against a total the doctor never saw. So the copies are byte-identical and
   * this fails the build the moment one of them is edited alone.
   */
  const root = path.resolve(__dirname, '../../..');
  const canonical = readFileSync(path.join(root, 'backend/src/pharmacy/course-quantity.ts'), 'utf8');

  it.each([['web/lib/course-quantity.ts'], ['mobile/lib/course-quantity.ts']])(
    '%s matches the backend copy',
    (relative) => {
      expect(readFileSync(path.join(root, relative), 'utf8')).toBe(canonical);
    },
  );

  it('imports nothing, so the copies stay portable', () => {
    // One import of a backend path is all it takes to make this undistributable
    // and the drift test unsatisfiable.
    expect(canonical).not.toMatch(/^\s*import\s/m);
  });
});
