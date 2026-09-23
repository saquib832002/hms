import {
  TaxComponent,
  apportionTax,
  combinedRate,
  formatRate,
  isValidRate,
  taxLine,
  taxTotals,
} from './tax';

/**
 * Tax arithmetic.
 *
 * The property that matters more than any individual number: **net + tax
 * always equals gross, exactly**. An invoice whose total does not equal the
 * sum of its own lines is one a finance clerk cannot explain and a patient
 * will not accept, and a penny of rounding residue is enough to cause it.
 */

describe('exclusive — tax added at the till', () => {
  it('adds the rate to the line', () => {
    // 35.00 at 8.25% sales tax → 2.89 tax, 37.89 to pay.
    const l = taxLine(3500, 825, 'EXCLUSIVE');
    expect(l).toEqual({ netMinor: 3500, taxMinor: 289, grossMinor: 3789, rateBasisPoints: 825 });
  });

  it('reconciles exactly', () => {
    for (const amount of [1, 7, 99, 100, 3500, 123_456]) {
      for (const rate of [0, 500, 825, 1200, 1800]) {
        const l = taxLine(amount, rate, 'EXCLUSIVE');
        expect(l.netMinor + l.taxMinor).toBe(l.grossMinor);
      }
    }
  });
});

describe('inclusive — the price already contains the tax', () => {
  it('extracts the tax from an Indian MRP', () => {
    /*
     * A box marked 112.00 at 12% GST is 100.00 plus 12.00. The patient pays
     * what the box says; the invoice has to show the split.
     */
    const l = taxLine(11_200, 1200, 'INCLUSIVE');
    expect(l.grossMinor).toBe(11_200);
    expect(l.netMinor).toBe(10_000);
    expect(l.taxMinor).toBe(1200);
  });

  it('derives tax by subtraction so the three always reconcile', () => {
    /*
     * The rule this file exists for. Computing net and tax independently and
     * hoping they add up leaves a penny adrift on amounts that do not divide
     * cleanly — which is most of them.
     */
    for (const amount of [1, 3, 7, 99, 101, 999, 3500, 11_201, 987_654]) {
      for (const rate of [500, 1200, 1800, 825]) {
        const l = taxLine(amount, rate, 'INCLUSIVE');
        expect(l.netMinor + l.taxMinor).toBe(l.grossMinor);
        expect(l.grossMinor).toBe(amount);
      }
    }
  });

  it('never takes more tax than the amount', () => {
    // A one-penny line at 18% has no meaningful tax in it. What it must not
    // do is produce a negative net.
    const l = taxLine(1, 1800, 'INCLUSIVE');
    expect(l.netMinor).toBeGreaterThan(0);
    expect(l.taxMinor).toBeGreaterThanOrEqual(0);
  });
});

describe('no tax is the default, and costs nothing', () => {
  it('leaves a zero-rated line untouched in both modes', () => {
    for (const basis of ['EXCLUSIVE', 'INCLUSIVE'] as const) {
      const l = taxLine(3500, 0, basis);
      expect(l).toEqual({ netMinor: 3500, taxMinor: 0, grossMinor: 3500, rateBasisPoints: 0 });
    }
  });

  it('treats a nonsense rate as no tax rather than guessing', () => {
    // A negative or non-finite rate is a bug upstream. Charging something
    // invented from it would be worse than charging nothing.
    expect(taxLine(3500, -5, 'EXCLUSIVE').taxMinor).toBe(0);
    expect(taxLine(3500, Number.NaN, 'EXCLUSIVE').taxMinor).toBe(0);
  });
});

describe('invoice totals', () => {
  it('sums the printed lines rather than recomputing from a basket total', () => {
    /*
     * With two rates present, tax on the summed basket is a different number
     * from the sum of the per-line taxes — and it is the one that cannot be
     * reconciled against what is printed.
     */
    const lines = [
      taxLine(10_000, 500, 'EXCLUSIVE'), // 5%  → 500
      taxLine(3333, 1200, 'EXCLUSIVE'), // 12% → 400
      taxLine(2500, 0, 'EXCLUSIVE'), // exempt
    ];
    const t = taxTotals(lines);

    expect(t.netMinor).toBe(10_000 + 3333 + 2500);
    expect(t.taxMinor).toBe(500 + 400);
    expect(t.netMinor + t.taxMinor).toBe(t.grossMinor);
  });

  it('breaks down by rate, for a statutory invoice', () => {
    const t = taxTotals([
      taxLine(10_000, 1200, 'EXCLUSIVE'),
      taxLine(5000, 1200, 'EXCLUSIVE'),
      taxLine(2000, 500, 'EXCLUSIVE'),
    ]);

    expect(t.byRate).toEqual([
      { rateBasisPoints: 500, netMinor: 2000, taxMinor: 100 },
      { rateBasisPoints: 1200, netMinor: 15_000, taxMinor: 1800 },
    ]);
  });

  it('is empty rather than wrong for an empty basket', () => {
    expect(taxTotals([])).toEqual({ netMinor: 0, taxMinor: 0, grossMinor: 0, byRate: [] });
  });
});

describe('what a hospital may enter', () => {
  it('refuses a rate above 100%', () => {
    /*
     * The realistic mistake is typing 12 where 1200 was wanted, or 12000
     * meaning 120%. The first is caught by looking at the label; the second
     * would multiply a basket out to something enormous and confident.
     */
    expect(isValidRate(1200)).toBe(true);
    expect(isValidRate(0)).toBe(true);
    expect(isValidRate(10_000)).toBe(true);
    expect(isValidRate(10_001)).toBe(false);
    expect(isValidRate(-1)).toBe(false);
    expect(isValidRate(12.5)).toBe(false);
  });

  it('formats a rate the way it is spoken', () => {
    expect(formatRate(1200)).toBe('12%');
    expect(formatRate(500)).toBe('5%');
    expect(formatRate(825)).toBe('8.25%');
    expect(formatRate(0)).toBe('0%');
  });
});


describe('a rate made of several components', () => {
  const GST12 = [
    { name: 'CGST', rateBasisPoints: 600 },
    { name: 'SGST', rateBasisPoints: 600 },
  ];
  const US = [
    { name: 'State', rateBasisPoints: 400 },
    { name: 'County', rateBasisPoints: 150 },
    { name: 'City', rateBasisPoints: 50 },
  ];

  it('adds, never compounds', () => {
    /*
     * 6% + 6% is 12%, not 12.36%. Both are charged on the same taxable value —
     * in India and in the United States alike. Applying them in sequence is
     * the mistake this guards against, and it grows with the rate.
     */
    expect(combinedRate(GST12)).toBe(1200);
    expect(combinedRate(US)).toBe(600);
  });

  it('splits a clean amount evenly', () => {
    // 12% of 100.00 is 12.00 → 6.00 CGST + 6.00 SGST.
    const { taxMinor } = taxLine(10_000, combinedRate(GST12), 'EXCLUSIVE');
    expect(apportionTax(taxMinor, GST12)).toEqual([
      { name: 'CGST', rateBasisPoints: 600, amountMinor: 600 },
      { name: 'SGST', rateBasisPoints: 600, amountMinor: 600 },
    ]);
  });

  it('makes the parts sum to the whole, always', () => {
    /*
     * The property the whole function exists for. Computing each component
     * independently and rounding leaves them disagreeing with the tax line
     * above them — a statutory invoice whose components do not add up is one
     * an auditor rejects and a clerk cannot explain.
     */
    for (const amount of [1, 7, 33, 105, 999, 1234, 98_765]) {
      for (const components of [GST12, US]) {
        for (const basis of ['EXCLUSIVE', 'INCLUSIVE'] as const) {
          const { taxMinor } = taxLine(amount, combinedRate(components), basis);
          const parts = apportionTax(taxMinor, components);
          expect(parts.reduce((s, p) => s + p.amountMinor, 0)).toBe(taxMinor);
        }
      }
    }
  });

  it('gives the odd penny to the largest remainder, stably', () => {
    /*
     * 1.05 at 12% is 0.126 → 13 minor units of tax, split 6/6. Half of 13 is
     * 6.5 each: one gets 7, one gets 6. Which one must not depend on sort
     * order, or two runs of the same report disagree.
     */
    const { taxMinor } = taxLine(105, 1200, 'EXCLUSIVE');
    const first = apportionTax(taxMinor, GST12);
    const second = apportionTax(taxMinor, GST12);
    expect(first).toEqual(second);
    expect(first.reduce((s, p) => s + p.amountMinor, 0)).toBe(taxMinor);
  });

  it('never invents tax for a zero-rated group', () => {
    expect(apportionTax(0, GST12).every((p) => p.amountMinor === 0)).toBe(true);
    expect(apportionTax(500, [{ name: 'Nil', rateBasisPoints: 0 }])).toEqual([
      { name: 'Nil', rateBasisPoints: 0, amountMinor: 0 },
    ]);
  });

  it('is a no-op for a rate with no components', () => {
    // The ordinary case: one flat rate, no split to show. Nothing changes.
    expect(apportionTax(1200, [])).toEqual([]);
    expect(combinedRate([])).toBe(0);
  });
});


describe('every active tax applies, not just one', () => {
  /*
   * The model this was rebuilt to, and the bug it replaced.
   *
   * A hospital entering CGST 6% and SGST 6% as two rates had one marked
   * "default" and the other simply not applied — half the tax collected, on an
   * invoice that looked entirely plausible, until somebody reconciled a
   * return. The rule now is: every active rate applies to every sale unless an
   * item names one specifically.
   */
  const activeRates = [
    { name: 'CGST', rateBasisPoints: 600, components: [] as TaxComponent[] },
    { name: 'SGST', rateBasisPoints: 600, components: [] as TaxComponent[] },
  ];

  /** Mirrors how the services flatten rates into printable components. */
  const flatten = (rates: typeof activeRates) =>
    rates.flatMap((r) =>
      r.components.length > 0 ? r.components : [{ name: r.name, rateBasisPoints: r.rateBasisPoints }],
    );

  it('adds two separate rates rather than picking one', () => {
    expect(combinedRate(flatten(activeRates))).toBe(1200);
  });

  it('prints one line per rate, summing to the tax charged', () => {
    const parts = flatten(activeRates);
    const { taxMinor } = taxLine(10_000, combinedRate(parts), 'EXCLUSIVE');

    const rows = apportionTax(taxMinor, parts);
    expect(rows.map((r) => r.name)).toEqual(['CGST', 'SGST']);
    expect(rows.reduce((s, r) => s + r.amountMinor, 0)).toBe(taxMinor);
    expect(taxMinor).toBe(1200);
  });

  it('treats a rate that has its own parts identically', () => {
    // A hospital may express GST as one 12% rate split 6/6, or as two 6%
    // rates. Both must produce the same charge and the same two invoice lines,
    // because the difference is bookkeeping preference, not tax law.
    const asOneRate = [
      {
        name: 'GST',
        rateBasisPoints: 1200,
        components: [
          { name: 'CGST', rateBasisPoints: 600 },
          { name: 'SGST', rateBasisPoints: 600 },
        ],
      },
    ];

    expect(combinedRate(flatten(asOneRate))).toBe(combinedRate(flatten(activeRates)));
    expect(flatten(asOneRate).map((c) => c.name)).toEqual(['CGST', 'SGST']);
  });
});
