import { rankShortcuts, rankValues, type PrescribedItem } from './prescribing-history';

/**
 * The ranking behind the prescribing shortcuts.
 *
 * Worth testing on its own because "recent and common" is a judgement, and the
 * two obvious single-signal versions are both wrong in ways a doctor would
 * notice within a week: sort by count and a regimen they abandoned six months
 * ago sits at the top; sort by recency and one unusual prescription from this
 * morning outranks the thing they write daily.
 */

const item = (
  medicineName: string,
  dosage: string,
  frequency: string,
  duration: string,
  issuedAt: string,
): PrescribedItem => ({
  medicineName,
  medicineId: null,
  dosage,
  frequency,
  duration,
  issuedAt: new Date(issuedAt),
});

describe('rankShortcuts', () => {
  it('collapses an identical line into one entry with a count', () => {
    const out = rankShortcuts([
      item('Amoxicillin', '500mg', 'TDS', '5 days', '2026-08-01'),
      item('Amoxicillin', '500mg', 'TDS', '5 days', '2026-08-20'),
      item('Ibuprofen', '400mg', 'BD', '3 days', '2026-08-10'),
    ]);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      medicineName: 'Amoxicillin',
      timesPrescribed: 2,
      lastUsedAt: new Date('2026-08-20'),
    });
  });

  it('treats casing and stray whitespace as the same habit', () => {
    /*
     * "TDS", "tds" and "TDS " are one thing a doctor does, not three. Without
     * this the shortcut list fills up with near-duplicates and the count that
     * ranks them is split across the spellings.
     */
    const out = rankShortcuts([
      item('Amoxicillin', '500mg', 'TDS', '5 days', '2026-08-01'),
      item('amoxicillin', '500MG', 'tds ', ' 5 days', '2026-08-02'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].timesPrescribed).toBe(2);
  });

  it('shows the most recent spelling of a merged line', () => {
    // A doctor who has started writing "500 mg" should get that back, not the
    // form they used a year ago.
    const out = rankShortcuts([
      item('Amoxicillin', '500mg', 'TDS', '5 days', '2026-01-01'),
      item('Amoxicillin', '500 mg', 'TDS', '5 days', '2026-08-01'),
    ]);
    expect(out[0].dosage).toBe('500 mg');
  });

  it('ranks by count first, then by recency', () => {
    const out = rankShortcuts([
      // Written three times, last a while ago.
      item('Metformin', '500mg', 'BD', '30 days', '2026-06-01'),
      item('Metformin', '500mg', 'BD', '30 days', '2026-06-02'),
      item('Metformin', '500mg', 'BD', '30 days', '2026-06-03'),
      // Written once, this morning.
      item('Rare Drug', '10mg', 'OD', '7 days', '2026-08-30'),
    ]);
    expect(out[0].medicineName).toBe('Metformin');
    expect(out[1].medicineName).toBe('Rare Drug');
  });

  it('breaks a tie on count using recency', () => {
    const out = rankShortcuts([
      item('Older', '1', 'OD', '1 day', '2026-01-01'),
      item('Newer', '1', 'OD', '1 day', '2026-08-01'),
    ]);
    expect(out[0].medicineName).toBe('Newer');
  });

  it('caps the list', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      item(`Drug ${i}`, '1mg', 'OD', '5 days', '2026-08-01'),
    );
    expect(rankShortcuts(many, 20)).toHaveLength(20);
  });

  it('returns nothing for a doctor who has prescribed nothing', () => {
    // A new doctor sees plain fields rather than invented defaults.
    expect(rankShortcuts([])).toEqual([]);
  });
});

describe('rankValues', () => {
  const history = [
    item('A', '1', 'TDS', '5 days', '2026-08-01'),
    item('B', '1', 'TDS', '7 days', '2026-08-02'),
    item('C', '1', 'BD', '5 days', '2026-08-03'),
    item('D', '1', '', '  ', '2026-08-04'),
  ];

  it('ranks a doctor’s own shorthand by how often they use it', () => {
    /*
     * Built from their history rather than a fixed list, because prescribing
     * shorthand is local: "TDS" here is "TID" elsewhere and "1-1-1" elsewhere
     * again. A hard-coded set would be wrong somewhere and noise everywhere.
     */
    expect(rankValues(history, 'frequency')).toEqual(['TDS', 'BD']);
    expect(rankValues(history, 'duration')).toEqual(['5 days', '7 days']);
  });

  it('ignores blank values rather than offering an empty chip', () => {
    expect(rankValues(history, 'frequency')).not.toContain('');
  });

  it('is empty for a doctor with no history', () => {
    expect(rankValues([], 'frequency')).toEqual([]);
  });
});
