import { computeQuantity } from './dispense-quantity';

/**
 * The number a pharmacist counts tablets against.
 *
 * The tests that matter most here are the ones asserting a total is
 * *withheld*. A wrong quantity on a dispensing screen is worse than no
 * quantity: the pharmacist stops doing the arithmetic the moment the software
 * appears to have done it, so a confident wrong answer removes the check that
 * would have caught it.
 */

describe('the ordinary case', () => {
  it('turns twice a day for a week into fourteen', () => {
    const q = computeQuantity('1 tablet', 'BD', '7 days');
    expect(q.frequencyLabel).toBe('Twice daily');
    expect(q.durationLabel).toBe('7 days');
    expect(q.totalDoses).toBe(14);
    expect(q.totalUnits).toEqual({ amount: 14, unit: 'tablets' });
    expect(q.whyNot).toBeNull();
  });

  it('multiplies units per dose', () => {
    // Two tablets three times a day for five days is thirty, not fifteen.
    const q = computeQuantity('2 tablets', 'TDS', '5 days');
    expect(q.totalUnits).toEqual({ amount: 30, unit: 'tablets' });
  });

  it('reads weeks and months', () => {
    expect(computeQuantity('1 tab', 'OD', '2 weeks').totalDoses).toBe(14);
    expect(computeQuantity('1 tab', 'OD', '1 month').totalDoses).toBe(30);
  });
});

describe('a bare number is read, and the reading is shown', () => {
  it('reads "2" in the frequency field as a rate', () => {
    /*
     * The field it was typed into is the evidence. A pharmacist seeing
     * "Amoxicillin 500mg · 2 · 7" was doing this inference in their head
     * anyway — the difference is that now it is written down where they can
     * disagree with it.
     */
    const q = computeQuantity('500mg', '2', '7');
    expect(q.frequencyLabel).toBe('2 times daily');
    expect(q.totalDoses).toBe(14);
    expect(q.interpretation).toContain('read as 2× a day');
    expect(q.interpretation).toContain('read as 7 days');
  });

  it('says nothing about tablets when the dosage is a strength', () => {
    /*
     * The one that must not be guessed. "500mg" says nothing about how many
     * capsules make a dose — that is a property of the product on the shelf,
     * which this system does not model. Fourteen *doses* is exact; fourteen
     * *capsules* would be a fabrication that happens to be right for the
     * common case and wrong for a 250mg pack.
     */
    const q = computeQuantity('500mg', 'BD', '7 days');
    expect(q.totalDoses).toBe(14);
    expect(q.totalUnits).toBeNull();
    expect(q.whyNot).toMatch(/countable unit/);
  });

  it('refuses an implausible rate rather than multiplying it out', () => {
    // 12 doses a day is not a frequency, it is a typo or a quantity in the
    // wrong field. Either way the product of it is not a dispensing count.
    expect(computeQuantity('1 tab', '12', '7 days').totalDoses).toBeNull();
  });
});

describe('what it refuses', () => {
  it('withholds a total when the frequency is not a rate', () => {
    const q = computeQuantity('1 tablet', 'as directed', '7 days');
    expect(q.totalDoses).toBeNull();
    expect(q.whyNot).toMatch(/not a recognised rate/);
    // The text the doctor wrote survives — it is still the instruction.
    expect(q.frequencyLabel).toBe('as directed');
  });

  it('withholds a total for PRN, which has no course length', () => {
    /*
     * `parseFrequency` refuses "as needed" on purpose, and that refusal has to
     * carry through here. Multiplying a PRN medicine out to a fixed count
     * states a course the prescriber deliberately did not specify.
     */
    const q = computeQuantity('1 tablet', 'PRN', '7 days');
    expect(q.totalDoses).toBeNull();
  });

  it('withholds a total for an open-ended duration', () => {
    expect(computeQuantity('1 tablet', 'OD', 'ongoing').totalDoses).toBeNull();
    expect(computeQuantity('1 tablet', 'OD', 'until review').totalDoses).toBeNull();
  });

  it('refuses a duration long enough to be a mistake', () => {
    // 999 days is a typo or a "continue indefinitely" note. Printing 999
    // tablets as though it had been considered is the failure mode.
    expect(computeQuantity('1 tablet', 'OD', '999 days').totalDoses).toBeNull();
  });

  it('never returns a fractional count', () => {
    // Half a capsule cannot be handed over, and a decimal in this field would
    // read as precision rather than as a parsing accident.
    for (const dosage of ['1 tablet', '2 caps', '500mg']) {
      const q = computeQuantity(dosage, 'TDS', '10 days');
      if (q.totalUnits) expect(Number.isInteger(q.totalUnits.amount)).toBe(true);
      if (q.totalDoses) expect(Number.isInteger(q.totalDoses)).toBe(true);
    }
  });
});
