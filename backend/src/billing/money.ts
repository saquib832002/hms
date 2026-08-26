/**
 * Money.
 *
 * THE RULE: currency is never a JavaScript number in transit or in arithmetic.
 *
 * `0.1 + 0.2 === 0.30000000000000004`. On one invoice line that is invisible;
 * across a few thousand payments it is a reconciliation dispute nobody can
 * explain, and the person who has to explain it is a finance clerk who did
 * nothing wrong.
 *
 * So:
 *  - Postgres stores `Decimal(10,2)` — exact.
 *  - Application arithmetic happens in **integer minor units** (pence/cents).
 *  - The API sends and receives **strings** — `"1250.00"`, never `1250.0`.
 *
 * The string boundary matters as much as the integer arithmetic. Prisma hands
 * back a `Decimal` object; `JSON.stringify` turns that into whatever its
 * `toJSON` decides, and a client doing `parseFloat` on the way in has already
 * lost. A string survives the round trip untouched.
 */

/** Smallest currency unit — 2 decimal places. Not configurable on purpose. */
const MINOR_UNITS_PER_MAJOR = 100;
const DECIMAL_PLACES = 2;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Parses a currency string into integer minor units.
 *
 * Accepts `"12"`, `"12.5"`, `"12.50"`, `"1,250.00"`. Rejects anything else
 * rather than coercing — `Number("12.5.6")` is `NaN` and `parseFloat("12abc")`
 * is `12`, and both of those silently becoming a payment amount is exactly the
 * failure this guards against.
 */
export function toMinor(value: string | number): number {
  if (typeof value === 'number') {
    // A number has already been through float representation. Accept only
    // values that are unambiguously safe, and reject the rest loudly so the
    // caller fixes the boundary rather than the symptom.
    if (!Number.isFinite(value)) throw new MoneyError('Amount is not a finite number');
    if (!Number.isInteger(value * MINOR_UNITS_PER_MAJOR)) {
      throw new MoneyError(
        `Amount ${value} cannot be represented exactly — pass currency as a string`,
      );
    }
    return Math.round(value * MINOR_UNITS_PER_MAJOR);
  }

  const cleaned = value.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new MoneyError(`"${value}" is not a valid amount`);
  }

  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = cleaned.replace('-', '').split('.');
  const padded = fraction.padEnd(DECIMAL_PLACES, '0');
  const minor = Number(whole) * MINOR_UNITS_PER_MAJOR + Number(padded);

  if (!Number.isSafeInteger(minor)) throw new MoneyError('Amount is too large');
  return negative ? -minor : minor;
}

/** Integer minor units back to the canonical string form. */
export function fromMinor(minor: number): string {
  if (!Number.isInteger(minor)) {
    throw new MoneyError(`${minor} is not a whole number of minor units`);
  }
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_UNITS_PER_MAJOR);
  const fraction = abs % MINOR_UNITS_PER_MAJOR;
  return `${negative ? '-' : ''}${whole}.${String(fraction).padStart(DECIMAL_PLACES, '0')}`;
}

/**
 * Normalises anything money-shaped to the canonical string.
 *
 * Prisma `Decimal` arrives as an object with `toString`. Passing that straight
 * into JSON is how `"1250"` and `"1250.00"` end up in the same response.
 */
export function toMoneyString(value: unknown): string {
  if (value === null || value === undefined) return '0.00';
  if (typeof value === 'string') return fromMinor(toMinor(value));
  if (typeof value === 'number') return fromMinor(toMinor(value));
  // Decimal, or anything else with a faithful toString.
  return fromMinor(toMinor(String(value)));
}

export function sumMinor(values: number[]): number {
  return values.reduce((total, v) => {
    if (!Number.isInteger(v)) throw new MoneyError('Cannot sum non-integer minor units');
    return total + v;
  }, 0);
}

/** Line totals summed in minor units, returned as a string. */
export function sumAmounts(amounts: (string | number | unknown)[]): string {
  return fromMinor(sumMinor(amounts.map((a) => toMinor(toMoneyString(a)))));
}

export function isPositive(minor: number): boolean {
  return minor > 0;
}

export interface PaymentOutcome {
  /** Total paid after this payment, in minor units. */
  paidMinor: number;
  outstandingMinor: number;
  fullySettled: boolean;
}

/**
 * Applies a payment to an invoice.
 *
 * Overpayment is rejected rather than absorbed. A credit balance is a real
 * feature — it needs refunds, credit notes, and a way to apply the credit to a
 * future invoice — and a half-built version that just swallows the excess loses
 * the patient's money with no record of where it went. Better to refuse and
 * say so.
 */
export function applyPayment(
  totalMinor: number,
  alreadyPaidMinor: number,
  paymentMinor: number,
): PaymentOutcome {
  if (paymentMinor <= 0) throw new MoneyError('A payment must be greater than zero');

  const outstandingBefore = totalMinor - alreadyPaidMinor;
  if (outstandingBefore <= 0) {
    throw new MoneyError('That invoice is already settled');
  }
  if (paymentMinor > outstandingBefore) {
    throw new MoneyError(
      `Payment of ${fromMinor(paymentMinor)} exceeds the ${fromMinor(outstandingBefore)} outstanding`,
    );
  }

  const paidMinor = alreadyPaidMinor + paymentMinor;
  return {
    paidMinor,
    outstandingMinor: totalMinor - paidMinor,
    fullySettled: paidMinor === totalMinor,
  };
}
