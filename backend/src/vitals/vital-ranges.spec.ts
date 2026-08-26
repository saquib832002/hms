import { ADULT_MIN_AGE, flagVitals, implausible, isEmptyReading } from './vital-ranges';

describe('flagVitals', () => {
  const ADULT = 45;

  it('flags nothing when everything is normal', () => {
    expect(
      flagVitals(
        { systolic: 120, diastolic: 78, pulse: 72, temperatureC: 36.8, respiratoryRate: 16, spo2: 98 },
        ADULT,
      ),
    ).toEqual([]);
  });

  it('ignores fields that were not recorded', () => {
    // A quick pulse check is a legitimate observation set. The nurse should
    // not have to invent a temperature to save it.
    expect(flagVitals({ pulse: 72 }, ADULT)).toEqual([]);
  });

  it.each([
    ['systolic', 165, 'high'],
    ['systolic', 85, 'low'],
    ['pulse', 110, 'high'],
    ['pulse', 45, 'low'],
    ['temperatureC', 38.4, 'high'],
    ['respiratoryRate', 22, 'high'],
    ['spo2', 93, 'low'],
  ])('flags %s of %s as %s', (field, value, level) => {
    const flags = flagVitals({ [field]: value }, ADULT);
    expect(flags).toHaveLength(1);
    expect(flags[0].level).toBe(level);
  });

  it.each([
    ['systolic', 190],
    ['systolic', 75],
    ['pulse', 135],
    ['temperatureC', 39.8],
    ['spo2', 88],
    ['respiratoryRate', 28],
  ])('escalates %s of %s to critical', (field, value) => {
    expect(flagVitals({ [field]: value }, ADULT)[0].level).toBe('critical');
  });

  it('flags every out-of-range field, not just the first', () => {
    const flags = flagVitals({ systolic: 190, pulse: 135, spo2: 88 }, ADULT);
    expect(flags).toHaveLength(3);
    expect(flags.every((f) => f.level === 'critical')).toBe(true);
  });

  describe('children', () => {
    it.each([1, 5, 12, ADULT_MIN_AGE - 1])(
      'refuses to judge a %i-year-old with adult ranges',
      (age) => {
        // A resting pulse of 120 is alarming in an adult and unremarkable in a
        // toddler. Applying adult thresholds to a child gives dangerous
        // answers, so it says nothing rather than something wrong.
        expect(flagVitals({ pulse: 120, respiratoryRate: 30 }, age)).toEqual([]);
      },
    );

    it('applies adult ranges from 16', () => {
      expect(flagVitals({ pulse: 120 }, ADULT_MIN_AGE)).toHaveLength(1);
    });
  });
});

describe('implausible', () => {
  it('accepts a realistic set', () => {
    expect(implausible({ systolic: 120, diastolic: 80, temperatureC: 36.9 })).toEqual([]);
  });

  it.each([
    ['temperatureC', 370], // misplaced decimal
    ['pulse', 7], // dropped digit
    ['systolic', 1200], // fat-fingered
    ['spo2', 150], // impossible
    ['respiratoryRate', 200],
  ])('rejects %s of %s as a typo', (field, value) => {
    expect(implausible({ [field]: value })).not.toEqual([]);
  });

  it('rejects diastolic greater than or equal to systolic', () => {
    // Almost always the two numbers entered in the wrong boxes.
    expect(implausible({ systolic: 80, diastolic: 120 })).not.toEqual([]);
    expect(implausible({ systolic: 100, diastolic: 100 })).not.toEqual([]);
  });

  it('allows an unusual but genuinely possible reading', () => {
    // Flagged as critical, but a real patient can present like this and the
    // nurse must be able to record what they actually measured.
    expect(implausible({ systolic: 85, diastolic: 45, pulse: 38, spo2: 88 })).toEqual([]);
  });

  it('says nothing about fields that were not recorded', () => {
    expect(implausible({})).toEqual([]);
  });
});

describe('isEmptyReading', () => {
  it('recognises a set with nothing in it', () => {
    expect(isEmptyReading({})).toBe(true);
    expect(isEmptyReading({ pulse: null, spo2: undefined })).toBe(true);
  });

  it('treats a zero pain score as a real observation', () => {
    // "No pain" is a finding, not a blank. A falsy check here would silently
    // discard it.
    expect(isEmptyReading({ painScore: 0 })).toBe(false);
  });
});
