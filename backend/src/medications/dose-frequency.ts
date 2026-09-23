/**
 * Turning a prescription's free-text frequency into actual dose times.
 *
 * THE HONEST PROBLEM
 * ------------------
 * `PrescriptionItem.frequency` is a free-text string until Phase 4 gives us a
 * drug catalogue. A doctor types "Once daily", or "BD", or "every 8 hours", or
 * "twice a day with food", or something nobody anticipated.
 *
 * The tempting move is a clever parser that has a go at anything. That is the
 * wrong instinct here: a parser that silently mis-reads "every 8 hours" as
 * once daily produces a drug chart that is confidently wrong, and a nurse
 * following it under-doses a patient. Being wrong is far worse than admitting
 * ignorance.
 *
 * So this recognises a deliberately small set of unambiguous phrasings and
 * returns `null` for everything else. `null` is not a failure — it routes the
 * prescription to a nurse who sets the times by hand, which is what a paper
 * drug chart does anyway. Silence beats a guess.
 */

export interface DoseSchedule {
  /** Doses in 24 hours. */
  timesPerDay: number;
  /** Hours after midnight, hospital-local. */
  hours: number[];
  /** What was matched, for display: "Twice daily (08:00, 20:00)". */
  label: string;
}

/**
 * Standard administration rounds. Real wards run fixed drug rounds rather than
 * spacing doses evenly across the clock — a 6-hourly medicine is not given at
 * 03:00 unless it has to be.
 */
const ROUNDS: Record<number, number[]> = {
  1: [8],
  2: [8, 20],
  3: [8, 14, 20],
  4: [8, 12, 16, 20],
  6: [2, 6, 10, 14, 18, 22],
};

/** Matched against the frequency text, lowercased and whitespace-collapsed. */
const PATTERNS: { test: RegExp; timesPerDay: number; label: string }[] = [
  { test: /^(once|1x|1 x|od|q24h|every 24 ?h(ours?)?)\b/, timesPerDay: 1, label: 'Once daily' },
  { test: /\bonce (a |per )?day\b/, timesPerDay: 1, label: 'Once daily' },
  { test: /\b(twice|2x|2 x|bd|bid)\b/, timesPerDay: 2, label: 'Twice daily' },
  { test: /\btwice (a |per )?day\b/, timesPerDay: 2, label: 'Twice daily' },
  { test: /\b(three times|3x|3 x|tds|tid)\b/, timesPerDay: 3, label: 'Three times daily' },
  { test: /\b(four times|4x|4 x|qds|qid)\b/, timesPerDay: 4, label: 'Four times daily' },
  { test: /\bevery 12 ?h(ours?)?\b/, timesPerDay: 2, label: 'Every 12 hours' },
  { test: /\bevery 8 ?h(ours?)?\b/, timesPerDay: 3, label: 'Every 8 hours' },
  { test: /\bevery 6 ?h(ours?)?\b/, timesPerDay: 4, label: 'Every 6 hours' },
  { test: /\bevery 4 ?h(ours?)?\b/, timesPerDay: 6, label: 'Every 4 hours' },
  { test: /\bq12h\b/, timesPerDay: 2, label: 'Every 12 hours' },
  { test: /\bq8h\b/, timesPerDay: 3, label: 'Every 8 hours' },
  { test: /\bq6h\b/, timesPerDay: 4, label: 'Every 6 hours' },
  { test: /\bq4h\b/, timesPerDay: 6, label: 'Every 4 hours' },
];

/**
 * Phrases that must never be turned into a fixed schedule, even though they
 * contain words the patterns above would otherwise match.
 *
 * "As needed" medicine is given on assessment, not on a timetable. Generating
 * a drug chart row for it would tell a nurse a dose is *due*, which is exactly
 * the opposite of what PRN means, and an overdue-looking row invites giving a
 * medicine the patient did not need.
 */
const NEVER_SCHEDULED = /\b(prn|as needed|as required|when required|if needed|stat|once only)\b/;

/**
 * Is this an "as needed" medicine?
 *
 * Distinct from "the parser could not read it", and the two must not be
 * collapsed even though both come back unscheduled. An unreadable frequency
 * wants a nurse to set the times; a PRN medicine must **never** be given times,
 * because a row saying a dose is *due* is the opposite of what PRN means and
 * invites giving a medicine the patient did not need.
 *
 * So the chart offers different actions for the two, and needs to tell them
 * apart to do it.
 */
export function isAsNeeded(raw: string): boolean {
  return NEVER_SCHEDULED.test(raw.trim().toLowerCase().replace(/\s+/g, ' '));
}

export function parseFrequency(raw: string): DoseSchedule | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  if (NEVER_SCHEDULED.test(text)) return null;

  for (const pattern of PATTERNS) {
    if (pattern.test.test(text)) {
      const hours = ROUNDS[pattern.timesPerDay];
      if (!hours) return null;
      return {
        timesPerDay: pattern.timesPerDay,
        hours,
        label: `${pattern.label} (${hours.map(formatHour).join(', ')})`,
      };
    }
  }
  return null;
}

/** Human-readable reason a frequency could not be scheduled automatically. */
export function whyNotScheduled(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (!text) return 'No frequency was recorded on the prescription.';
  if (NEVER_SCHEDULED.test(text)) {
    return 'Given as needed rather than on a schedule — record each dose as it is given.';
  }
  return 'This frequency was not recognised. Set the dose times manually.';
}

function formatHour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

/**
 * Turns a schedule into concrete due times across a number of days.
 *
 * Doses already in the past on the first day are skipped: a medicine
 * prescribed at 14:00 should not appear as a missed 08:00 dose the moment the
 * chart is created.
 */
export function doseTimesFor(
  schedule: DoseSchedule,
  startFrom: Date,
  days: number,
  toUtc: (parts: { year: number; month: number; day: number; hour: number }) => Date,
  dayOf: (instant: Date) => { year: number; month: number; day: number },
): Date[] {
  const times: Date[] = [];
  const first = dayOf(startFrom);

  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const base = new Date(Date.UTC(first.year, first.month - 1, first.day + dayOffset));
    const day = {
      year: base.getUTCFullYear(),
      month: base.getUTCMonth() + 1,
      day: base.getUTCDate(),
    };
    for (const hour of schedule.hours) {
      const at = toUtc({ ...day, hour });
      if (at.getTime() >= startFrom.getTime()) times.push(at);
    }
  }
  return times;
}
