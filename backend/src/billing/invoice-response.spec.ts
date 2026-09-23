import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InvoiceItemKind, InvoiceKind, UserRole } from '@prisma/client';
import {
  AGEABLE_INVOICE_KINDS,
  canSeeLabDetail,
  canSeeMedicineDetail,
  shapeInvoiceItems,
  visibleInvoiceKinds,
} from './invoice-response';

/**
 * A drug name may appear on an invoice. It may never appear in a response to
 * BILLING_STAFF.
 *
 * WHY THE OLD RULE HAD TO BE RESTATED RATHER THAN QUIETLY OUTGROWN
 * ----------------------------------------------------------------
 * CLAUDE.md said invoice lines must "never be generated from prescriptions or
 * dispensing", and `consultation-billing.spec.ts` enforces that for the
 * consultation line. A pharmacy that bills for what it sells cannot obey it: a
 * receipt that does not name what was bought is not a receipt.
 *
 * There was a dishonest version available — generate the lines from a `Sale`
 * object rather than "from dispensing", leave the sentence in CLAUDE.md, and
 * watch the existing test stay green while the thing it described stopped being
 * true. That is the same move the consultation ledger invited when it put
 * patient names on an admin screen, and it was refused then for the reason it
 * is refused now: a safety net somebody has stepped around is worse than none,
 * because the next reader believes it.
 *
 * So the rule moved, and this file is where it is now asserted.
 *
 * These tests assert on **absence**, like `patient-response.spec.ts`. A test
 * that only checked the pharmacist sees the drug name would pass just as well
 * if billing saw it too.
 */

const ITEMS = [
  { id: 1, description: 'CONS · Consultation', amount: '40.00', kind: InvoiceItemKind.SERVICE },
  {
    id: 2,
    description: 'Amoxicillin 500 mg capsule',
    amount: '7.35',
    kind: InvoiceItemKind.MEDICINE,
    quantity: 21,
    unitPrice: '0.3500',
    medicineId: 12,
  },
  {
    id: 3,
    description: 'Sertraline 50 mg tablet',
    amount: '9.00',
    kind: InvoiceItemKind.MEDICINE,
    quantity: 30,
    unitPrice: '0.3000',
    medicineId: 44,
  },
];

describe('what billing staff see on an invoice carrying medicines', () => {
  const shaped = shapeInvoiceItems(ITEMS, UserRole.BILLING_STAFF);

  it('names no medicine, anywhere in the response', () => {
    /*
     * The assertion that matters, and it is deliberately about the whole
     * serialised body rather than a field. A future change adding
     * `originalDescription` "for reference" would pass a per-field check and
     * fail this one, which is the right way round.
     */
    const body = JSON.stringify(shaped);
    for (const drug of ['Amoxicillin', 'Sertraline', 'amoxicillin', 'sertraline']) {
      expect(body).not.toContain(drug);
    }
  });

  it('carries no medicine id either', () => {
    // An id is a lookup key. `GET /medicines/12` would turn it straight back
    // into a drug name, which makes the collapse decorative.
    expect(shaped.every((i) => i.medicineId === null)).toBe(true);
  });

  it('collapses them into one line with a count and a total', () => {
    const summary = shaped.filter((i) => i.kind === InvoiceItemKind.MEDICINE);
    expect(summary).toHaveLength(1);
    expect(summary[0].description).toBe('PHARM · Medicines (2 items)');
    expect(summary[0].amount).toBe('16.35');
  });

  it('keeps the service lines untouched', () => {
    const service = shaped.find((i) => i.kind === InvoiceItemKind.SERVICE);
    expect(service?.description).toBe('CONS · Consultation');
    expect(service?.amount).toBe('40.00');
  });

  it('gives the summary no id to fetch or edit by', () => {
    // A summary carrying the id of one of the lines it replaced would let a
    // client ask for that line directly and walk straight past the collapse.
    const summary = shaped.find((i) => i.kind === InvoiceItemKind.MEDICINE);
    expect(summary?.id).toBeNull();
  });

  it('still adds up to the invoice total', () => {
    // The collapse must not lose money. A summary that rounds or drops a line
    // makes the invoice disagree with itself, which is the one thing a bill
    // cannot do.
    const total = shaped.reduce((sum, i) => sum + Math.round(Number(i.amount) * 100), 0);
    expect(total).toBe(4000 + 735 + 900);
  });

  it('leaves an invoice with no medicines completely alone', () => {
    const serviceOnly = shapeInvoiceItems([ITEMS[0]], UserRole.BILLING_STAFF);
    expect(serviceOnly).toHaveLength(1);
    expect(serviceOnly[0].description).toBe('CONS · Consultation');
  });
});

describe('what the pharmacist and the owner see', () => {
  it('is the itemisation, because they are the ones who may', () => {
    for (const role of [UserRole.PHARMACIST, UserRole.ADMIN]) {
      const shaped = shapeInvoiceItems(ITEMS, role);
      expect(shaped).toHaveLength(3);
      expect(JSON.stringify(shaped)).toContain('Amoxicillin');
      expect(shaped[1].quantity).toBe(21);
      expect(shaped[1].unitPrice).toBe('0.3500');
    }
  });
});

describe('who is on the allowlist', () => {
  it('is exactly the pharmacist and the admin', () => {
    /*
     * Pinned as a set rather than checked role by role. The failure this
     * catches is a role being *added* — a new `UserRole` member that somebody
     * quietly includes, or an allowlist that grows by one during an unrelated
     * change.
     */
    const allowed = Object.values(UserRole).filter((r) => canSeeMedicineDetail(r));
    expect(allowed.sort()).toEqual([UserRole.ADMIN, UserRole.PHARMACIST].sort());
  });

  it('withholds from a role it has never heard of', () => {
    // Written as an allowlist so an unknown role fails closed. A denylist would
    // admit every future role by default, which is the wrong direction for a
    // mistake here to fall in.
    expect(canSeeMedicineDetail('SOMETHING_NEW' as UserRole)).toBe(false);
    expect(canSeeMedicineDetail(undefined)).toBe(false);
    expect(canSeeMedicineDetail(null)).toBe(false);
  });
});

describe('whose invoices a role may list', () => {
  it('keeps the pharmacy counter apart from the hospital', () => {
    /*
     * A pharmacist has no business in the lab's ledger and a technician none in
     * the pharmacy's. In SEPARATE mode these are different businesses taking
     * money at different counters.
     */
    expect(visibleInvoiceKinds(UserRole.PHARMACIST)).toEqual([InvoiceKind.PHARMACY]);
    expect(visibleInvoiceKinds(UserRole.LAB_TECHNICIAN)).toEqual([InvoiceKind.LAB]);
  });

  it('gives billing the laboratory as well as the hospital', () => {
    /*
     * Reported from use as `GET /billing/invoices/247 → 404`. A clinic with a
     * doctor and no bench sends its tests out, the patient pays there, and the
     * charge lands on a LAB invoice — which the clinic's own billing staff
     * could not open, take payment on or refund. The only roles that could were
     * ADMIN and LAB_TECHNICIAN, and a clinic with no bench has no technician.
     *
     * The wall was copied wholesale from the pharmacy, where it is right: an
     * unsettled counter sale is an unreconciled till rather than a debtor. A
     * laboratory charge raised against a named patient is an ordinary debt.
     */
    expect(visibleInvoiceKinds(UserRole.BILLING_STAFF).sort()).toEqual(
      [InvoiceKind.HOSPITAL, InvoiceKind.LAB].sort(),
    );
  });

  it('still never gives billing the pharmacy', () => {
    // The half of the wall that stays. Drug names on a counter sale are the
    // leak `MAY_SEE_MEDICINE_DETAIL` exists for, and the takings are a shop's.
    expect(visibleInvoiceKinds(UserRole.BILLING_STAFF)).not.toContain(InvoiceKind.PHARMACY);
  });

  it('widening the ledger did not widen what billing may read on a line', () => {
    /*
     * The load-bearing pair. `visibleInvoiceKinds` decides which invoices exist
     * for a role; `MAY_SEE_LAB_DETAIL` decides whether the *lines* name a test.
     * They were always independent and the temptation on opening the first is
     * to assume the second followed. A billing clerk now lists a lab invoice
     * and still sees `LAB · Tests (n items)`, never "HIV antibody".
     */
    expect(visibleInvoiceKinds(UserRole.BILLING_STAFF)).toContain(InvoiceKind.LAB);
    expect(canSeeLabDetail(UserRole.BILLING_STAFF)).toBe(false);
  });

  it('gives the owner all of them, because they reconcile all of them', () => {
    expect(visibleInvoiceKinds(UserRole.ADMIN).sort()).toEqual(
      [InvoiceKind.HOSPITAL, InvoiceKind.PHARMACY, InvoiceKind.LAB].sort(),
    );
  });

  it('never gives an unknown role anything but the hospital', () => {
    expect(visibleInvoiceKinds(undefined)).toEqual([InvoiceKind.HOSPITAL]);
  });
});

describe('what an aging report is allowed to call a debt', () => {
  const AGING = readFileSync(resolve(__dirname, 'billing.service.ts'), 'utf8');

  it('chases hospital and laboratory charges', () => {
    // A laboratory charge is raised against a named patient when a doctor
    // requests a test, and goes unpaid exactly as a consultation does.
    expect(AGEABLE_INVOICE_KINDS).toContain(InvoiceKind.HOSPITAL);
    expect(AGEABLE_INVOICE_KINDS).toContain(InvoiceKind.LAB);
  });

  it('never chases a pharmacy counter sale', () => {
    /*
     * Money that either crossed the counter or did not. An unsettled walk-in is
     * an unreconciled till, not somebody to send a reminder to at 90 days —
     * and there is no address to send it to, since a counter sale has no
     * patient row at all.
     */
    expect(AGEABLE_INVOICE_KINDS).not.toContain(InvoiceKind.PHARMACY);
  });

  it('actually filters, which for a long time it did not', () => {
    /*
     * CLAUDE.md has said since the pharmacy shipped that aging counts hospital
     * invoices only. `aging()` had **no kind filter at all**, so every
     * unsettled walk-in sale sat in the buckets as a patient debt. The rule was
     * right, nothing implemented it, and nothing failed — a stated rule with no
     * test is a rule that drifts, and this one never held for a day.
     */
    const body = AGING.slice(AGING.indexOf('async aging('));
    expect(body.slice(0, body.indexOf('buildAgingReport'))).toMatch(
      /kind: \{ in: AGEABLE_INVOICE_KINDS \}/,
    );
  });

  it('does not key the buckets on who is reading them', () => {
    /*
     * `visibleInvoiceKinds(role)` would have been the obvious reuse and is
     * wrong: an ADMIN sees pharmacy invoices legitimately, which would drag
     * counter sales back into the buckets for exactly the person most likely to
     * be reconciling against a bank statement. What belongs in an aging report
     * is a property of the invoice, not of its reader.
     */
    const body = AGING.slice(AGING.indexOf('async aging('));
    expect(body.slice(0, body.indexOf('buildAgingReport'))).not.toMatch(/visibleInvoiceKinds/);
  });
});

describe('the summary line description', () => {
  const SALES = readFileSync(resolve(__dirname, '../pharmacy/sales.ts'), 'utf8');

  function summaryFn(): string {
    const start = SALES.indexOf('export function pharmacySummaryDescription');
    expect(start).toBeGreaterThan(-1);
    return SALES.slice(start, SALES.indexOf('\n}', start));
  }

  it('is built from a count and nothing else', () => {
    /*
     * The same assertion `consultation-billing.spec.ts` makes about
     * 'CONS · Consultation', and for the same reason. "PHARM · Antibiotics (2)"
     * is a therapeutic class on a bill — the identical leak in tidier clothing,
     * and the kind of change that reads as a helpful improvement.
     */
    const body = summaryFn();
    for (const forbidden of ['medicineName', 'name', 'drugClass', 'strength', 'form']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('is the wording the response actually emits', () => {
    // Guards against this file testing a constant nothing uses.
    const shaped = shapeInvoiceItems(ITEMS, UserRole.BILLING_STAFF);
    expect(shaped.some((i) => i.description.startsWith('PHARM · Medicines'))).toBe(true);
  });
});
