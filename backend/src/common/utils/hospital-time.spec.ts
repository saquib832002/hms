import { hospitalDate, hospitalDayRange, parseDateParam, zonedTimeToUtc } from './hospital-time';

/**
 * These tests exist because "today's queue" is the single most-used query in
 * the system, and getting the day boundary wrong is a silent bug: it does not
 * throw, it just quietly shows the wrong patients for an hour a day.
 */
describe('hospital-time', () => {
  describe('hospitalDayRange', () => {
    it('spans exactly 24 hours outside DST changes', () => {
      const { start, end } = hospitalDayRange(new Date('2026-08-12T14:30:00Z'), 'Europe/London');
      expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it('starts at local midnight, not UTC midnight', () => {
      // In August London is UTC+1, so local midnight is 23:00 UTC the day before.
      const { start } = hospitalDayRange(new Date('2026-08-12T14:30:00Z'), 'Europe/London');
      expect(start.toISOString()).toBe('2026-08-11T23:00:00.000Z');
    });

    it('agrees with UTC when the hospital is in UTC', () => {
      const { start, end } = hospitalDayRange(new Date('2026-08-12T14:30:00Z'), 'UTC');
      expect(start.toISOString()).toBe('2026-08-12T00:00:00.000Z');
      expect(end.toISOString()).toBe('2026-08-13T00:00:00.000Z');
    });

    it('puts a late-evening UTC instant on the correct local day', () => {
      // 23:30 UTC on 11 Aug is already 00:30 on 12 Aug in London. An
      // appointment then belongs to the 12th's queue, not the 11th's.
      const { start } = hospitalDayRange(new Date('2026-08-11T23:30:00Z'), 'Europe/London');
      expect(hospitalDate(start, 'Europe/London')).toEqual({ year: 2026, month: 8, day: 12 });
    });

    it('handles a zone far from UTC', () => {
      // Tokyo is UTC+9 year round. 01:00 UTC is already 10:00 the same day.
      const { start, end } = hospitalDayRange(new Date('2026-08-12T01:00:00Z'), 'Asia/Tokyo');
      expect(start.toISOString()).toBe('2026-08-11T15:00:00.000Z');
      expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    });

    it('produces a 23-hour day when clocks go forward', () => {
      // BST began 29 March 2026 at 01:00 UTC.
      const { start, end } = hospitalDayRange(new Date('2026-03-29T12:00:00Z'), 'Europe/London');
      expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
    });

    it('produces a 25-hour day when clocks go back', () => {
      // BST ended 25 October 2026 at 02:00 local.
      const { start, end } = hospitalDayRange(new Date('2026-10-25T12:00:00Z'), 'Europe/London');
      expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
    });
  });

  describe('zonedTimeToUtc', () => {
    it('maps a 09:00 clinic slot to the right UTC instant in summer', () => {
      const at = zonedTimeToUtc({ year: 2026, month: 8, day: 12, hour: 9 }, 'Europe/London');
      expect(at.toISOString()).toBe('2026-08-12T08:00:00.000Z');
    });

    it('maps the same slot an hour later in winter', () => {
      const at = zonedTimeToUtc({ year: 2026, month: 1, day: 12, hour: 9 }, 'Europe/London');
      expect(at.toISOString()).toBe('2026-01-12T09:00:00.000Z');
    });
  });

  describe('parseDateParam', () => {
    it('parses YYYY-MM-DD into that local day', () => {
      const { start } = parseDateParam('2026-08-12', 'Europe/London');
      expect(start.toISOString()).toBe('2026-08-11T23:00:00.000Z');
    });

    it('falls back to today when the param is missing', () => {
      const { start, end } = parseDateParam(undefined, 'UTC');
      const now = Date.now();
      expect(start.getTime()).toBeLessThanOrEqual(now);
      expect(end.getTime()).toBeGreaterThan(now);
    });

    it('falls back to today rather than throwing on malformed input', () => {
      const { start, end } = parseDateParam('not-a-date', 'UTC');
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    });
  });
});
