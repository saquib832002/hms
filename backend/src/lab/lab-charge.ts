import { InvoiceItemKind, InvoiceKind, LabBillingMode } from '@prisma/client';
import { apportionTax, PriceBasis, taxLine, taxTotals } from '../billing/tax';
import { fromMinor } from '../billing/money';
import { fromPriceUnits, lineTotalMinor } from '../pharmacy/pricing';

/**
 * Turning ordered tests into a charge.
 *
 * WHAT A LAB LINE SAYS, AND WHO IS ALLOWED TO READ IT
 * --------------------------------------------------
 * A LAB_TEST line names the test, because a receipt that does not say what was
 * bought is not a receipt. And a test name is the sharpest clinical leak an
 * invoice can carry — sharper than a drug name, which was already ruled on
 * here. A drug *implies* a condition. A test frequently **is** the question:
 * "HIV antibody", "Beta-hCG", "Drug screen", "Chlamydia PCR". Each of those on
 * a bill tells a billing clerk something the patient told their doctor in
 * confidence and quite possibly told nobody else.
 *
 * So the itemisation exists and the *response* is shaped by role, exactly as it
 * is for medicines. See `invoice-response.ts`; billing staff get
 * `LAB · Tests (n items)` with a total and no test names at all.
 *
 * WHEN THE CHARGE IS RAISED
 * -------------------------
 * At ordering, not at resulting. A consultation is billed at check-in because
 * that is when the patient is standing at the desk; a test is the same — the
 * hospital commits to doing it, and the patient pays before they walk out.
 *
 * Cancelling *before* any specimen was collected voids the charge, because
 * nothing happened — the same honesty as reversing a dispense that never left
 * the counter. Cancelling afterwards does not: the sample was taken, the
 * reagent was used, and inventing a refund for real work is the mirror error.
 *
 * **And it gates nothing.** No part of the collection, resulting or reporting
 * path checks whether an invoice exists or has been paid. Refusing to run a
 * blood test because a card was declined is not a decision software should make
 * on a clinic's behalf, and `lab-billing.spec.ts` asserts the absence of such a
 * check for the same reason `consultation-billing.spec.ts` does.
 */

/** A test being ordered, with the price it is being charged at. */
export interface ChargeableTest {
  orderItemId: number;
  testCode: string;
  testName: string;
  /** Price units (4dp), or null when nobody has priced this test. */
  priceUnits: number | null;
  taxRateBasisPoints?: number;
  taxRateName?: string | null;
  taxComponents?: { name: string; rateBasisPoints: number }[];
}

export interface PricedLabCharge {
  /** What the patient pays: net plus tax. */
  totalMinor: number;
  taxMinor: number;
  netMinor: number;
  items: {
    orderItemId: number;
    description: string;
    quantity: number;
    unitPrice: string;
    /** NET of tax; `taxAmount` completes it. */
    amount: string;
    taxAmount: string;
    taxRateBasisPoints: number;
    taxRateName: string | null;
    taxBreakdown: { name: string; rateBasisPoints: number; amount: string }[] | null;
  }[];
  /**
   * Tests that went ahead with no price on them.
   *
   * Named back to the person who ordered them rather than silently treated as
   * free — the same rule as an unpriced medicine, and it fails the same way:
   * a month of unbilled work discovered in a report.
   */
  unpriced: string[];
}

/**
 * `LAB · <code> <name>`.
 *
 * Prefixed like `CONS ·` and `PHARM ·` so a mixed invoice reads as a list of
 * departments. The code goes first because that is what a hospital reconciles
 * against its own tariff.
 */
export function labLineDescription(
  test: { testCode: string; testName: string },
  accession?: string | null,
): string {
  /*
   * The specimen number, where there is one.
   *
   * This is how a real laboratory invoice references work: the line names the
   * examination and the accession, so a query about a charge and a query about
   * a result are the same query. Without it, reconciling a bill against a
   * worklist means matching on patient and date and hoping.
   *
   * Safe on a bill in a way a test name is not — it is an opaque key that says
   * nothing about what was investigated, which is why it can appear here while
   * `labSummaryDescription` still refuses to name a discipline.
   */
  const ref = accession ? `${accession} · ` : '';
  return `LAB · ${ref}${test.testCode} ${test.testName}`;
}

/**
 * The rolled-up line billing staff see instead of the itemisation.
 *
 * Built from a count and nothing else, and held to exactly the standard
 * `pharmacySummaryDescription` is held to: no template literal may ever
 * interpolate a test name, a category or a discipline into it. "LAB ·
 * Serology (2)" would be a clinical fact on a bill in tidier clothing —
 * arguably a worse one, since a hospital's serology bench is where the tests
 * people least want discussed are run.
 */
export function labSummaryDescription(itemCount: number, accessions: string[] = []): string {
  /*
   * The specimen numbers, on the line billing staff actually see.
   *
   * The itemisation already carried them, and billing staff never see the
   * itemisation — so the one role whose whole job is reconciling a charge
   * against something could not tell which order a lab line belonged to.
   * Reported exactly that way: *"billing team will know the bill generated for
   * what order"*.
   *
   * Safe here for the same reason it is safe on the itemised line: an
   * accession is an opaque key. It says nothing about what was investigated,
   * which is why it may appear while a discipline still may not — "LAB ·
   * Serology (2)" would be a clinical fact on a bill in tidier clothing.
   *
   * Capped, because an invoice line is one line. Past three the count is the
   * useful part and the rest is on the itemised view the laboratory can open.
   */
  const base = `LAB · Tests (${itemCount} item${itemCount === 1 ? '' : 's'})`;
  if (accessions.length === 0) return base;

  const shown = accessions.slice(0, 3).join(', ');
  /*
   * The overflow is its own variable rather than a ternary inside the return
   * template. `lab-billing.spec.ts` pins every interpolation in this function
   * by reading the source, and a nested template literal defeats that matcher —
   * so the guard would have been reporting a string nobody wrote. Keeping the
   * expression flat is what keeps that assertion honest.
   */
  const more = accessions.length > 3 ? ` +${accessions.length - 3}` : '';
  return `${base} · ${shown}${more}`;
}

/**
 * Pull specimen numbers back out of line descriptions.
 *
 * Reading them off the string rather than a column, because that is where
 * `labLineDescription` put them and adding a column would migrate every
 * historical invoice to gain a value it never had. The pattern is exact —
 * two digits, six digits, one letter — and carries its own check character, so
 * this cannot match something that is not an accession.
 */
export function accessionsIn(descriptions: string[]): string[] {
  const found = new Set<string>();
  for (const d of descriptions) {
    const m = /\b(\d{2}-\d{6}-[A-Z])\b/.exec(d);
    if (m) found.add(m[1]);
  }
  return [...found].sort();
}

export const LAB_ITEM_KIND = InvoiceItemKind.LAB_TEST;

/**
 * Which invoice this charge lands on.
 *
 * Mirrors `chooseInvoice` for the pharmacy, including the rule that a settled
 * invoice is never reopened: appending to a paid invoice is the
 * balance-reappears loop the credit-note work was written to close, so a second
 * invoice is raised instead.
 */
export function chooseLabInvoice(
  mode: LabBillingMode,
  openHospitalInvoiceId: number | null,
): { appendToInvoiceId: number | null; kind: InvoiceKind } {
  if (mode === LabBillingMode.COMBINED && openHospitalInvoiceId !== null) {
    return { appendToInvoiceId: openHospitalInvoiceId, kind: InvoiceKind.HOSPITAL };
  }
  return {
    appendToInvoiceId: null,
    kind: mode === LabBillingMode.COMBINED ? InvoiceKind.HOSPITAL : InvoiceKind.LAB,
  };
}

/**
 * Price a set of ordered tests.
 *
 * One line per test and a quantity of one, always. A lab does not sell two of a
 * full blood count — ordering it twice on one requisition is a mistake, and
 * merging them into "×2" would hide it behind an arithmetic that looks
 * deliberate.
 */
export function priceTests(
  tests: ChargeableTest[],
  basis: PriceBasis = 'EXCLUSIVE',
  /** The specimen number, printed on each line so a bill references the tube. */
  accession?: string | null,
): PricedLabCharge {
  const priced = tests.filter((t) => t.priceUnits !== null && t.priceUnits > 0);

  const taxed = priced.map((t) => ({
    t,
    total: lineTotalMinor(t.priceUnits as number, 1),
  }));

  const withTax = taxed.map(({ t, total }) => ({
    t,
    tax: taxLine(total, t.taxRateBasisPoints ?? 0, basis),
  }));

  const items = withTax.map(({ t, tax }) => ({
    orderItemId: t.orderItemId,
    description: labLineDescription(t, accession),
    quantity: 1,
    unitPrice: fromPriceUnits(t.priceUnits as number),
    amount: fromMinor(tax.netMinor),
    taxAmount: fromMinor(tax.taxMinor),
    taxRateBasisPoints: tax.rateBasisPoints,
    taxRateName: t.taxRateName ?? null,
    /*
     * Apportioned from the line's tax rather than computed per component, so
     * the parts always add up to the tax line above them. An invoice whose
     * components do not sum to its own tax line is one an auditor rejects.
     */
    taxBreakdown:
      (t.taxComponents ?? []).length === 0
        ? null
        : apportionTax(tax.taxMinor, t.taxComponents as { name: string; rateBasisPoints: number }[]).map(
            (c) => ({
              name: c.name,
              rateBasisPoints: c.rateBasisPoints,
              amount: fromMinor(c.amountMinor),
            }),
          ),
  }));

  const totals = taxTotals(withTax.map((w) => w.tax));

  return {
    totalMinor: totals.grossMinor,
    taxMinor: totals.taxMinor,
    netMinor: totals.netMinor,
    items,
    // Blank is not zero. A test with no price is performed and not charged for,
    // and the omission is named rather than forgiven.
    unpriced: tests
      .filter((t) => t.priceUnits === null || t.priceUnits <= 0)
      .map((t) => `${t.testCode} ${t.testName}`),
  };
}
