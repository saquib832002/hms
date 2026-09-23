import { LabResultFlag } from '@prisma/client';

/**
 * Deciding whether a laboratory value is normal.
 *
 * WHY THIS REFUSES SO OFTEN
 * -------------------------
 * A flag is the thing a clinician reads first and frequently the only thing
 * they read. It is also the thing they will not check, because checking it
 * means re-reading the range and doing the comparison themselves, which is what
 * the flag was for.
 *
 * So this is written the way `parseFrequency` and `course-quantity.ts` are: a
 * deliberately small set of comparisons it can make honestly, and UNKNOWN for
 * everything else. **UNKNOWN is not NORMAL.** A value that could not be
 * compared and a value that was compared and found unremarkable render
 * identically if you collapse them, and they mean opposite things — one of them
 * is "the lab checked", and the other is "nobody did".
 *
 * That distinction is the same one `allergyChecked: false` draws on a
 * cross-tenant prescription referral, and it is the reason an empty warning
 * panel is the most dangerous available misreading.
 *
 * CENSORED VALUES ARE REAL RESULTS
 * --------------------------------
 * "<0.01" is what a troponin assay actually reports, and it is normal. ">200"
 * is what a glucose meter reports, and it is not. Reading either as its bare
 * number is wrong in a way that happens to be right most of the time, which is
 * the worst kind of wrong. They are parsed as intervals, and compared as
 * intervals: where the whole interval sits on one side of a boundary the answer
 * is certain, and where it straddles one there is no answer and this says so.
 */

/** Reference limits for one analyte, as captured on the catalogue row. */
export interface AnalyteRange {
  refLow: number | null;
  refHigh: number | null;
  /** For analytes where "normal" is a word: "No growth", "Negative". */
  refText: string | null;
  criticalLow: number | null;
  criticalHigh: number | null;
}

/** A parsed laboratory value: an exact number, or an open interval. */
export interface ParsedValue {
  op: '=' | '<' | '>';
  n: number;
}

/**
 * The numeric content of a result string, or null when there is none.
 *
 * Accepts "5.4", "5,4" is NOT accepted (a decimal comma would make "1,234"
 * ambiguous against a thousands separator, and a laboratory value that means
 * either 1.234 or 1234 is worse than no value), "<0.01", "> 200", "-2.5".
 * Rejects anything with other text in it — "5.4 (haemolysed)" is a comment on a
 * number and this is not the place to strip comments off results.
 */
export function parseValue(raw: string): ParsedValue | null {
  const text = raw.trim();
  if (!text) return null;

  const match = /^(<|>|<=|>=|≤|≥)?\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return null;

  const n = Number(match[2]);
  if (!Number.isFinite(n)) return null;

  const symbol = match[1];
  if (!symbol) return { op: '=', n };
  // "<=" and "≤" bound the value at n inclusive. Treated as "<" with the bound
  // included, which changes nothing about which side of a limit it falls on.
  return { op: symbol.startsWith('<') || symbol === '≤' ? '<' : '>', n };
}

/** The range as it should print on the report, or null when there is none. */
export function formatRange(range: AnalyteRange, unit?: string | null): string | null {
  const suffix = unit ? ` ${unit}` : '';
  if (range.refLow !== null && range.refHigh !== null) {
    return `${trim(range.refLow)} – ${trim(range.refHigh)}${suffix}`;
  }
  if (range.refLow !== null) return `> ${trim(range.refLow)}${suffix}`;
  if (range.refHigh !== null) return `< ${trim(range.refHigh)}${suffix}`;
  if (range.refText) return range.refText;
  return null;
}

/**
 * How a value compares with its range.
 *
 * Critical is checked before high and low, because a potassium of 7.2 is not
 * "high" in any sense a ward should act on gently, and a report that renders it
 * the same colour as 5.4 has thrown away the only information that changes what
 * happens in the next ten minutes.
 */
export function flagFor(raw: string, range: AnalyteRange): LabResultFlag {
  const hasNumeric =
    range.refLow !== null ||
    range.refHigh !== null ||
    range.criticalLow !== null ||
    range.criticalHigh !== null;

  // Nothing to compare against. Not normal — unexamined.
  if (!hasNumeric && !range.refText) return LabResultFlag.UNKNOWN;

  const parsed = parseValue(raw);

  /*
   * A worded range: "No growth", "Negative", "Not detected".
   *
   * Compared case- and space-insensitively and nothing cleverer. A culture
   * report is prose, and a system that tried to decide whether "Scanty growth
   * of coliforms" is abnormal would be practising microbiology.
   */
  if (!parsed) {
    if (!range.refText) return LabResultFlag.UNKNOWN;
    return normalise(raw) === normalise(range.refText)
      ? LabResultFlag.NORMAL
      : LabResultFlag.ABNORMAL;
  }

  if (!hasNumeric) {
    // A number against a worded range — "3" where "Negative" was expected.
    // Comparable only as text, which is what the caller asked for.
    return normalise(raw) === normalise(range.refText ?? '')
      ? LabResultFlag.NORMAL
      : LabResultFlag.ABNORMAL;
  }

  const below = (limit: number | null) => (limit === null ? false : certainlyBelow(parsed, limit));
  const above = (limit: number | null) => (limit === null ? false : certainlyAbove(parsed, limit));

  if (below(range.criticalLow)) return LabResultFlag.CRITICAL_LOW;
  if (above(range.criticalHigh)) return LabResultFlag.CRITICAL_HIGH;
  if (below(range.refLow)) return LabResultFlag.LOW;
  if (above(range.refHigh)) return LabResultFlag.HIGH;

  /*
   * Not outside anything — but "not provably outside" is only "normal" when the
   * value is provably *inside*. A censored value whose interval straddles a
   * limit ("<10" against a floor of 4) is genuinely unresolvable, and calling
   * it normal would be the system inventing reassurance.
   */
  return certainlyWithin(parsed, range) ? LabResultFlag.NORMAL : LabResultFlag.UNKNOWN;
}

/** Does this flag oblige somebody to pick up a telephone? */
export function isCritical(flag: LabResultFlag): boolean {
  return flag === LabResultFlag.CRITICAL_LOW || flag === LabResultFlag.CRITICAL_HIGH;
}

/** Anything a clinician should look at twice. */
export function isAbnormal(flag: LabResultFlag): boolean {
  return (
    flag === LabResultFlag.LOW ||
    flag === LabResultFlag.HIGH ||
    flag === LabResultFlag.ABNORMAL ||
    isCritical(flag)
  );
}

/**
 * The number to store alongside the text for trending, or null.
 *
 * Only an exact value. A censored result has no single number, and putting
 * 0.01 in the column for "<0.01" would draw a chart line through a value the
 * assay explicitly declined to measure.
 */
export function trendableValue(raw: string): number | null {
  const parsed = parseValue(raw);
  return parsed?.op === '=' ? parsed.n : null;
}

function certainlyBelow(v: ParsedValue, limit: number): boolean {
  // "<5" is below 5 and below anything above 5. It is NOT provably below 4.
  if (v.op === '<') return v.n <= limit;
  if (v.op === '>') return false;
  return v.n < limit;
}

function certainlyAbove(v: ParsedValue, limit: number): boolean {
  if (v.op === '>') return v.n >= limit;
  if (v.op === '<') return false;
  return v.n > limit;
}

function certainlyWithin(v: ParsedValue, range: AnalyteRange): boolean {
  const floor = range.refLow ?? range.criticalLow;
  const ceiling = range.refHigh ?? range.criticalHigh;

  if (v.op === '=') {
    return (floor === null || v.n >= floor) && (ceiling === null || v.n <= ceiling);
  }
  if (v.op === '<') {
    // Bounded above by n; only inside if there is no floor to fall below.
    return floor === null && (ceiling === null || v.n <= ceiling);
  }
  return ceiling === null && (floor === null || v.n >= floor);
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function trim(n: number): string {
  // Ranges are configuration, so they print as typed rather than padded to a
  // fixed precision — "4 – 11" rather than "4.0000 – 11.0000".
  return String(Number(n.toFixed(4)));
}
