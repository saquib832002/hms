import { LabResultFlag } from '@prisma/client';
import {
  AnalyteRange,
  flagFor,
  formatRange,
  isAbnormal,
  isCritical,
  parseValue,
  trendableValue,
} from './reference-range';

/**
 * The flag is the thing a clinician reads first and will not check.
 *
 * So the tests that matter here are the ones about what this *refuses* to
 * decide. A wrong NORMAL is the failure mode: it does not look like a bug, it
 * looks like reassurance, and the person it misleads has no way to tell.
 */

const range = (over: Partial<AnalyteRange> = {}): AnalyteRange => ({
  refLow: null,
  refHigh: null,
  refText: null,
  criticalLow: null,
  criticalHigh: null,
  ...over,
});

/** Haemoglobin, roughly: normal 130–170, critical below 70 or above 200. */
const HB = range({ refLow: 130, refHigh: 170, criticalLow: 70, criticalHigh: 200 });

describe('reading a value', () => {
  it.each([
    ['5.4', '=', 5.4],
    ['  12  ', '=', 12],
    ['-2.5', '=', -2.5],
    ['<0.01', '<', 0.01],
    ['> 200', '>', 200],
    ['<=5', '<', 5],
    ['≥3', '>', 3],
  ])('reads "%s"', (raw, op, n) => {
    expect(parseValue(raw)).toEqual({ op, n });
  });

  it.each([
    ['No growth'],
    ['Negative'],
    ['5.4 (haemolysed)'],
    ['1,234'],
    [''],
    ['positive 2'],
  ])('finds no number in "%s"', (raw) => {
    /*
     * "5.4 (haemolysed)" is a number with a comment on it and this is not the
     * place to strip comments off laboratory results. "1,234" is refused
     * because a decimal comma would make it mean either 1.234 or 1234, and a
     * value that means either is worse than no value.
     */
    expect(parseValue(raw)).toBeNull();
  });
});

describe('a plain numeric value', () => {
  it('is normal inside the range', () => {
    expect(flagFor('145', HB)).toBe(LabResultFlag.NORMAL);
    expect(flagFor('130', HB)).toBe(LabResultFlag.NORMAL);
    expect(flagFor('170', HB)).toBe(LabResultFlag.NORMAL);
  });

  it('is low or high outside it', () => {
    expect(flagFor('120', HB)).toBe(LabResultFlag.LOW);
    expect(flagFor('185', HB)).toBe(LabResultFlag.HIGH);
  });

  it('is critical before it is merely low or high', () => {
    /*
     * The ordering is the point. A haemoglobin of 60 is low and also an
     * emergency, and a report that renders it the same as 120 has thrown away
     * the only information that changes what happens in the next ten minutes.
     */
    expect(flagFor('60', HB)).toBe(LabResultFlag.CRITICAL_LOW);
    expect(flagFor('220', HB)).toBe(LabResultFlag.CRITICAL_HIGH);
  });

  it('treats a one-sided range as one-sided', () => {
    expect(flagFor('3', range({ refHigh: 5 }))).toBe(LabResultFlag.NORMAL);
    expect(flagFor('9', range({ refHigh: 5 }))).toBe(LabResultFlag.HIGH);
    expect(flagFor('9', range({ refLow: 5 }))).toBe(LabResultFlag.NORMAL);
    expect(flagFor('3', range({ refLow: 5 }))).toBe(LabResultFlag.LOW);
  });
});

describe('a censored value', () => {
  it('is normal when the whole interval sits inside', () => {
    // Troponin "<0.01" against a ceiling of 0.04. Every value the interval
    // could hold is below the ceiling, and there is no floor to fall under.
    expect(flagFor('<0.01', range({ refHigh: 0.04 }))).toBe(LabResultFlag.NORMAL);
    expect(flagFor('>15', range({ refLow: 10 }))).toBe(LabResultFlag.NORMAL);
  });

  it('is flagged when the whole interval sits outside', () => {
    expect(flagFor('>250', HB)).toBe(LabResultFlag.CRITICAL_HIGH);
    expect(flagFor('<50', HB)).toBe(LabResultFlag.CRITICAL_LOW);
    expect(flagFor('<100', range({ refLow: 130, refHigh: 170 }))).toBe(LabResultFlag.LOW);
  });

  it('refuses when the interval straddles a limit', () => {
    /*
     * THE TEST THIS FILE EXISTS FOR.
     *
     * "<200" against a range of 130–170 could be 150 (normal) or 190 (high).
     * There is no answer, and the two available wrong answers are both bad:
     * NORMAL invents reassurance, HIGH invents an abnormality. UNKNOWN sends
     * the reader to the number, which is where they should be looking.
     */
    expect(flagFor('<200', HB)).toBe(LabResultFlag.UNKNOWN);
    expect(flagFor('>100', HB)).toBe(LabResultFlag.UNKNOWN);
  });
});

describe('a worded range', () => {
  const culture = range({ refText: 'No growth' });

  it('matches case- and space-insensitively', () => {
    expect(flagFor('No growth', culture)).toBe(LabResultFlag.NORMAL);
    expect(flagFor('  no   GROWTH ', culture)).toBe(LabResultFlag.NORMAL);
  });

  it('is abnormal for anything else, and does not try to interpret it', () => {
    // A system that decided whether "Scanty growth of coliforms" is clinically
    // significant would be practising microbiology.
    expect(flagFor('Growth of E. coli', culture)).toBe(LabResultFlag.ABNORMAL);
    expect(flagFor('Scanty growth', culture)).toBe(LabResultFlag.ABNORMAL);
  });
});

describe('what it will not guess', () => {
  it('is UNKNOWN when no range is defined at all', () => {
    /*
     * Not NORMAL. A catalogue entry nobody has given a range to produces
     * results that are unexamined, and reporting them as normal would make an
     * unconfigured lab look like a clean bill of health — worse than the
     * Phase 1 allergy heuristic, which at least reported nothing.
     */
    expect(flagFor('5.4', range())).toBe(LabResultFlag.UNKNOWN);
  });

  it('is UNKNOWN for prose against a numeric range', () => {
    // "Sample haemolysed" where a number was expected. There is nothing to
    // compare, and ABNORMAL would assert something about the patient.
    expect(flagFor('Sample haemolysed', HB)).toBe(LabResultFlag.UNKNOWN);
  });

  it('never reports UNKNOWN as normal', () => {
    expect(isAbnormal(LabResultFlag.UNKNOWN)).toBe(false);
    expect(isCritical(LabResultFlag.UNKNOWN)).toBe(false);
    // …and it is not NORMAL either. Both predicates being false is the honest
    // answer: it is neither reassuring nor alarming, because nobody looked.
    expect(LabResultFlag.UNKNOWN).not.toBe(LabResultFlag.NORMAL);
  });
});

describe('what counts as needing attention', () => {
  it('treats every kind of critical as critical', () => {
    expect(isCritical(LabResultFlag.CRITICAL_LOW)).toBe(true);
    expect(isCritical(LabResultFlag.CRITICAL_HIGH)).toBe(true);
    expect(isCritical(LabResultFlag.HIGH)).toBe(false);
  });

  it('counts a worded abnormal alongside the numeric ones', () => {
    // A positive culture is not "high", and a screen that only highlighted
    // numeric deviations would render it as unremarkable text.
    expect(isAbnormal(LabResultFlag.ABNORMAL)).toBe(true);
    expect(isAbnormal(LabResultFlag.NORMAL)).toBe(false);
  });
});

describe('storing a number for trending', () => {
  it('keeps an exact value', () => {
    expect(trendableValue('5.4')).toBe(5.4);
  });

  it('keeps nothing for a censored or worded result', () => {
    /*
     * Storing 0.01 for "<0.01" would draw a chart line through a value the
     * assay explicitly declined to measure — and the chart is the one place
     * nobody sees the original text.
     */
    expect(trendableValue('<0.01')).toBeNull();
    expect(trendableValue('No growth')).toBeNull();
  });
});

describe('how the range prints', () => {
  it('shows both limits with the unit', () => {
    expect(formatRange({ ...HB }, 'g/L')).toBe('130 – 170 g/L');
  });

  it('shows a one-sided range as an inequality', () => {
    expect(formatRange(range({ refHigh: 0.04 }), 'ng/mL')).toBe('< 0.04 ng/mL');
    expect(formatRange(range({ refLow: 10 }), null)).toBe('> 10');
  });

  it('falls back to the worded range, and to nothing', () => {
    expect(formatRange(range({ refText: 'No growth' }))).toBe('No growth');
    expect(formatRange(range())).toBeNull();
  });
});
