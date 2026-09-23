import { ObservationFrequency } from '@prisma/client';

/**
 * How often observations are due, in minutes.
 *
 * WHY A TABLE AND NOT A HARD-CODED CONSTANT
 * -----------------------------------------
 * The ward board computed "observations overdue" from
 * `OBSERVATION_INTERVAL_HOURS = 4` — one clinical policy applied to every
 * patient in the hospital, from somebody four hours post-operative to somebody
 * waiting for a lift home. Nobody could change it, so the single number
 * deciding whether a nurse gets chased about a deteriorating patient was a
 * constant in a source file.
 *
 * NO "CONTINUOUS" MEMBER, DELIBERATELY
 * ------------------------------------
 * Continuous monitoring means the patient is on a monitor. That is a different
 * fact from how often somebody writes a set of numbers down, and mapping it to
 * a guessed interval would make the board confidently wrong about the sickest
 * patient on the ward. Fifteen-minutely is what a paper chart uses for that
 * case, and it is honest about being a charting interval.
 */
export const FREQUENCY_MINUTES: Record<ObservationFrequency, number> = {
  QUARTER_HOURLY: 15,
  HALF_HOURLY: 30,
  HOURLY: 60,
  TWO_HOURLY: 120,
  FOUR_HOURLY: 240,
  SIX_HOURLY: 360,
  TWELVE_HOURLY: 720,
  DAILY: 1440,
};

/** What staff call each one. Sent to both clients so they cannot disagree. */
export const FREQUENCY_LABEL: Record<ObservationFrequency, string> = {
  QUARTER_HOURLY: 'Every 15 minutes',
  HALF_HOURLY: 'Every 30 minutes',
  HOURLY: 'Hourly',
  TWO_HOURLY: '2-hourly',
  FOUR_HOURLY: '4-hourly',
  SIX_HOURLY: '6-hourly',
  TWELVE_HOURLY: '12-hourly',
  DAILY: 'Once daily',
};

/**
 * What a patient is on when nobody has decided.
 *
 * Four-hourly, which is what the hard-coded constant used to be — the default
 * is unchanged behaviour on purpose, so applying this feature does not silently
 * re-time every existing patient's observations. It is a floor to be overridden
 * by a doctor, not a recommendation.
 */
export const DEFAULT_FREQUENCY: ObservationFrequency = 'FOUR_HOURLY';

/**
 * Ordered loosest-to-tightest, so "may a nurse set this?" is a comparison.
 *
 * A nurse may always *tighten* observations — noticing a patient looks unwell
 * and watching them more closely is the entire reason there is a nurse at the
 * bedside. A nurse may never relax them, because deciding somebody needs less
 * watching is a clinical judgement about their condition, and the failure mode
 * is silent: nothing looks wrong until the patient is found deteriorated
 * between two sets nobody was asked to take.
 */
export function isTighter(next: ObservationFrequency, current: ObservationFrequency): boolean {
  return FREQUENCY_MINUTES[next] < FREQUENCY_MINUTES[current];
}

/** When the next set is due after `last`, or `null` if none has been taken. */
export function nextDueAt(last: Date | null, frequency: ObservationFrequency): Date | null {
  if (!last) return null;
  return new Date(last.getTime() + FREQUENCY_MINUTES[frequency] * 60_000);
}

/**
 * Is this patient overdue a set of observations?
 *
 * A patient with **no observations at all** counts as overdue, and that is the
 * important case rather than an edge one: somebody admitted an hour ago whose
 * baseline was never taken is exactly who a board should be shouting about, and
 * treating "no data" as "nothing to worry about" is how they stay invisible.
 */
export function isOverdue(
  last: Date | null,
  frequency: ObservationFrequency,
  now: Date = new Date(),
): boolean {
  if (!last) return true;
  const due = nextDueAt(last, frequency);
  return due !== null && due.getTime() < now.getTime();
}

/** Minutes past due, for sorting the board by who needs seeing first. */
export function minutesOverdue(
  last: Date | null,
  frequency: ObservationFrequency,
  now: Date = new Date(),
): number | null {
  if (!last) return null; // never observed — ranked above everything by the caller
  const due = nextDueAt(last, frequency);
  if (!due) return null;
  return Math.max(0, Math.round((now.getTime() - due.getTime()) / 60_000));
}
