import { parseFrequency } from '../medications/dose-frequency';

/**
 * How much to actually hand over.
 *
 * THE PROBLEM, STATED PLAINLY
 * ---------------------------
 * A prescription line is four free-text fields: medicine, dosage, frequency,
 * duration. A pharmacist reading "Amoxicillin 500mg · 2 · 7" has to work out
 * that this is probably twice a day for seven days, and therefore fourteen
 * capsules. Reported from use, and it is a real dispensing hazard: mental
 * arithmetic at a counter, under time pressure, from ambiguous input.
 *
 * WHY THIS IS NOT JUST A MULTIPLICATION
 * -------------------------------------
 * The three numbers are not equally trustworthy.
 *
 *   - **Frequency.** "BD", "twice a day", "every 8 hours" are unambiguous.
 *     A bare "2" is *probably* twice a day and could be two tablets. It is
 *     read as a rate here, because that is the field it was typed into — but
 *     the reading is shown to the pharmacist rather than folded silently into
 *     a total.
 *   - **Duration.** "7 days", "1 week", "7" all mean seven days in practice.
 *     Nobody writes a bare number meaning weeks.
 *   - **Dosage.** This is the one that usually cannot be counted. "500mg" is
 *     a strength, not a quantity — how many capsules make 500mg is a property
 *     of the product on the shelf, which this system does not model. Only an
 *     explicit count ("1 tablet", "2 caps") gives units per dose.
 *
 * So the result carries what it *could* work out and says what it could not.
 * Where units per dose is unknown the answer is in **doses**, which is exact,
 * rather than in tablets, which would be a guess with a decimal point of
 * false confidence.
 *
 * Never a silent guess: `whyNot` exists so the UI can say "not calculated"
 * instead of showing nothing, because a blank space and a considered refusal
 * look identical and mean opposite things. That distinction is the same one
 * the counter sale and the referral allergy banner both make.
 */

export interface DispenseQuantity {
  /** e.g. "Twice daily" — the frequency in words, never a bare number. */
  frequencyLabel: string;
  /** e.g. "7 days". */
  durationLabel: string | null;
  /** Doses over the whole course: timesPerDay × days. Exact when both parse. */
  totalDoses: number | null;
  /**
   * Units to hand over, when the dosage names a countable unit.
   * `{ amount: 14, unit: 'tablets' }`.
   */
  totalUnits: { amount: number; unit: string } | null;
  /** Why a total is absent. Null when there is a total. */
  whyNot: string | null;
  /**
   * Shown when the input was a bare number, so a pharmacist can catch a
   * misreading rather than inherit it. Null when nothing was interpreted.
   */
  interpretation: string | null;
}

/** "1 tablet", "2 caps", "1 tab" → a countable dose. "500mg" → null. */
function unitsPerDose(dosage: string): { amount: number; unit: string } | null {
  const m = dosage
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(tablets?|tabs?|capsules?|caps?|puffs?|drops?|sachets?|ml)\b/);
  if (!m) return null;

  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const raw = m[2];
  const unit = raw.startsWith('tab')
    ? 'tablet'
    : raw.startsWith('cap')
      ? 'capsule'
      : raw.replace(/s$/, '');
  return { amount, unit };
}

/** "7 days", "1 week", "2/52", "7" → days. */
function durationInDays(duration: string): number | null {
  const text = duration.trim().toLowerCase();
  if (!text) return null;

  const weeks = text.match(/^(\d+)\s*(weeks?|wks?|\/52)\b/);
  if (weeks) return Number(weeks[1]) * 7;

  const months = text.match(/^(\d+)\s*(months?|\/12)\b/);
  if (months) return Number(months[1]) * 30;

  const days = text.match(/^(\d+)\s*(days?|\/7)?\b/);
  if (days) {
    const n = Number(days[1]);
    // A course longer than a year is far more likely to be a typo or a
    // "continue indefinitely" note than a real duration, and multiplying it
    // out would print an absurd quantity as though it were considered.
    return n > 0 && n <= 365 ? n : null;
  }
  return null;
}

/**
 * A bare integer in the frequency field, read as doses per day.
 *
 * Separate from `parseFrequency`, deliberately. That function feeds the ward
 * drug chart, where a wrong reading tells a nurse to give a dose — so it is
 * right to refuse anything ambiguous. Here the consequence is a suggested
 * count on a screen next to the text the doctor actually wrote, which a
 * pharmacist checks before counting anything out. Different blast radius,
 * different threshold, and the reading is labelled either way.
 */
function bareRate(frequency: string): number | null {
  const m = frequency.trim().match(/^(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 6 ? n : null;
}

export function computeQuantity(
  dosage: string,
  frequency: string,
  duration: string,
): DispenseQuantity {
  const schedule = parseFrequency(frequency);
  const bare = schedule ? null : bareRate(frequency);
  const timesPerDay = schedule?.timesPerDay ?? bare;

  const days = durationInDays(duration);
  const per = unitsPerDose(dosage);

  const interpretation =
    bare !== null || (days !== null && /^\d+$/.test(duration.trim()))
      ? [
          bare !== null ? `"${frequency.trim()}" read as ${bare}× a day` : null,
          /^\d+$/.test(duration.trim()) ? `"${duration.trim()}" read as ${days} days` : null,
        ]
          .filter(Boolean)
          .join(', ')
      : null;

  const frequencyLabel = schedule
    ? // Strip the ward round times: a pharmacy does not care when the doses
      // are given, only how many there are.
      schedule.label.replace(/\s*\(.*\)$/, '')
    : bare !== null
      ? `${bare} times daily`
      : frequency.trim() || '—';

  const durationLabel = days !== null ? `${days} day${days === 1 ? '' : 's'}` : duration.trim() || null;

  if (timesPerDay === null || days === null) {
    return {
      frequencyLabel,
      durationLabel,
      totalDoses: null,
      totalUnits: null,
      whyNot:
        timesPerDay === null
          ? 'Frequency is not a recognised rate, so a quantity cannot be worked out.'
          : 'Duration is not a recognised length, so a quantity cannot be worked out.',
      interpretation,
    };
  }

  const totalDoses = timesPerDay * days;

  return {
    frequencyLabel,
    durationLabel,
    totalDoses,
    totalUnits: per
      ? {
          amount: per.amount * totalDoses,
          unit: `${per.unit}${per.amount * totalDoses === 1 ? '' : 's'}`,
        }
      : null,
    whyNot: per
      ? null
      : // Exact, and honest about what it is exact about.
        'Dosage does not name a countable unit, so this is a dose count rather than a pack count.',
    interpretation,
  };
}
