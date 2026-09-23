import { estimateQuantity } from './course-quantity';

/**
 * Is this prescription finished?
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The rule used to be, inline in `dispense()`:
 *
 *     const needed = suggestQuantity(i.frequency, i.duration);
 *     return needed !== null && i.quantityDispensed >= needed;
 *
 * `suggestQuantity` infers a total from the free-text `frequency` and
 * `duration`. It recognises a deliberately small set of phrasings and returns
 * null for everything else — which is right, because guessing at a course
 * length is how a patient goes home with the wrong number of tablets.
 *
 * But that null was then treated as "not complete". So "as directed", "1/52",
 * "until review", "till the course finishes" — anything the recogniser did not
 * know — meant `complete` could never become true, and the prescription stayed
 * PARTIALLY_DISPENSED **forever**, with nothing anywhere in the application
 * able to say otherwise. The pharmacist had handed over exactly what was asked
 * for, the counter said "partially dispensed", and it was going to keep saying
 * that.
 *
 * Same shape as the unscheduled drug chart and the seed-only wards: a
 * deliberate refusal to guess, with no route for a human to supply the answer.
 * A safe refusal that leads nowhere is not safe.
 *
 * THE ORDER OF PREFERENCE, AND WHY
 * --------------------------------
 * 1. **`quantityPrescribed`** — what the prescriber actually ordered. Exact,
 *    no inference, and the only one of the three that is a fact rather than a
 *    reading.
 * 2. **The inferred total**, for rows written before the column existed. Keeps
 *    every prescription already in the database behaving as it did.
 * 3. **Neither** — a genuinely open-ended course. The system cannot know, and
 *    says so, and the pharmacist settles it with an explicit action.
 */
export interface CompletableItem {
  quantityPrescribed: number | null;
  quantityDispensed: number;
  /**
   * Optional only because it arrived after this interface did. Present, it
   * turns "14 doses" into "28 tablets" for a two-tablet dose; absent, the
   * fallback behaves exactly as it did before — see `inferredTotal`.
   */
  dosage?: string;
  frequency: string;
  duration: string;
}

/**
 * The total for a row written before `quantityPrescribed` existed.
 *
 * Prefers units, and **falls back to the dose count rather than to nothing**.
 * That fallback is the old behaviour preserved deliberately: before the dosage
 * was part of this sum, every legacy row was completed against `doses`, and a
 * row created under that reading must keep it. Silently reinterpreting historic
 * prescriptions is the `medicineName`-as-FK trap — today's rule quietly
 * restating what was decided months ago.
 *
 * It under-counts a multi-unit dose, which is the flaw that prompted all of
 * this. It is left in place only for rows that have no ordered quantity at all;
 * everything written since carries one and never reaches here.
 */
function inferredTotal(item: CompletableItem): number | null {
  const estimate = estimateQuantity(item.dosage ?? '', item.frequency, item.duration);
  return estimate.units ?? estimate.doses;
}

export type ItemCompletion =
  /** Enough has gone out to meet what was ordered. */
  | { state: 'complete'; ordered: number }
  /** Some is still owed, and we know how much. */
  | { state: 'outstanding'; ordered: number; remaining: number }
  /**
   * No fixed total exists — PRN, open-ended, or a course written before this
   * column did. Not a failure and not a completion: a question only the person
   * at the counter can answer.
   */
  | { state: 'unknown' };

export function completionOf(item: CompletableItem): ItemCompletion {
  const ordered = item.quantityPrescribed ?? inferredTotal(item);
  if (ordered === null || ordered <= 0) return { state: 'unknown' };

  const remaining = ordered - item.quantityDispensed;
  return remaining <= 0
    ? { state: 'complete', ordered }
    : { state: 'outstanding', ordered, remaining };
}

/**
 * Whether the whole prescription can be called dispensed automatically.
 *
 * Every item must be `complete`. One `unknown` is enough to withhold the
 * verdict, because "we cannot tell about this line" is not "it is finished" —
 * and quietly rounding it up would be the confident-guess failure the parser
 * refuses in the first place.
 *
 * The screens then offer the pharmacist an explicit way to say it is done,
 * which is the half that was missing.
 */
export function allItemsComplete(items: CompletableItem[]): boolean {
  return items.length > 0 && items.every((i) => completionOf(i).state === 'complete');
}

/**
 * Can a human reasonably be asked to settle this?
 *
 * True when nothing is *known* to be outstanding — every line is either met or
 * unmeasurable. Offering "mark fully dispensed" while a line still visibly owes
 * twenty tablets would invite closing a prescription that is genuinely half
 * filled, which is a different and worse error than leaving it open.
 */
export function canBeSettledByHand(items: CompletableItem[]): boolean {
  if (items.length === 0) return false;
  const states = items.map((i) => completionOf(i).state);
  return states.includes('unknown') && !states.includes('outstanding');
}
