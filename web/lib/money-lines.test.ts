import { describe, expect, it } from 'vitest';
import { basketTotalMinor, lineTotalMinor, minorToAmount } from './money-lines';

/**
 * The number a patient is charged.
 *
 * These exist because the dispensing sheet printed **3500.00 for a £35.00
 * basket** — the arithmetic was right and the value reached the screen in the
 * wrong unit. Reported by a user standing at a counter, which is the worst
 * possible place to find it.
 *
 * The test that matters most is the round trip: minor units in, formatted
 * amount out, with no screen doing the division itself.
 */

describe('one line', () => {
  it('multiplies at full price precision and rounds once', () => {
    // 0.0725 × 30 = 2.175 → 218 minor, not 2.10 (which is what rounding the
    // unit price to 0.07 first would give, 3% light on every line forever).
    expect(lineTotalMinor('0.0725', 30)).toBe(218);
  });

  it('handles an ordinary whole price', () => {
    expect(lineTotalMinor('2.5000', 14)).toBe(3500);
    expect(minorToAmount(lineTotalMinor('2.5000', 14))).toBe('35.00');
  });

  it('rounds half up, like a till', () => {
    // 0.005 × 1 = 0.005 → 1 minor (half up), not 0.
    expect(lineTotalMinor('0.0050', 1)).toBe(1);
  });

  it('treats an unpriced medicine as nothing, not as free', () => {
    /*
     * Both contribute 0 to the total, and that is correct — but the screens
     * must not present them the same way. Unpriced is named separately as
     * "not charged for"; zero is a decision the hospital made. This function
     * only owes the arithmetic; the distinction lives in the UI.
     */
    expect(lineTotalMinor(null, 10)).toBe(0);
  });

  it('ignores a nonsense quantity rather than producing NaN', () => {
    // NaN propagates through a sum and prints as "NaN" on a receipt, which is
    // worse than a missing line because it makes the whole total unreadable.
    expect(lineTotalMinor('2.0000', Number.NaN)).toBe(0);
    expect(lineTotalMinor('2.0000', -3)).toBe(0);
    expect(lineTotalMinor('not a price', 3)).toBe(0);
  });
});

describe('a basket', () => {
  it('sums lines that were each rounded once', () => {
    /*
     * Rounding per line and then summing is what the server does
     * (`lineTotalMinor` in pricing.ts). Summing exact values and rounding at
     * the end would differ by a penny on some baskets — and the receipt and
     * the invoice would disagree in front of somebody holding cash.
     */
    const total = basketTotalMinor([
      { unitPrice: '0.0725', quantity: 30 },
      { unitPrice: '2.5000', quantity: 14 },
      { unitPrice: null, quantity: 5 },
    ]);
    expect(total).toBe(218 + 3500);
    expect(minorToAmount(total)).toBe('37.18');
  });

  it('is empty rather than zero-priced when nothing is selected', () => {
    expect(basketTotalMinor([])).toBe(0);
    expect(minorToAmount(0)).toBe('0.00');
  });
});

describe('the unit never changes at a render site', () => {
  it('formats minor units, and only minor units', () => {
    /*
     * The bug in one line. `totalMinor` held 3500 and was rendered with
     * `.toFixed(2)`, printing 3500.00. Every screen now goes through
     * `minorToAmount`, so the conversion exists in one place and cannot be
     * skipped by someone who forgets which unit they are holding.
     */
    expect(minorToAmount(3500)).toBe('35.00');
    expect(minorToAmount(3500)).not.toBe('3500.00');
  });
});
