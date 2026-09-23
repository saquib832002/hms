/**
 * Turn a technician's typed lines into analyte values.
 *
 * WHY THIS IS SHARED RATHER THAN WRITTEN TWICE
 * --------------------------------------------
 * The same typed text must produce the same result whichever client sent it.
 * Two parsers drifting means a partner lab reporting "Haemoglobin: 128 g/L"
 * from a phone and from a desk producing different rows in the ordering
 * hospital's record — and the ordering hospital has no way to tell which
 * happened. Same reasoning as `course-quantity.ts`, and byte-identical copies
 * for the same Metro constraint.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No unit inference, no reference ranges, no flagging. A partner's values cross
 * as *they* issued them and are never recomputed against the ordering
 * hospital's catalogue — re-flagging would be one organisation asserting
 * something about a measurement it did not make.
 */
export interface ParsedValue {
  analyteName: string;
  value: string;
  unit?: string;
}

export function parseLabValues(text: string): ParsedValue[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':');
      // A line with no colon is the whole answer — "No growth after 48 hours".
      if (at === -1) return { analyteName: line, value: line };

      const rest = line.slice(at + 1).trim();
      /*
       * "128 g/L" → value "128", unit "g/L".
       *
       * A value with no space keeps its whole text, because "No growth" must
       * not be split into a value and a unit. Censored values like "<0.01"
       * survive intact for the same reason — `reference-range.ts` compares them
       * as intervals and needs them whole.
       */
      const split = /^(\S+)\s+(.+)$/.exec(rest);
      return {
        analyteName: line.slice(0, at).trim(),
        value: split ? split[1] : rest,
        unit: split ? split[2] : undefined,
      };
    });
}
