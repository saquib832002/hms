/**
 * What a line of medicine costs.
 *
 * WHY THIS IS NOT `money.ts`
 * -------------------------
 * `money.ts` handles amounts in the currency's own precision — two decimal
 * places, integer minor units, exact. That is right for an invoice total, a
 * payment and a refund, and it is wrong for a unit price.
 *
 * A tablet costs 0.35. Or 0.0725, which is a perfectly ordinary trade price for
 * something bought in boxes of a thousand. Rounding that to 0.07 before
 * multiplying by 30 undercharges by nearly eight percent, and rounding it to
 * 0.08 overcharges by the same — on every box, forever, invisibly. So unit
 * prices are held at four decimal places and the rounding happens exactly once,
 * on the line total, in the currency's own precision.
 *
 * "Round once, at the end" is the whole of the rule, and the reason this file
 * exists rather than a `Math.round` at the call site: the multiply and the round
 * have to happen in the same place or somebody will eventually do them in the
 * other order.
 *
 * Everything here is integer arithmetic and pure. `0.1 + 0.2` is wrong in this
 * file too.
 */

import { MoneyError, fromMinor } from '../billing/money';

/** Unit prices are stored and reasoned about in 1/10,000 of a major unit. */
const PRICE_UNITS_PER_MAJOR = 10_000;
const PRICE_DECIMAL_PLACES = 4;

/** Minor units — pence, cents. What a line total is measured in. */
const MINOR_UNITS_PER_MAJOR = 100;

/** How many price units make one minor unit. 10000 / 100. */
const PRICE_UNITS_PER_MINOR = PRICE_UNITS_PER_MAJOR / MINOR_UNITS_PER_MAJOR;

/**
 * Parses a unit-price string into integer price units.
 *
 * Same refusal-to-coerce as `toMinor`: `parseFloat("0.35abc")` is `0.35`, and a
 * price that silently parses out of a typo is worse than one that is rejected.
 */
export function toPriceUnits(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const text = typeof value === 'number' ? String(value) : value.trim().replace(/,/g, '');
  if (text === '') return null;

  if (!/^\d+(\.\d{1,4})?$/.test(text)) {
    throw new MoneyError(`"${value}" is not a valid price — up to four decimal places, no minus`);
  }

  const [whole, fraction = ''] = text.split('.');
  const units = Number(whole) * PRICE_UNITS_PER_MAJOR + Number(fraction.padEnd(PRICE_DECIMAL_PLACES, '0'));

  if (!Number.isSafeInteger(units)) throw new MoneyError('Price is too large');
  return units;
}

/** Integer price units back to the canonical four-decimal string. */
export function fromPriceUnits(units: number): string {
  if (!Number.isInteger(units)) {
    throw new MoneyError(`${units} is not a whole number of price units`);
  }
  const whole = Math.floor(units / PRICE_UNITS_PER_MAJOR);
  const fraction = units % PRICE_UNITS_PER_MAJOR;
  return `${whole}.${String(fraction).padStart(PRICE_DECIMAL_PLACES, '0')}`;
}

/** Normalises anything price-shaped — including a Prisma `Decimal` — to a string. */
export function toPriceString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const units = toPriceUnits(typeof value === 'string' || typeof value === 'number' ? value : String(value));
  return units === null ? null : fromPriceUnits(units);
}

/**
 * `unitPrice × quantity`, in minor units, rounded once.
 *
 * HALF-UP, AND SAID OUT LOUD
 * --------------------------
 * JavaScript's `Math.round` is half-up for positives, which is what a till does
 * and what a customer expects. Banker's rounding is defensible for large
 * aggregates and surprising on a receipt for three boxes of paracetamol, so it
 * is not used — but the choice is written down, because a rounding convention
 * that nobody recorded is one that gets changed by accident.
 *
 * Prices are non-negative (`toPriceUnits` refuses a minus), so the positive-only
 * behaviour of `Math.round` is not a trap here.
 */
export function lineTotalMinor(priceUnits: number, quantity: number): number {
  if (!Number.isInteger(priceUnits) || priceUnits < 0) {
    throw new MoneyError('Unit price must be a whole, non-negative number of price units');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new MoneyError('Quantity must be a whole number greater than zero');
  }

  const exact = priceUnits * quantity;
  if (!Number.isSafeInteger(exact)) throw new MoneyError('Line total is too large');

  return Math.round(exact / PRICE_UNITS_PER_MINOR);
}

export interface PricedLine {
  medicineId: number;
  quantity: number;
  /** NULL where the medicine has no price set. */
  priceUnits: number | null;
}

export interface PricingResult {
  /** Sum of every line that could be priced, in minor units. */
  totalMinor: number;
  /** Line totals in the same order, `null` where unpriced. */
  lineTotals: (number | null)[];
  /** Medicine ids that had no price. */
  unpricedMedicineIds: number[];
}

/**
 * Prices a whole sale.
 *
 * UNPRICED IS NOT FREE, AND IT IS NOT AN ERROR EITHER
 * ---------------------------------------------------
 * A medicine with no `sellingPrice` is one nobody has got round to pricing. The
 * two tempting responses are both wrong:
 *
 *  - Charge zero. The stock leaves the shelf, the invoice looks settled, and
 *    the first anyone knows is a month of unbilled dispensing. This is the same
 *    argument as `Doctor.consultationFee`, where blank and zero were
 *    deliberately kept apart for exactly this reason.
 *  - Refuse to dispense. Now an unset price stops a patient getting medicine,
 *    which is a clerical omission being enforced as a clinical decision.
 *
 * So: price what can be priced, hand over everything, and report back which
 * items were not charged. The pharmacist sees it on the screen, and the admin
 * dashboard counts it the way it already counts doctors with no fee.
 */
export function priceSale(lines: PricedLine[]): PricingResult {
  const lineTotals: (number | null)[] = [];
  const unpriced: number[] = [];
  let totalMinor = 0;

  for (const line of lines) {
    if (line.priceUnits === null) {
      lineTotals.push(null);
      if (!unpriced.includes(line.medicineId)) unpriced.push(line.medicineId);
      continue;
    }
    const total = lineTotalMinor(line.priceUnits, line.quantity);
    lineTotals.push(total);
    totalMinor += total;
  }

  if (!Number.isSafeInteger(totalMinor)) throw new MoneyError('Sale total is too large');

  return { totalMinor, lineTotals, unpricedMedicineIds: unpriced };
}

/** Convenience for messages and responses. */
export function saleTotalString(result: PricingResult): string {
  return fromMinor(result.totalMinor);
}
