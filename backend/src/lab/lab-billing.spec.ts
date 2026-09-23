import { readFileSync } from 'node:fs';
import path from 'node:path';
import { InvoiceItemKind, InvoiceKind, LabBillingMode, UserRole } from '@prisma/client';
import {
  canSeeLabDetail,
  shapeInvoiceItems,
  visibleInvoiceKinds,
} from '../billing/invoice-response';
import {
  accessionsIn,
  chooseLabInvoice,
  labLineDescription,
  labSummaryDescription,
  priceTests,
} from './lab-charge';

/**
 * A test name on a bill, and who is allowed to read it.
 *
 * WHY THIS IS SHARPER THAN THE MEDICINE RULE
 * ------------------------------------------
 * A drug name implies a condition. A test name frequently IS the question —
 * "HIV antibody", "Beta-hCG", "Drug screen". The failure mode is not a clerk
 * inferring something; it is a clerk reading it.
 */

const line = (over: Partial<Parameters<typeof shapeInvoiceItems>[0][number]> = {}) => ({
  id: 1,
  description: 'LAB · HIV HIV 1+2 antibody',
  amount: '40.00',
  taxAmount: '0.00',
  kind: InvoiceItemKind.LAB_TEST,
  ...over,
});

describe('what a billing clerk sees', () => {
  const items = [
    { id: 1, description: 'CONS · Consultation', amount: '50.00', kind: InvoiceItemKind.SERVICE },
    line({ id: 2, description: 'LAB · HIV HIV 1+2 antibody', amount: '40.00' }),
    line({ id: 3, description: 'LAB · BHCG Beta-hCG', amount: '25.00', taxAmount: '5.00' }),
  ];

  const shaped = shapeInvoiceItems(items, UserRole.BILLING_STAFF);

  it('names no test anywhere in the serialised body', () => {
    /*
     * Asserted against the whole JSON rather than field by field. Checking
     * `description` alone would pass while a later `originalDescription`
     * "for reference" carried the leak in a new field — the same reason the
     * medicine version of this test is written this way.
     */
    const body = JSON.stringify(shaped);
    for (const secret of ['HIV', 'Beta-hCG', 'BHCG', 'antibody']) {
      expect(body).not.toContain(secret);
    }
  });

  it('replaces them with a count and a total', () => {
    const summary = shaped.find((i) => i.kind === InvoiceItemKind.LAB_TEST);
    expect(summary?.description).toBe('LAB · Tests (2 items)');
    expect(summary?.amount).toBe('65.00');
  });

  it('still shows the tax, because they have to reconcile it', () => {
    // An invoice a clerk cannot reconcile is one they cannot take money
    // against. They do not learn WHICH tests; they do learn what was charged.
    const summary = shaped.find((i) => i.kind === InvoiceItemKind.LAB_TEST);
    expect(summary?.taxAmount).toBe('5.00');
  });

  it('carries no id on the summary', () => {
    // Giving it one of the ids it replaces would let a client fetch that single
    // line and walk straight past the collapse.
    expect(shaped.find((i) => i.kind === InvoiceItemKind.LAB_TEST)?.id).toBeNull();
  });

  it('leaves the consultation line alone', () => {
    expect(shaped.find((i) => i.kind === InvoiceItemKind.SERVICE)?.description).toBe(
      'CONS · Consultation',
    );
  });
});

describe('who may read the detail', () => {
  it('is the lab and the administrator', () => {
    expect(canSeeLabDetail(UserRole.LAB_TECHNICIAN)).toBe(true);
    expect(canSeeLabDetail(UserRole.ADMIN)).toBe(true);
  });

  it('is not the pharmacist', () => {
    /*
     * Deliberate, and worth stating. A pharmacist reading which tests a patient
     * had is the minimum-necessary failure that made LAB_TECHNICIAN a role of
     * its own; closing that door on the worklist and leaving it open on an
     * invoice would be perverse.
     */
    expect(canSeeLabDetail(UserRole.PHARMACIST)).toBe(false);

    const shaped = shapeInvoiceItems([line()], UserRole.PHARMACIST);
    expect(JSON.stringify(shaped)).not.toContain('HIV');
  });

  it('is not billing, reception, a nurse or a doctor by this route', () => {
    for (const role of [
      UserRole.BILLING_STAFF,
      UserRole.RECEPTIONIST,
      UserRole.NURSE,
      UserRole.DOCTOR,
    ]) {
      expect(canSeeLabDetail(role)).toBe(false);
    }
  });

  it('withholds from an unauthenticated or unknown role', () => {
    expect(canSeeLabDetail(null)).toBe(false);
    expect(canSeeLabDetail(undefined)).toBe(false);
  });
});

describe('the two collapses are independent', () => {
  const mixed = [
    { id: 1, description: 'PHARM · Amoxicillin 500mg × 21', amount: '9.00', kind: InvoiceItemKind.MEDICINE },
    line({ id: 2 }),
  ];

  it('shows a pharmacist their medicines and hides the tests', () => {
    const body = JSON.stringify(shapeInvoiceItems(mixed, UserRole.PHARMACIST));
    expect(body).toContain('Amoxicillin');
    expect(body).not.toContain('HIV');
  });

  it('shows a technician their tests and hides the medicines', () => {
    const body = JSON.stringify(shapeInvoiceItems(mixed, UserRole.LAB_TECHNICIAN));
    expect(body).toContain('HIV');
    expect(body).not.toContain('Amoxicillin');
  });

  it('shows an administrator both', () => {
    const body = JSON.stringify(shapeInvoiceItems(mixed, UserRole.ADMIN));
    expect(body).toContain('HIV');
    expect(body).toContain('Amoxicillin');
  });

  it('shows billing neither', () => {
    const body = JSON.stringify(shapeInvoiceItems(mixed, UserRole.BILLING_STAFF));
    expect(body).not.toContain('HIV');
    expect(body).not.toContain('Amoxicillin');
  });
});

describe('the summary description', () => {
  it('is built from a count and nothing else', () => {
    expect(labSummaryDescription(1)).toBe('LAB · Tests (1 item)');
    expect(labSummaryDescription(4)).toBe('LAB · Tests (4 items)');
  });

  it('interpolates only a count and specimen numbers into itself', () => {
    /*
     * "LAB · Serology (2)" is a discipline on a bill — the identical leak in
     * tidier clothing, and a hospital's serology bench is where the tests
     * people least want discussed are run. Asserted against the source, the
     * same way `consultation-billing.spec.ts` pins `CONS · Consultation`.
     *
     * WHY THIS LIST GREW, AND WHAT STILL HOLDS IT SHUT
     * ------------------------------------------------
     * It used to allow the count and nothing else, and it failed the moment
     * accessions were added — correctly, which is the point of pinning the
     * source rather than the output. Widening it is a decision, so here is the
     * reasoning: an accession is an **opaque key**. It names no analyte, no
     * discipline and no patient, so it carries none of what this rule exists
     * to keep off a bill, and it is the one thing that lets billing staff
     * reconcile a charge at all.
     *
     * The values are safe because of where they come from, not because of what
     * they look like here: `accessionsIn` extracts them with an exact pattern —
     * two digits, six digits, a check character — from descriptions it is
     * handed. A test name cannot survive that filter, and the test above
     * asserts it does not.
     *
     * Anything beyond this list is a new decision and should fail here again.
     */
    const source = readFileSync(path.resolve(__dirname, 'lab-charge.ts'), 'utf8');
    const fn = /export function labSummaryDescription[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/LAB · Tests/);
    expect(fn.match(/\$\{[^}]*\}/g) ?? []).toEqual([
      '${itemCount}',
      "${itemCount === 1 ? '' : 's'}",
      '${accessions.length - 3}',
      '${base}',
      '${shown}',
      '${more}',
    ]);
  });

  it('builds the shown numbers from the accessions and nothing else', () => {
    /*
     * The half the assertion above cannot see. `shown` could be built from
     * anything in scope; this pins it to the argument that the exact-pattern
     * extractor produced.
     */
    const source = readFileSync(path.resolve(__dirname, 'lab-charge.ts'), 'utf8');
    expect(source).toMatch(/const shown = accessions\.slice\(0, 3\)\.join\(', '\);/);
  });
});

describe('which ledgers a role may list', () => {
  it('keeps a bench and a counter to their own', () => {
    expect(visibleInvoiceKinds(UserRole.LAB_TECHNICIAN)).toEqual([InvoiceKind.LAB]);
    expect(visibleInvoiceKinds(UserRole.PHARMACIST)).toEqual([InvoiceKind.PHARMACY]);
  });

  it('gives billing the laboratory, because a test charge is an ordinary debt', () => {
    /*
     * These were three disjoint sets, and billing's exclusion from the lab was
     * copied from the pharmacy without the argument travelling with it.
     * Reported as `GET /billing/invoices/247 → 404`: a clinic with a doctor and
     * no bench raised a LAB invoice its own billing staff could not open, take
     * payment on or refund — and a clinic with no bench has no technician
     * either, so only an administrator could.
     *
     * The pharmacy half stands. An unsettled counter sale is an unreconciled
     * till rather than a debtor, and it often has no patient to chase.
     */
    expect(visibleInvoiceKinds(UserRole.BILLING_STAFF).sort()).toEqual(
      [InvoiceKind.HOSPITAL, InvoiceKind.LAB].sort(),
    );
    expect(visibleInvoiceKinds(UserRole.BILLING_STAFF)).not.toContain(InvoiceKind.PHARMACY);
  });

  it('gives the administrator all of them', () => {
    expect(visibleInvoiceKinds(UserRole.ADMIN)).toEqual([
      InvoiceKind.HOSPITAL,
      InvoiceKind.PHARMACY,
      InvoiceKind.LAB,
    ]);
  });
});

describe('where the charge lands', () => {
  it('raises its own LAB invoice when the lab bills separately', () => {
    expect(chooseLabInvoice(LabBillingMode.SEPARATE, null)).toEqual({
      appendToInvoiceId: null,
      kind: InvoiceKind.LAB,
    });
  });

  it('ignores an open hospital invoice in SEPARATE mode', () => {
    // Two businesses. Appending would put the lab's trade into the clinic's
    // ledger, which is the thing SEPARATE exists to prevent.
    expect(chooseLabInvoice(LabBillingMode.SEPARATE, 42).appendToInvoiceId).toBeNull();
  });

  it('appends to an open hospital invoice in COMBINED mode', () => {
    expect(chooseLabInvoice(LabBillingMode.COMBINED, 42)).toEqual({
      appendToInvoiceId: 42,
      kind: InvoiceKind.HOSPITAL,
    });
  });

  it('raises a second hospital invoice rather than reopening a settled one', () => {
    /*
     * The caller passes null when there is no OPEN invoice. Appending to a paid
     * one is the balance-reappears loop the credit-note work was written to
     * close.
     */
    expect(chooseLabInvoice(LabBillingMode.COMBINED, null)).toEqual({
      appendToInvoiceId: null,
      kind: InvoiceKind.HOSPITAL,
    });
  });
});

describe('pricing an order', () => {
  const test = (over: Partial<Parameters<typeof priceTests>[0][number]> = {}) => ({
    orderItemId: 1,
    testCode: 'FBC',
    testName: 'Full blood count',
    priceUnits: 120000, // 12.0000
    ...over,
  });

  it('charges one of each, never a quantity', () => {
    // A lab does not sell two full blood counts on one requisition. Merging
    // them into "×2" would hide a duplicate behind arithmetic that looks
    // deliberate.
    const priced = priceTests([test(), test({ orderItemId: 2, testCode: 'UE', testName: 'U+E' })]);
    expect(priced.items.every((i) => i.quantity === 1)).toBe(true);
    expect(priced.totalMinor).toBe(2400);
  });

  it('names an unpriced test rather than charging zero for it', () => {
    /*
     * Blank is not zero. The test is still performed; it is simply not charged
     * for, and the omission is reported back rather than discovered a month
     * later — the failure `Medicine.sellingPrice` was rewritten to prevent.
     */
    const priced = priceTests([test({ priceUnits: null })]);
    expect(priced.totalMinor).toBe(0);
    expect(priced.unpriced).toEqual(['FBC Full blood count']);
  });

  it('keeps net plus tax exactly equal to the total', () => {
    const priced = priceTests([test({ taxRateBasisPoints: 1200 })]);
    expect(priced.netMinor + priced.taxMinor).toBe(priced.totalMinor);
  });

  it('puts the code before the name on the line', () => {
    // The code is what a hospital reconciles against its own tariff.
    expect(labLineDescription({ testCode: 'FBC', testName: 'Full blood count' })).toBe(
      'LAB · FBC Full blood count',
    );
  });

  it('carries the specimen number when there is one', () => {
    /*
     * How a real laboratory invoice references work: the line names the
     * examination and the accession, so a query about a charge and a query
     * about a result are the same query.
     *
     * Safe on a bill in a way a test name is not — an accession is an opaque
     * key that says nothing about what was investigated, which is why it can
     * appear here while `labSummaryDescription` still refuses to name a
     * discipline.
     */
    expect(
      labLineDescription({ testCode: 'FBC', testName: 'Full blood count' }, '26-000412-K'),
    ).toBe('LAB · 26-000412-K · FBC Full blood count');
  });

  it('puts the specimen numbers on the line billing staff actually see', () => {
    /*
     * THE GAP THIS CLOSES
     * -------------------
     * The accession reached the *itemised* line, and billing staff never see
     * the itemisation — `shapeInvoiceItems` collapses every LAB_TEST row for
     * them. So the one role whose job is reconciling a charge against
     * something could not tell which order a lab line belonged to. Reported as
     * *"billing team will know the bill generated for what order"*.
     *
     * Safe for the same reason it is safe on the itemised line: an accession is
     * an opaque key that says nothing about what was investigated. That is
     * precisely why it may appear on this line while a discipline still may
     * not — "LAB · Serology (2)" would be a clinical fact in tidier clothing.
     */
    expect(labSummaryDescription(2, ['26-000412-K', '26-000413-M'])).toBe(
      'LAB · Tests (2 items) · 26-000412-K, 26-000413-M',
    );
  });

  it('caps the list, because an invoice line is one line', () => {
    expect(labSummaryDescription(6, ['26-000001-A', '26-000002-B', '26-000003-C', '26-000004-D'])).toBe(
      'LAB · Tests (6 items) · 26-000001-A, 26-000002-B, 26-000003-C +1',
    );
  });

  it('reads a specimen number back out of a line, and nothing else', () => {
    /*
     * Read off the description rather than a column, because that is where
     * `labLineDescription` put it and adding a column would migrate every
     * historical invoice to gain a value it never had. The pattern is exact and
     * carries its own check character, so it cannot match something that is not
     * an accession — and a test name must never come back out of here.
     */
    expect(
      accessionsIn([
        'LAB · 26-000412-K · FBC Full blood count',
        'LAB · 26-000412-K · LFT Liver function',
        'CONS · Consultation',
      ]),
    ).toEqual(['26-000412-K']);

    expect(accessionsIn(['LAB · HIV HIV 1+2 antibody'])).toEqual([]);
  });

  it('lifts the order numbers onto the invoice, not only its lines', () => {
    /*
     * THE GAP THIS CLOSES
     * -------------------
     * The accession travelled in every lab line's description, and the lines
     * are one click *inside* an invoice. So a till showing forty rows gave no
     * way to tell which order any of them was for without opening each one —
     * reported as *"the lab invoice does not have any reference on the
     * doctor's test order number… difficult to track"*.
     *
     * Derived from the descriptions rather than stored, by the same exact
     * pattern they were written with. A column would be a migration leaving
     * every historical invoice holding a value it never had, and would then
     * need keeping in step with the lines it duplicates.
     */
    const source = readFileSync(
      path.resolve(__dirname, '..', 'billing', 'billing.service.ts'),
      'utf8',
    );
    expect(source).toMatch(/labAccessions: accessionsIn\(/);
  });

  it('prints them on the invoice, and prints nothing when there are none', () => {
    /*
     * `detailGrid` drops null pairs, so a consultation invoice gains no empty
     * "Lab order" field — an always-present blank on a document a patient
     * keeps reads as something the system failed to fill in.
     */
    const source = readFileSync(
      path.resolve(__dirname, '..', 'documents', 'documents.service.ts'),
      'utf8',
    );
    expect(source).toMatch(/accessionsIn\(lines\.map\(\(i\) => i\.description\)\)\.join\(', '\) \|\| null/);
  });

  it('still names no discipline on the collapsed line', () => {
    /*
     * The rule the accession must not be allowed to erode. A count and a set of
     * opaque keys, and nothing that says what was investigated.
     */
    const line = labSummaryDescription(3, ['26-000412-K']);
    for (const word of ['Serology', 'Haematology', 'HIV', 'Beta-hCG', 'Drug']) {
      expect(line).not.toContain(word);
    }
  });

  it('omits it rather than printing an empty separator', () => {
    // Orders raised before accessions existed have none, and a dangling "·"
    // reads as a rendering fault on a document a patient keeps.
    expect(labLineDescription({ testCode: 'FBC', testName: 'Full blood count' }, null)).toBe(
      'LAB · FBC Full blood count',
    );
  });
});

describe('payment gates nothing', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const service = strip(readFileSync(path.resolve(__dirname, 'lab.service.ts'), 'utf8'));

  it('never checks an invoice before collecting, resulting or verifying', () => {
    /*
     * The same safety position `consultation-billing.spec.ts` holds one level
     * up, asserted as an absence because adding a gate looks like an
     * improvement to anyone who has not thought it through. Refusing to run a
     * blood test because a card was declined is not a decision software should
     * make on a clinic's behalf, and the person harmed is not the person who
     * owes the money.
     */
    for (const method of ['async collect(', 'async recordResult(', 'async verify(']) {
      const start = service.indexOf(method);
      expect(start).toBeGreaterThan(-1);
      const body = service.slice(start, start + 2500);
      expect(body).not.toMatch(/amountPaid|InvoiceStatus\.PAID|isPaid|unpaid/);
    }
  });

  it('voids a charge only where nothing was collected and nothing was paid', () => {
    const start = service.indexOf('async cancelOrder(');
    const body = service.slice(start, service.indexOf('async worklist('));
    // Both conditions, not one. Once a sample exists the work was real; once
    // money has been taken, voiding makes it vanish from the day's takings.
    expect(body).toMatch(/collectedAt === null/);
    expect(body).toMatch(/amountPaid/);
  });
});
