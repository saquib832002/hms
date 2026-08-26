import {
  applyPayment,
  fromMinor,
  MoneyError,
  sumAmounts,
  toMinor,
  toMoneyString,
} from './money';

describe('toMinor', () => {
  it.each([
    ['0', 0],
    ['1', 100],
    ['12.5', 1250],
    ['12.50', 1250],
    ['1250.00', 125000],
    ['0.01', 1],
    ['0.1', 10],
    ['1,250.00', 125000],
    ['-45.50', -4550],
  ])('reads "%s" as %i minor units', (input, expected) => {
    expect(toMinor(input)).toBe(expected);
  });

  it.each([
    ['12.345'], // more precision than currency has
    ['12.5.6'],
    ['12abc'],
    ['abc'],
    [''],
    ['  '],
    ['£12.50'],
    ['1e3'],
    ['Infinity'],
  ])('refuses "%s" rather than coercing it', (input) => {
    // parseFloat('12abc') is 12, and Number('') is 0. Either of those
    // silently becoming a payment amount is the failure this prevents.
    expect(() => toMinor(input)).toThrow(MoneyError);
  });

  it('accepts a number only when it is exactly representable', () => {
    expect(toMinor(12.5)).toBe(1250);
    expect(toMinor(0)).toBe(0);
  });

  it('rejects a number that has already lost precision', () => {
    expect(() => toMinor(0.1 + 0.2)).toThrow(/string/);
    expect(() => toMinor(12.345)).toThrow(MoneyError);
    expect(() => toMinor(NaN)).toThrow(MoneyError);
  });
});

describe('fromMinor', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [10, '0.10'],
    [1250, '12.50'],
    [125000, '1250.00'],
    [-4550, '-45.50'],
  ])('renders %i as "%s"', (minor, expected) => {
    expect(fromMinor(minor)).toBe(expected);
  });

  it('always emits two decimal places', () => {
    // "1250" and "1250.00" being interchangeable is how a client ends up
    // rendering an amount inconsistently across two screens.
    expect(fromMinor(125000)).toBe('1250.00');
    expect(fromMinor(100)).toBe('1.00');
  });

  it('refuses a fractional minor unit', () => {
    expect(() => fromMinor(12.5)).toThrow(MoneyError);
  });
});

describe('round tripping', () => {
  it.each(['0.00', '0.01', '9.99', '12.50', '1250.00', '99999999.99'])(
    '"%s" survives unchanged',
    (amount) => {
      expect(fromMinor(toMinor(amount))).toBe(amount);
    },
  );
});

describe('toMoneyString', () => {
  it('normalises the shapes Prisma and clients actually produce', () => {
    expect(toMoneyString('12.5')).toBe('12.50');
    expect(toMoneyString(12.5)).toBe('12.50');
    // A Decimal arrives as an object whose toString is faithful.
    expect(toMoneyString({ toString: () => '1250.00' })).toBe('1250.00');
  });

  it('treats a missing amount as zero rather than NaN', () => {
    expect(toMoneyString(null)).toBe('0.00');
    expect(toMoneyString(undefined)).toBe('0.00');
  });
});

describe('sumAmounts', () => {
  it('does not lose a penny across many lines', () => {
    // The whole reason for integer arithmetic. Summing these as floats gives
    // 0.30000000000000004; ten thousand of those is a reconciliation dispute.
    expect(sumAmounts(['0.10', '0.20'])).toBe('0.30');
  });

  it('stays exact over a long list', () => {
    const lines = Array.from({ length: 1000 }, () => '0.01');
    expect(sumAmounts(lines)).toBe('10.00');
  });

  it('sums realistic invoice lines', () => {
    expect(sumAmounts(['1250.00', '380.00', '2840.00', '145.00'])).toBe('4615.00');
  });

  it('sums an empty invoice to zero', () => {
    expect(sumAmounts([])).toBe('0.00');
  });
});

describe('applyPayment', () => {
  const total = 100_00; // £100.00

  it('records a partial payment and reports what is left', () => {
    const result = applyPayment(total, 0, 30_00);
    expect(result.paidMinor).toBe(3000);
    expect(result.outstandingMinor).toBe(7000);
    expect(result.fullySettled).toBe(false);
  });

  it('settles an invoice when the final penny arrives', () => {
    const result = applyPayment(total, 99_99, 1);
    expect(result.fullySettled).toBe(true);
    expect(result.outstandingMinor).toBe(0);
  });

  it('accumulates across several payments exactly', () => {
    let paid = 0;
    for (const amount of [33_33, 33_33, 33_34]) {
      paid = applyPayment(total, paid, amount).paidMinor;
    }
    expect(paid).toBe(total);
  });

  describe('refusing what it cannot represent honestly', () => {
    it('rejects an overpayment rather than absorbing it', () => {
      // A credit balance needs refunds and credit notes to be a real feature.
      // Swallowing the excess loses the patient's money with no record.
      expect(() => applyPayment(total, 0, 150_00)).toThrow(/exceeds/);
    });

    it('rejects a payment that would overshoot the remainder', () => {
      expect(() => applyPayment(total, 90_00, 20_00)).toThrow(/exceeds/);
    });

    it('rejects paying an already-settled invoice', () => {
      expect(() => applyPayment(total, total, 1_00)).toThrow(/already settled/);
    });

    it.each([0, -1, -500])('rejects a payment of %i', (amount) => {
      expect(() => applyPayment(total, 0, amount)).toThrow(/greater than zero/);
    });
  });
});
