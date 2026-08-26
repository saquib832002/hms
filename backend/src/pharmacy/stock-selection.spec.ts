import {
  allocateFefo,
  expiringSoon,
  inDateQuantity,
  InsufficientStockError,
  parseDurationDays,
  suggestQuantity,
} from './stock-selection';

const NOW = new Date('2026-08-17T10:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 3600_000);

const batch = (id: number, quantity: number, expiresInDays: number) => ({
  id,
  batchNumber: `B-${id}`,
  quantity,
  expiresAt: days(expiresInDays),
});

describe('allocateFefo', () => {
  it('takes from the shortest-dated batch first', () => {
    // Not FIFO. Stock does not arrive in expiry order, so dispensing by
    // arrival quietly grows a pile that expires on the shelf.
    const allocations = allocateFefo([batch(1, 50, 300), batch(2, 50, 30)], 20, NOW);

    expect(allocations).toHaveLength(1);
    expect(allocations[0].batchId).toBe(2);
  });

  it('spans batches when one is not enough', () => {
    const allocations = allocateFefo([batch(1, 30, 200), batch(2, 25, 10)], 40, NOW);

    expect(allocations).toEqual([
      expect.objectContaining({ batchId: 2, quantity: 25 }),
      expect.objectContaining({ batchId: 1, quantity: 15 }),
    ]);
  });

  it('takes exactly what was asked for and no more', () => {
    const allocations = allocateFefo([batch(1, 100, 90)], 7, NOW);
    expect(allocations[0].quantity).toBe(7);
  });

  describe('expired stock', () => {
    it('is never dispensed, even when it is all there is', () => {
      // Expired medicine is not last-resort stock; it is not stock.
      expect(() => allocateFefo([batch(1, 500, -1)], 1, NOW)).toThrow(InsufficientStockError);
    });

    it('is skipped in favour of in-date stock', () => {
      const allocations = allocateFefo([batch(1, 100, -5), batch(2, 10, 60)], 10, NOW);
      expect(allocations).toHaveLength(1);
      expect(allocations[0].batchId).toBe(2);
    });

    it('does not count towards availability in the error', () => {
      try {
        allocateFefo([batch(1, 100, -1), batch(2, 5, 30)], 20, NOW);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InsufficientStockError);
        expect((err as InsufficientStockError).available).toBe(5);
      }
    });

    it('treats a batch expiring today as expired', () => {
      // The boundary matters: dispensing something that expires within the
      // hour is not defensible.
      expect(() => allocateFefo([{ ...batch(1, 10, 0), expiresAt: NOW }], 1, NOW)).toThrow(
        InsufficientStockError,
      );
    });
  });

  it('ignores empty batches', () => {
    const allocations = allocateFefo([batch(1, 0, 5), batch(2, 10, 100)], 5, NOW);
    expect(allocations[0].batchId).toBe(2);
  });

  it('refuses a non-positive quantity', () => {
    expect(() => allocateFefo([batch(1, 10, 30)], 0, NOW)).toThrow(/greater than zero/);
    expect(() => allocateFefo([batch(1, 10, 30)], -5, NOW)).toThrow(/greater than zero/);
  });

  it('throws rather than partially allocating', () => {
    // A pharmacist must not discover halfway through that there was not
    // enough — the whole dispense either happens or it does not.
    expect(() => allocateFefo([batch(1, 5, 30)], 10, NOW)).toThrow(InsufficientStockError);
  });
});

describe('inDateQuantity', () => {
  it('counts only what is still usable', () => {
    expect(inDateQuantity([batch(1, 100, -1), batch(2, 30, 10), batch(3, 20, 400)], NOW)).toBe(50);
  });

  it('is zero when everything has expired', () => {
    expect(inDateQuantity([batch(1, 100, -1)], NOW)).toBe(0);
  });
});

describe('parseDurationDays', () => {
  it.each([
    ['30 days', 30],
    ['7 days', 7],
    ['1 day', 1],
    ['2 weeks', 14],
    ['1 week', 7],
    ['3 months', 90],
    ['  14   DAYS  ', 14],
  ])('reads "%s" as %i days', (text, expected) => {
    expect(parseDurationDays(text)).toBe(expected);
  });

  it.each([
    ['ongoing'],
    ['as directed'],
    ['until review'],
    ['PRN'],
    ['indefinite'],
    [''],
    ['a while'],
    ['until finished'],
    ['30'],
  ])('refuses to read "%s"', (text) => {
    expect(parseDurationDays(text)).toBeNull();
  });

  it('rejects an implausible course length', () => {
    expect(parseDurationDays('9999 days')).toBeNull();
    expect(parseDurationDays('0 days')).toBeNull();
  });
});

describe('suggestQuantity', () => {
  it('multiplies doses per day by days', () => {
    expect(suggestQuantity('Twice daily', '30 days')).toBe(60);
    expect(suggestQuantity('Once daily', '7 days')).toBe(7);
    expect(suggestQuantity('Four times daily', '1 week')).toBe(28);
  });

  it('refuses when the frequency is not confidently readable', () => {
    // Same discipline as the drug chart: a wrong number here sends a patient
    // home with the wrong amount of medicine.
    expect(suggestQuantity('as directed', '30 days')).toBeNull();
    expect(suggestQuantity('PRN', '30 days')).toBeNull();
  });

  it('refuses when the duration is not confidently readable', () => {
    expect(suggestQuantity('Twice daily', 'ongoing')).toBeNull();
    expect(suggestQuantity('Twice daily', 'until review')).toBeNull();
  });

  it('refuses when neither is readable', () => {
    expect(suggestQuantity('as needed', 'as directed')).toBeNull();
  });
});

describe('expiringSoon', () => {
  it('returns batches inside the window, soonest first', () => {
    const result = expiringSoon([batch(1, 10, 90), batch(2, 10, 20), batch(3, 10, 5)], 30, NOW);
    expect(result.map((b) => b.id)).toEqual([3, 2]);
  });

  it('excludes stock that has already expired', () => {
    // Already-expired stock is a write-off, not a warning — it belongs on a
    // different report.
    expect(expiringSoon([batch(1, 10, -3)], 30, NOW)).toEqual([]);
  });

  it('is empty when nothing is close to expiry', () => {
    expect(expiringSoon([batch(1, 10, 400)], 30, NOW)).toEqual([]);
  });
});
