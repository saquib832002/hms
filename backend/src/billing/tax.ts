/**
 * Tax on a line, for hospitals that have to charge it.
 *
 * WHY A NAMED RATE PER ITEM AND NOT ONE PERCENTAGE
 * ------------------------------------------------
 * A single "tax %" in settings is wrong in both of the places this system is
 * aimed at, and wrong in opposite directions.
 *
 * In India, GST on medicines is commonly 5% or 12%, some items are 18% and
 * some are nil-rated — so one pharmacy stocks several rates at once. Healthcare
 * *services* are largely exempt, so a consultation carries no GST while the
 * medicines dispensed at the same visit do.
 *
 * In the United States there is no national tax at all; a rate is state plus
 * county plus city, and **prescription drugs are exempt in most states** while
 * over-the-counter items usually are not.
 *
 * The common shape is not a percentage. It is: *a named rate, chosen per
 * thing sold.* So the hospital defines the rates it actually uses and points
 * each medicine at one. A hospital that charges no tax defines nothing, every
 * line resolves to zero, and the invoice looks exactly as it does today.
 *
 * WHY BASIS POINTS
 * ----------------
 * `1250` is 12.5%. An integer, because a rate is compared, stored and summed,
 * and 0.125 as a float is the same trap as money as a float — `pricing.ts`
 * already says why. Basis points also express the rates that actually exist
 * (8.25% sales tax is 825) without a decimal anywhere.
 */

/** 100% — the denominator for a basis-point rate. */
const BASIS = 10_000;

export interface TaxedLine {
  /** Before tax, in integer minor units. */
  netMinor: number;
  /** The tax itself, in integer minor units. */
  taxMinor: number;
  /** What the customer pays for this line: `netMinor + taxMinor`, exactly. */
  grossMinor: number;
  /** Captured so the invoice records the rate that was actually applied. */
  rateBasisPoints: number;
}

/**
 * Whether the price already has tax in it.
 *
 * INCLUSIVE is not a display preference. In India the MRP printed on the box
 * includes GST, and that is the number the pharmacist reads out and the
 * patient expects to pay; entering prices net of GST would mean re-deriving
 * every price from a figure nobody can see. In the United States the shelf
 * price is net and tax is added at the till.
 *
 * Both are "the price is 10.00" and they mean different amounts of money, so
 * the mode is recorded on the invoice rather than only in settings — a rate
 * change or a settings change must not restate what somebody was charged.
 */
export type PriceBasis = 'EXCLUSIVE' | 'INCLUSIVE';

/**
 * Split one line into net, tax and gross.
 *
 * `amountMinor` is the line total already computed from unit price × quantity
 * and rounded once — see `pricing.ts`. Tax is applied to that, not to the unit
 * price, for the same reason: rounding a fraction of a penny per tablet and
 * then multiplying by thirty is wrong in one direction, every time.
 *
 * THE RULE THAT KEEPS AN INVOICE HONEST
 * -------------------------------------
 * `net + tax === gross`, always, with no rounding residue. In INCLUSIVE mode
 * the net is computed and the tax is then derived **by subtraction** rather
 * than calculated independently. Calculating both and hoping they add up is
 * how an invoice ends up a penny out from its own lines — and a finance clerk
 * cannot explain a total that does not equal the sum of its parts.
 */
export function taxLine(
  amountMinor: number,
  rateBasisPoints: number,
  basis: PriceBasis,
): TaxedLine {
  const rate = Number.isFinite(rateBasisPoints) ? Math.max(0, Math.trunc(rateBasisPoints)) : 0;
  const amount = Number.isFinite(amountMinor) ? Math.trunc(amountMinor) : 0;

  if (rate === 0) {
    // Zero-rated and exempt both land here. They differ on a statutory
    // invoice and not in the arithmetic; the *name* on the rate carries that
    // distinction, which is one reason rates are named rather than numeric.
    return { netMinor: amount, taxMinor: 0, grossMinor: amount, rateBasisPoints: 0 };
  }

  if (basis === 'EXCLUSIVE') {
    const taxMinor = Math.round((amount * rate) / BASIS);
    return {
      netMinor: amount,
      taxMinor,
      grossMinor: amount + taxMinor,
      rateBasisPoints: rate,
    };
  }

  /*
   * Inclusive: the amount already contains the tax.
   *
   *   net = gross × 10000 / (10000 + rate)
   *
   * Rounded half-up once, then tax is whatever is left over. That subtraction
   * is what guarantees the three figures reconcile.
   */
  const netMinor = Math.round((amount * BASIS) / (BASIS + rate));
  return {
    netMinor,
    taxMinor: amount - netMinor,
    grossMinor: amount,
    rateBasisPoints: rate,
  };
}

/**
 * Roll several taxed lines into invoice totals.
 *
 * Summed from the already-rounded lines rather than recomputed from a total,
 * so the invoice equals the sum of what is printed on it. Recomputing tax on
 * the basket total is a different number whenever two rates are present, and
 * it is the one nobody can reconcile against the lines.
 */
export function taxTotals(lines: TaxedLine[]): {
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  /** Per rate, for the breakdown a statutory invoice has to show. */
  byRate: { rateBasisPoints: number; netMinor: number; taxMinor: number }[];
} {
  const byRate = new Map<number, { netMinor: number; taxMinor: number }>();

  for (const l of lines) {
    const at = byRate.get(l.rateBasisPoints) ?? { netMinor: 0, taxMinor: 0 };
    at.netMinor += l.netMinor;
    at.taxMinor += l.taxMinor;
    byRate.set(l.rateBasisPoints, at);
  }

  return {
    netMinor: lines.reduce((s, l) => s + l.netMinor, 0),
    taxMinor: lines.reduce((s, l) => s + l.taxMinor, 0),
    grossMinor: lines.reduce((s, l) => s + l.grossMinor, 0),
    byRate: [...byRate.entries()]
      .map(([rateBasisPoints, v]) => ({ rateBasisPoints, ...v }))
      .sort((a, b) => a.rateBasisPoints - b.rateBasisPoints),
  };
}

/** `1250` → `"12.5%"`. For labels and the invoice breakdown. */
export function formatRate(rateBasisPoints: number): string {
  const pct = rateBasisPoints / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0$/, '')}%`;
}

/**
 * A rate a hospital may enter.
 *
 * Capped at 100% because a rate above that is a typo — somebody entering a
 * percentage where basis points were wanted — and multiplying a basket out by
 * it would produce a confident, enormous, wrong number on a bill.
 */
export function isValidRate(rateBasisPoints: number): boolean {
  return (
    Number.isInteger(rateBasisPoints) && rateBasisPoints >= 0 && rateBasisPoints <= BASIS
  );
}


/**
 * One named part of a rate: "CGST 6%", "State 4%", "County 1.5%".
 *
 * WHY COMPONENTS RATHER THAN SEVERAL RATES PER ITEM
 * -------------------------------------------------
 * India charges CGST and SGST on the same taxable value — 12% GST is 6% + 6%,
 * not 6% applied and then 6% applied to the result. The United States is the
 * same shape: state plus county plus city, each on the shelf price. Applying
 * rates in sequence would *compound* them, which is wrong in both places and
 * wrong by a growing amount as the rates rise.
 *
 * So a `TaxRate` is a group whose components sum to it, and the arithmetic is
 * unchanged: tax is still worked out once, at the combined rate. The
 * components exist because an invoice has to *show* the split — an Indian
 * statutory invoice is not valid without CGST and SGST as separate lines, and
 * a US receipt that says "tax 6.00" cannot be reconciled by anybody.
 *
 * Compounding is deliberately not supported rather than half-supported. It is
 * rare (Quebec dropped it in 2013), it would need an explicit ordering, and a
 * silent guess about which rate compounds on which is the kind of error that
 * shows up as an unexplainable few pence on every invoice.
 */
export interface TaxComponent {
  name: string;
  rateBasisPoints: number;
}

export interface AppliedComponent extends TaxComponent {
  /** This component's share of the line's tax, in integer minor units. */
  amountMinor: number;
}

/**
 * Split a line's tax across its components so they sum to it **exactly**.
 *
 * THE REASON THIS IS NOT JUST A MULTIPLICATION PER COMPONENT
 * ----------------------------------------------------------
 * Computing each component independently and rounding each one leaves the
 * parts disagreeing with the whole. On a 12% tax of 1.05 split 6/6, each half
 * is 0.525: round both up and the invoice shows 0.54 + 0.54 = 1.08 against a
 * total of 1.05. A statutory invoice whose components do not add to its own
 * tax line is one an auditor rejects and a clerk cannot explain.
 *
 * So the total is authoritative — it came from `taxLine`, which already
 * guarantees `net + tax === gross` — and it is *apportioned*. Largest
 * remainder: floor everything, then give the leftover pennies to whichever
 * components were rounded down hardest. Ties go to the earlier component,
 * which makes the result stable rather than dependent on sort order.
 */
export function apportionTax(
  totalTaxMinor: number,
  components: TaxComponent[],
): AppliedComponent[] {
  if (components.length === 0 || totalTaxMinor === 0) {
    return components.map((c) => ({ ...c, amountMinor: 0 }));
  }

  const totalRate = components.reduce((s, c) => s + Math.max(0, c.rateBasisPoints), 0);
  if (totalRate <= 0) return components.map((c) => ({ ...c, amountMinor: 0 }));

  const exact = components.map((c) => (totalTaxMinor * Math.max(0, c.rateBasisPoints)) / totalRate);
  const floored = exact.map((v) => Math.floor(v));
  let remaining = totalTaxMinor - floored.reduce((s, v) => s + v, 0);

  const order = exact
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    // Descending remainder; index ascending on a tie, so the result does not
    // depend on the order a sort happens to produce.
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);

  const amounts = [...floored];
  for (const { i } of order) {
    if (remaining <= 0) break;
    amounts[i] += 1;
    remaining -= 1;
  }

  return components.map((c, i) => ({ ...c, amountMinor: amounts[i] }));
}

/** The combined rate of a group. What `taxLine` is actually given. */
export function combinedRate(components: TaxComponent[]): number {
  return components.reduce((s, c) => s + Math.max(0, Math.trunc(c.rateBasisPoints)), 0);
}
