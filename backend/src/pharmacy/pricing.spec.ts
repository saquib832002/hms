import { MoneyError } from '../billing/money';
import {
  fromPriceUnits,
  lineTotalMinor,
  priceSale,
  toPriceString,
  toPriceUnits,
} from './pricing';

/**
 * The arithmetic, pinned without a database.
 *
 * These are the cases that are invisible in a UI and expensive in aggregate:
 * a sub-penny unit price, a rounding boundary, and a price that parses when it
 * should not. Every one of them looks right on one receipt.
 */

describe('parsing a unit price', () => {
  it('reads four decimal places exactly', () => {
    expect(toPriceUnits('0.0725')).toBe(725);
    expect(toPriceUnits('0.35')).toBe(3500);
    expect(toPriceUnits('12')).toBe(120_000);
    expect(toPriceUnits('1,250.5')).toBe(12_505_000);
  });

  it('treats null, undefined and empty as "not priced", not as zero', () => {
    // The distinction the whole module rests on. Zero is a decision; blank is
    // an omission, and they must not arrive at the same place.
    expect(toPriceUnits(null)).toBeNull();
    expect(toPriceUnits(undefined)).toBeNull();
    expect(toPriceUnits('   ')).toBeNull();
    expect(toPriceUnits('0')).toBe(0);
  });

  it('refuses to coerce', () => {
    // `parseFloat('0.35abc')` is 0.35. That is the failure this exists to stop.
    // The empty string is deliberately absent: a cleared price field means "not
    // priced", which is the case above, not a malformed number.
    for (const bad of ['0.35abc', '1.2.3', '-4', '0.12345', 'free']) {
      expect(() => toPriceUnits(bad as string)).toThrow(MoneyError);
    }
  });

  it('round-trips through the string form', () => {
    for (const value of ['0.0001', '0.3500', '12.0000', '9999.9999']) {
      expect(fromPriceUnits(toPriceUnits(value)!)).toBe(value);
    }
  });

  it('normalises a Decimal-like object the way toMoneyString does', () => {
    const decimalish = { toString: () => '0.3500' };
    expect(toPriceString(decimalish)).toBe('0.3500');
    expect(toPriceString(null)).toBeNull();
  });
});

describe('a line total', () => {
  it('rounds once, at the end', () => {
    /*
     * The reason four decimal places exist at all.
     *
     * 0.0725 × 30 = 2.175 → 2.18. Rounding the unit price to 2dp first gives
     * either 0.07 × 30 = 2.10 or 0.08 × 30 = 2.40 — out by 3% and 10% on a
     * single line, and in the same direction on every line forever.
     */
    expect(lineTotalMinor(toPriceUnits('0.0725')!, 30)).toBe(218);
    expect(lineTotalMinor(toPriceUnits('0.35')!, 21)).toBe(735);
    expect(lineTotalMinor(toPriceUnits('12.50')!, 2)).toBe(2500);
  });

  it('rounds half up, because that is what a till does', () => {
    // 0.125 × 1 = 0.125 → 0.13, not 0.12. Banker's rounding would give 0.12
    // and would be surprising on a receipt.
    expect(lineTotalMinor(toPriceUnits('0.125')!, 1)).toBe(13);
    expect(lineTotalMinor(toPriceUnits('0.135')!, 1)).toBe(14);
  });

  it('charges nothing for nothing', () => {
    expect(lineTotalMinor(0, 50)).toBe(0);
  });

  it('refuses a zero or fractional quantity', () => {
    expect(() => lineTotalMinor(3500, 0)).toThrow(MoneyError);
    expect(() => lineTotalMinor(3500, -1)).toThrow(MoneyError);
    expect(() => lineTotalMinor(3500, 1.5)).toThrow(MoneyError);
  });
});

describe('pricing a sale', () => {
  it('sums the priced lines and names the unpriced ones', () => {
    const result = priceSale([
      { medicineId: 1, quantity: 21, priceUnits: toPriceUnits('0.35') },
      { medicineId: 2, quantity: 1, priceUnits: null },
      { medicineId: 3, quantity: 2, priceUnits: toPriceUnits('4.99') },
    ]);

    expect(result.totalMinor).toBe(735 + 998);
    expect(result.lineTotals).toEqual([735, null, 998]);
    expect(result.unpricedMedicineIds).toEqual([2]);
  });

  it('does not treat an unpriced medicine as free', () => {
    /*
     * The whole point. A sale of one unpriced item totals zero *and* reports
     * the omission — a caller that only reads the total would bill nothing and
     * look correct, which is why `unpricedMedicineIds` is not optional.
     */
    const result = priceSale([{ medicineId: 9, quantity: 3, priceUnits: null }]);
    expect(result.totalMinor).toBe(0);
    expect(result.unpricedMedicineIds).toEqual([9]);
  });

  it('distinguishes a genuinely free medicine from an unpriced one', () => {
    const free = priceSale([{ medicineId: 9, quantity: 3, priceUnits: 0 }]);
    expect(free.totalMinor).toBe(0);
    expect(free.unpricedMedicineIds).toEqual([]);
  });

  it('reports each unpriced medicine once, however many batches it came from', () => {
    // FEFO splits one item across batches, so the same medicine arrives as
    // several lines. A dialog listing "Amoxicillin, Amoxicillin, Amoxicillin"
    // reads as three separate problems.
    const result = priceSale([
      { medicineId: 4, quantity: 10, priceUnits: null },
      { medicineId: 4, quantity: 5, priceUnits: null },
    ]);
    expect(result.unpricedMedicineIds).toEqual([4]);
  });
});
