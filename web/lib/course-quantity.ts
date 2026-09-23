/**
 * How many units a course of medicine comes to.
 *
 * WHY THIS IS NOT frequency × duration
 * ------------------------------------
 * That is what this system computed for six phases, and it is wrong whenever a
 * dose is more than one unit. "2 tablets, three times daily, 5 days" is 3 × 5 =
 * 15 by that arithmetic and **30** in the patient's hand — half a course, in
 * the same direction, every time.
 *
 * It was survivable while the number was only a hint somebody had to click. It
 * stops being survivable the moment a field is filled in automatically, because
 * **a prefilled field is trusted and skimmed rather than checked**. So the
 * dosage became part of the sum before the sum was allowed to fill anything in.
 *
 * WHAT IT REFUSES, AND WHY THE REFUSAL IS THE POINT
 * ------------------------------------------------
 * A dosage of "500mg" is a *strength*, not a count — how many capsules make
 * 500mg is a property of the product on the shelf, which this system does not
 * model. "1-2 tablets" is a range, so the total genuinely depends on what the
 * patient takes. In both cases there is no honest single number, and the screen
 * says which part it could not read rather than filling in something plausible.
 *
 * This is the same discipline as `parseFrequency` and `computeQuantity`: a
 * deliberately small set of unambiguous readings, and silence otherwise. The
 * difference — learned the hard way five times on this project — is that a
 * refusal must always leave a human a route. Every caller here keeps an
 * editable field beside the suggestion.
 *
 * TWO NUMBERS, NOT ONE
 * --------------------
 * `doses` is exact whenever the frequency and duration are readable. `units`
 * needs the dosage as well. They are returned separately because they support
 * different claims: "42 doses over the course" is something this system knows,
 * and "42 tablets" is something it only knows for a dosage expressed as a count.
 * Only `units` may ever prefill a quantity box.
 *
 * COPIED, DELIBERATELY
 * --------------------
 * Byte-identical copies live at `web/lib/course-quantity.ts` and
 * `mobile/lib/course-quantity.ts`, because the prescribing screens compute this
 * on every keystroke and a round trip per character is not a thing to build.
 * Same precedent as `mobile/lib/types.ts` and `scripts/audit-replay.js`:
 * duplicated with a drift test that fails the build if the copies diverge
 * (`course-quantity.spec.ts`). This file has **no imports** so that stays
 * possible.
 */

export interface QuantityEstimate {
  /**
   * Units to hand over, or null when the dosage is not expressed as a count.
   * The only field that may prefill a quantity field.
   */
  units: number | null;
  /** Doses across the course, or null when the course has no fixed length. */
  doses: number | null;
  /** Why there is no unit total, in words. Null when `units` is set. */
  reason: string | null;
}

/**
 * Doses in 24 hours, or null for anything not unambiguous.
 *
 * Kept in step with `parseFrequency` in `medications/dose-frequency.ts`,
 * including the refusal to read an as-needed frequency as a rate — a PRN
 * medicine has no course total, and inventing one here would put a number on a
 * prescription for a medicine the patient may never take.
 */
export function dosesPerDay(frequency: string): number | null {
  const text = frequency.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  if (/\b(prn|as needed|as required|when required|if needed|stat|once only)\b/.test(text)) {
    return null;
  }

  if (/^(once|1x|1 x|od|q24h|every 24 ?h(ours?)?)\b/.test(text)) return 1;
  if (/\bonce (a |per )?day\b/.test(text)) return 1;
  if (/\b(twice|2x|2 x|bd|bid)\b/.test(text)) return 2;
  if (/\btwice (a |per )?day\b/.test(text)) return 2;
  if (/\b(three times|3x|3 x|tds|tid)\b/.test(text)) return 3;
  if (/\b(four times|4x|4 x|qds|qid)\b/.test(text)) return 4;
  if (/\b(every 12 ?h(ours?)?|q12h)\b/.test(text)) return 2;
  if (/\b(every 8 ?h(ours?)?|q8h)\b/.test(text)) return 3;
  if (/\b(every 6 ?h(ours?)?|q6h)\b/.test(text)) return 4;
  if (/\b(every 4 ?h(ours?)?|q4h)\b/.test(text)) return 6;
  return null;
}

/** Days in the course, or null when it has no end or cannot be read. */
export function courseDays(duration: string): number | null {
  const text = duration.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  if (/ongoing|as directed|until review|indefinite|continuous|prn|as needed/.test(text)) {
    return null;
  }

  const match = /^(\d+)\s*(day|days|week|weeks|month|months)\b/.exec(text);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0 || value > 365) return null;
  // 30 days to a month, stated rather than assumed: calendar months vary, and
  // for counting tablets a fixed 30 is the convention.
  if (match[2].startsWith('week')) return value * 7;
  if (match[2].startsWith('month')) return value * 30;
  return value;
}

/**
 * Units in a single dose, or null when the dosage does not express a count.
 *
 * "2 tablets" is two, and a bare "2" typed into the dosage field is two,
 * because that is the field it was typed into — the same reasoning
 * `dispense-quantity.ts` uses for a bare number in the frequency field.
 *
 * A strength is refused: "500mg" says nothing about how many capsules make it
 * up, and answering 500 would be catastrophic rather than merely wrong. A range
 * is refused because it has no single answer. A fraction is refused because
 * half a course of tablets is only half a pack if the tablet is scored, which
 * this system does not know.
 */
export function unitsPerDose(dosage: string): number | null {
  const text = dosage.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;

  // "1-2 tablets", "1 to 2 puffs" — the total depends on what is taken.
  if (/\d\s*(-|–|—|to)\s*\d/.test(text)) return null;

  // A strength or a volume, not a count of dispensable units. `%` is matched
  // separately because it is not a word character, so a trailing \b never fires
  // after it — "2%" would otherwise read as two of something.
  if (/\d+(\.\d+)?\s*(mg|mcg|ug|µg|g|kg|ml|l|iu|unit|units)\b/.test(text)) return null;
  if (/\d\s*%/.test(text)) return null;

  const match =
    /^(\d+(?:\.\d+)?)\s*(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|puff|puffs|drop|drops|spray|sprays|sachet|sachets|pessary|pessaries|suppository|suppositories|patch|patches)?\b/.exec(
      text,
    );
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0 || value > 20) return null;
  return value;
}

/**
 * The whole calculation.
 *
 * Returns a `units` number only when the dosage, frequency and duration are all
 * unambiguous. Anything else comes back with `units: null` and a reason naming
 * the part that could not be read, because a prefilled wrong number is worse
 * than an empty box and "we could not tell, and here is why" is something a
 * prescriber can act on.
 */
export function estimateQuantity(
  dosage: string,
  frequency: string,
  duration: string,
): QuantityEstimate {
  const perDay = dosesPerDay(frequency);
  const days = courseDays(duration);
  const doses = perDay !== null && days !== null ? perDay * days : null;

  if (doses === null) {
    return {
      units: null,
      doses: null,
      reason:
        perDay === null
          ? 'No total — the frequency is as-needed, or not one this can read.'
          : 'No total — the course has no fixed length.',
    };
  }

  const perDose = unitsPerDose(dosage);
  if (perDose === null) {
    return {
      units: null,
      doses,
      // Says the half it knows. `doses` is exact; turning it into units needs a
      // fact about the product that is not in this system.
      reason: `${doses} doses over the course — enter how many units that is.`,
    };
  }

  return { units: perDose * doses, doses, reason: null };
}
