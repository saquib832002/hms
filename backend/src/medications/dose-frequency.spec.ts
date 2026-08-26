import { doseTimesFor, parseFrequency, whyNotScheduled } from './dose-frequency';
import { hospitalDate, zonedTimeToUtc } from '../common/utils/hospital-time';

/**
 * The important assertions in this file are the ones about *refusing* to
 * parse. A frequency parser that guesses produces a drug chart that is
 * confidently wrong, and a nurse following it gets the dose wrong.
 */
describe('parseFrequency', () => {
  describe('recognised frequencies', () => {
    it.each([
      ['Once daily', 1],
      ['once a day', 1],
      ['OD', 1],
      ['Twice daily', 2],
      ['twice a day', 2],
      ['BD', 2],
      ['bid', 2],
      ['Three times daily', 3],
      ['TDS', 3],
      ['tid', 3],
      ['Four times daily', 4],
      ['QDS', 4],
      ['every 12 hours', 2],
      ['every 8 hours', 3],
      ['every 6 hours', 4],
      ['every 4 hours', 6],
      ['q8h', 3],
      ['Q6H', 4],
    ])('%s → %i doses a day', (text, expected) => {
      expect(parseFrequency(text)?.timesPerDay).toBe(expected);
    });

    it('spaces doses across real drug rounds, not evenly around the clock', () => {
      // Four times daily is 08/12/16/20, not every six hours — nobody is woken
      // at 02:00 for a routine medicine.
      expect(parseFrequency('four times daily')?.hours).toEqual([8, 12, 16, 20]);
    });

    it('does schedule genuinely 4-hourly medicines overnight', () => {
      // "Every 4 hours" means it, and the overnight doses are the point.
      expect(parseFrequency('every 4 hours')?.hours).toEqual([2, 6, 10, 14, 18, 22]);
    });

    it('produces a label a nurse can read', () => {
      expect(parseFrequency('BD')?.label).toBe('Twice daily (08:00, 20:00)');
    });

    it('is insensitive to case and spacing', () => {
      expect(parseFrequency('  TWICE   DAILY  ')?.timesPerDay).toBe(2);
    });
  });

  describe('refusing to guess', () => {
    it.each([
      ['as needed'],
      ['PRN'],
      ['prn for pain'],
      ['as required'],
      ['when required'],
      ['if needed'],
      ['STAT'],
      ['once only'],
    ])('never schedules "%s"', (text) => {
      // PRN medicine is given on assessment. A row saying a dose is "due"
      // would invite giving a medicine the patient did not need.
      expect(parseFrequency(text)).toBeNull();
    });

    it('refuses PRN even when it also contains a schedulable word', () => {
      // "Twice daily as needed" is contradictory; the safe reading is PRN.
      expect(parseFrequency('twice daily as needed')).toBeNull();
      expect(parseFrequency('every 6 hours PRN')).toBeNull();
    });

    it.each([
      [''],
      ['   '],
      ['with meals'],
      ['at night'],
      ['alternate days'],
      ['weekly'],
      ['as directed'],
      ['taper over two weeks'],
      ['🙂'],
    ])('returns null rather than guessing at "%s"', (text) => {
      expect(parseFrequency(text)).toBeNull();
    });

    it('explains why, so the UI can tell the nurse what to do', () => {
      expect(whyNotScheduled('PRN')).toMatch(/as needed/i);
      expect(whyNotScheduled('alternate days')).toMatch(/not recognised/i);
      expect(whyNotScheduled('')).toMatch(/no frequency/i);
    });
  });
});

describe('doseTimesFor', () => {
  const tz = 'Europe/London';
  const toUtc = (p: { year: number; month: number; day: number; hour: number }) =>
    zonedTimeToUtc(p, tz);
  const dayOf = (d: Date) => hospitalDate(d, tz);

  it('generates one row per dose per day', () => {
    const schedule = parseFrequency('twice daily')!;
    const start = new Date('2026-08-12T05:00:00Z'); // 06:00 local, before both rounds
    expect(doseTimesFor(schedule, start, 3, toUtc, dayOf)).toHaveLength(6);
  });

  it('skips doses that are already in the past today', () => {
    // Prescribed at 14:00 — the 08:00 round has been and gone. Creating it
    // would show as an immediately-missed dose nobody actually missed.
    const schedule = parseFrequency('twice daily')!;
    const start = new Date('2026-08-12T13:00:00Z'); // 14:00 local
    const times = doseTimesFor(schedule, start, 1, toUtc, dayOf);
    expect(times).toHaveLength(1);
    expect(times[0].toISOString()).toBe('2026-08-12T19:00:00.000Z'); // 20:00 BST
  });

  it('produces times in the hospital zone, not the server zone', () => {
    const schedule = parseFrequency('once daily')!;
    const times = doseTimesFor(schedule, new Date('2026-01-12T00:00:00Z'), 1, toUtc, dayOf);
    // January: London is UTC+0, so an 08:00 round is 08:00Z.
    expect(times[0].toISOString()).toBe('2026-01-12T08:00:00.000Z');
  });

  it('stays correct across a DST change', () => {
    const schedule = parseFrequency('once daily')!;
    const times = doseTimesFor(schedule, new Date('2026-03-28T00:00:00Z'), 3, toUtc, dayOf);
    // 28 Mar is GMT (08:00Z), 29–30 Mar are BST (07:00Z). The dose stays at
    // 08:00 on the ward clock, which is what matters to the nurse giving it.
    expect(times.map((t) => t.toISOString())).toEqual([
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
    ]);
  });

  it('returns times in ascending order', () => {
    const schedule = parseFrequency('four times daily')!;
    const times = doseTimesFor(schedule, new Date('2026-08-12T00:00:00Z'), 2, toUtc, dayOf);
    const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
    expect(times).toEqual(sorted);
  });
});
