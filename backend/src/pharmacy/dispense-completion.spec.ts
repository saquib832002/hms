import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  allItemsComplete,
  canBeSettledByHand,
  completionOf,
  CompletableItem,
} from './dispense-completion';

/**
 * A prescription that has been fully dispensed must be able to say so.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * Reported from use: the pharmacist hands over exactly what was prescribed and
 * the counter still reads PARTIALLY_DISPENSED — permanently, with nothing in
 * the application able to change it.
 *
 * The cause was that **there was no ordered quantity anywhere**. Completion was
 * decided by inferring one from the free-text `frequency` and `duration`:
 *
 *     const needed = suggestQuantity(i.frequency, i.duration);
 *     return needed !== null && i.quantityDispensed >= needed;
 *
 * `suggestQuantity` recognises a deliberately small set of phrasings and
 * returns null for everything else, which is right — guessing at a course
 * length is how a patient goes home with the wrong number of tablets. But that
 * null was then read as "not complete", so any duration the recogniser did not
 * know meant the prescription could never be finished.
 *
 * Same shape as the drug-chart items the parser refused to schedule and no
 * screen could set, and the wards only the seed could create: a deliberate
 * refusal to guess, with no route for a human to supply the answer.
 */

const helper = (over: Partial<CompletableItem> = {}): CompletableItem => ({
  quantityPrescribed: null,
  quantityDispensed: 0,
  frequency: 'Twice daily',
  duration: '7 days',
  ...over,
});

describe('what the prescriber ordered decides completion', () => {
  it('is met exactly when enough has gone out', () => {
    expect(completionOf(helper({ quantityPrescribed: 21, quantityDispensed: 21 }))).toEqual({
      state: 'complete',
      ordered: 21,
    });
  });

  it('reports what is still owed', () => {
    expect(completionOf(helper({ quantityPrescribed: 21, quantityDispensed: 14 }))).toEqual({
      state: 'outstanding',
      ordered: 21,
      remaining: 7,
    });
  });

  it('counts an over-dispense as complete rather than as owing a negative', () => {
    // A split pack or a rounded box. Complete is the honest reading; "owes -3"
    // would sort above genuinely outstanding lines on any screen that ranks them.
    expect(completionOf(helper({ quantityPrescribed: 20, quantityDispensed: 21 })).state).toBe(
      'complete',
    );
  });

  it('beats the inferred course when both exist', () => {
    /*
     * The prescriber said 10; the free text reads as 14. The order wins — it is
     * a fact, and the inference is a reading of somebody's shorthand.
     */
    const item = helper({ quantityPrescribed: 10, quantityDispensed: 10, duration: '7 days' });
    expect(completionOf(item)).toEqual({ state: 'complete', ordered: 10 });
  });
});

describe('the case that was stuck', () => {
  it('no longer traps a fully dispensed prescription at partial', () => {
    /*
     * The exact report. A duration the recogniser cannot read — and before
     * `quantityPrescribed` existed, this meant `needed === null`, `complete`
     * false, forever, however much had been handed over.
     */
    const stuck = helper({
      quantityPrescribed: null,
      quantityDispensed: 21,
      duration: 'until the course finishes',
    });

    expect(completionOf(stuck).state).toBe('unknown');
    expect(allItemsComplete([stuck])).toBe(false);
    // The difference: a human can now settle it.
    expect(canBeSettledByHand([stuck])).toBe(true);
  });

  it('completes on its own once the prescriber states a quantity', () => {
    const ordered = helper({
      quantityPrescribed: 21,
      quantityDispensed: 21,
      duration: 'until the course finishes',
    });
    expect(allItemsComplete([ordered])).toBe(true);
    // Nothing left for a human to decide, so the manual route is withheld.
    expect(canBeSettledByHand([ordered])).toBe(false);
  });
});

describe('an open-ended course', () => {
  it('is unknown rather than complete or outstanding', () => {
    /*
     * PRN and ongoing courses genuinely have no total. Reporting zero
     * outstanding would read on screen as "nothing left to give", which is the
     * opposite of what an open-ended course means.
     */
    expect(completionOf(helper({ duration: 'as directed' })).state).toBe('unknown');
    expect(completionOf(helper({ frequency: 'PRN', duration: 'ongoing' })).state).toBe('unknown');
  });

  it('withholds the automatic verdict even beside completed lines', () => {
    // "We cannot tell about this line" is not "it is finished". Rounding it up
    // would be exactly the confident guess the parser refuses in the first place.
    const items = [
      helper({ quantityPrescribed: 21, quantityDispensed: 21 }),
      helper({ duration: 'as directed', quantityDispensed: 1 }),
    ];
    expect(allItemsComplete(items)).toBe(false);
    expect(canBeSettledByHand(items)).toBe(true);
  });
});

describe('settling by hand is refused where it would hide a shortfall', () => {
  it('is withheld while any line is known to owe something', () => {
    /*
     * The load-bearing refusal. Closing a prescription with a line still owing
     * twenty tablets records a half-filled course as finished — a worse error
     * than leaving it open, and one the patient discovers rather than the
     * pharmacist.
     */
    const items = [
      helper({ quantityPrescribed: 21, quantityDispensed: 7 }),
      helper({ duration: 'as directed' }),
    ];
    expect(canBeSettledByHand(items)).toBe(false);
  });

  it('is withheld when every line already has a total', () => {
    // Nothing for a human to decide: the arithmetic answers it, either way.
    expect(
      canBeSettledByHand([helper({ quantityPrescribed: 21, quantityDispensed: 21 })]),
    ).toBe(false);
  });

  it('is withheld on an empty prescription', () => {
    expect(canBeSettledByHand([])).toBe(false);
    expect(allItemsComplete([])).toBe(false);
  });
});

describe('the service uses the shared rule', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const service = strip(
    readFileSync(path.resolve(__dirname, 'pharmacy.service.ts'), 'utf8'),
  );

  it('no longer decides completion from the inferred course inline', () => {
    /*
     * The exact expression that caused this. If it comes back, prescriptions
     * with unreadable durations start sticking at partial again and nothing
     * else in the suite would say so.
     */
    expect(service).not.toMatch(/needed\s*!==\s*null\s*&&\s*i\.quantityDispensed\s*>=\s*needed/);
    expect(service).toMatch(/allItemsComplete\(items\)/);
  });

  it('refuses to settle a prescription nothing has been dispensed against', () => {
    // Otherwise "mark fully dispensed" takes a prescription out of the queue
    // with nobody having received anything — how one silently goes unfilled.
    expect(service).toMatch(/Nothing has been dispensed against this prescription yet/);
  });
});
