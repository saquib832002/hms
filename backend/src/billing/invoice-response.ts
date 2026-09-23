import { InvoiceItemKind, InvoiceKind, UserRole } from '@prisma/client';
import { fromMinor, toMinor, toMoneyString } from './money';
import { pharmacySummaryDescription } from '../pharmacy/sales';
import { accessionsIn, labSummaryDescription } from '../lab/lab-charge';

/**
 * Same invoice, different body per role. Layer 3, exactly as
 * `toPatientResponse` does it for patients.
 *
 * THE RULE THIS RESTATES, AND WHY IT HAD TO BE RESTATED
 * -----------------------------------------------------
 * CLAUDE.md said, and `consultation-billing.spec.ts` enforced:
 *
 *   "Invoice lines are typed by billing staff or picked from service presets —
 *    never generated from prescriptions or dispensing. A line reading
 *    'Amoxicillin 500mg × 21' would route a medication history to billing past
 *    the role-shaped patient response."
 *
 * That rule cannot survive contact with a pharmacy that bills for what it
 * sells. A receipt that does not say what was bought is not a receipt, and in
 * most jurisdictions not a lawful one. So the itemisation has to exist.
 *
 * The rule was not wrong, it was aimed at the wrong noun. It was written to
 * stop a *consultation* invoice leaking a *diagnosis* to a general billing
 * clerk. The pharmacist who sold the amoxicillin already knows about the
 * amoxicillin; the person who must not learn it from a bill is BILLING_STAFF,
 * who has no clinical role and who — in a hospital with an oncology department
 * — could otherwise read a treatment history straight off an invoice list.
 *
 * So the restated rule is: **a drug name may appear on an invoice, and may
 * never appear in a response to BILLING_STAFF.** Enforced here, asserted
 * directly in `invoice-response.spec.ts`.
 *
 * THE DISHONEST VERSION WAS AVAILABLE AGAIN
 * ------------------------------------------
 * Leaving the old rule in CLAUDE.md and simply not generating lines "from
 * dispensing" — generating them from a `Sale` object instead — would have kept
 * the existing test green while the behaviour it described stopped being true.
 * That is the same move `access-matrix.spec.ts`'s "no clinical GET at all" test
 * invited when the consultation ledger was added, and it was refused then for
 * the same reason: a safety net you have stepped around is worse than none,
 * because the next reader believes it.
 */

export interface RawInvoiceItem {
  id: number;
  description: string;
  amount: unknown;
  taxAmount?: unknown;
  taxRateBasisPoints?: number | null;
  taxRateName?: string | null;
  taxBreakdown?: unknown;
  kind?: InvoiceItemKind | null;
  quantity?: number | null;
  unitPrice?: unknown;
  medicineId?: number | null;
}

export interface ShapedInvoiceItem {
  id: number | null;
  description: string;
  /** NET of tax. `taxAmount` completes it; the two sum to what is charged. */
  amount: string;
  taxAmount: string;
  taxRateBasisPoints: number;
  /**
   * The rate's name as captured at billing — "GST 12%".
   *
   * Not a clinical fact, so it crosses to billing staff untouched. It is held
   * on the line rather than resolved from the rate table because an invoice
   * must stay readable after the rate it used is renamed or retired.
   */
  taxRateName: string | null;
  /**
   * CGST 6% / SGST 6%, as applied. Null for a flat rate.
   *
   * Read from what was captured at billing rather than resolved from the rate
   * table: an invoice must reprint identically after the rate it used has been
   * renamed, restructured or retired.
   */
  taxBreakdown: { name: string; rateBasisPoints: number; amount: string }[] | null;
  kind: InvoiceItemKind;
  quantity: number | null;
  unitPrice: string | null;
  medicineId: number | null;
}

/**
 * Who may read a medicine line as a medicine line.
 *
 * PHARMACIST sold it. ADMIN owns the hospital and reconciles every set of
 * books, and already sees the consultation ledger — a medicine name is not a
 * widening for them in the way it would be for billing.
 *
 * Everyone else, including BILLING_STAFF and LAB_TECHNICIAN, gets the rolled-up
 * total. Written as an allowlist rather than a denylist on purpose: a role added
 * to `UserRole` tomorrow is withheld by default, which is the direction a
 * mistake here should fail in — and that has now paid for itself, because
 * LAB_TECHNICIAN arrived and needed no change to this line.
 */
const MAY_SEE_MEDICINE_DETAIL: UserRole[] = [UserRole.PHARMACIST, UserRole.ADMIN];

/**
 * Who may read a test name on an invoice.
 *
 * THE SHARPER VERSION OF THE SAME RULE
 * ------------------------------------
 * A drug name *implies* a condition. A test name frequently **is** the
 * question: "HIV antibody", "Beta-hCG", "Drug screen", "Chlamydia PCR". Each of
 * those on a bill tells a billing clerk something the patient told their doctor
 * in confidence, and in several cases something they have deliberately told
 * nobody else. The consequence of getting it wrong is worse than the medicine
 * case, not milder, so the collapse is not optional and not configurable.
 *
 * LAB_TECHNICIAN, because they ran it. ADMIN, on the same basis as medicines.
 * PHARMACIST is deliberately absent — a pharmacist reading which tests a patient
 * had is exactly the minimum-necessary failure that made LAB_TECHNICIAN a role
 * of its own rather than an extension of theirs, and it would be perverse to
 * close that door on the worklist and leave it open on an invoice.
 */
const MAY_SEE_LAB_DETAIL: UserRole[] = [UserRole.LAB_TECHNICIAN, UserRole.ADMIN];

export function canSeeMedicineDetail(role: UserRole | undefined | null): boolean {
  return role != null && MAY_SEE_MEDICINE_DETAIL.includes(role);
}

export function canSeeLabDetail(role: UserRole | undefined | null): boolean {
  return role != null && MAY_SEE_LAB_DETAIL.includes(role);
}

/**
 * Collapses clinical lines for roles that may not read them.
 *
 * A collapsed line carries a count and a total and nothing else. Not "PHARM ·
 * Antibiotics (2)" and not "LAB · Serology (2)" — a therapeutic class or a
 * discipline is the same leak in tidier clothing, and a hospital's serology
 * bench is where the tests people least want discussed are run. And not the
 * first item's name with "and 3 others", which is the version that looks like a
 * helpful summary and names one anyway.
 *
 * `id: null` on a summary is deliberate. It is not a row anybody can act on, and
 * giving it the id of one of the lines it replaces would let a client fetch that
 * single line by id and get past the collapse.
 *
 * The two collapses are independent, which is the point of doing it this way: a
 * pharmacist sees medicines itemised and tests rolled up, a lab technician sees
 * the reverse, and billing sees neither.
 */
export function shapeInvoiceItems(
  items: RawInvoiceItem[],
  role: UserRole | undefined | null,
): ShapedInvoiceItem[] {
  const normalise = (i: RawInvoiceItem): ShapedInvoiceItem => ({
    id: i.id,
    description: i.description,
    amount: toMoneyString(i.amount),
    kind: i.kind ?? InvoiceItemKind.SERVICE,
    quantity: i.quantity ?? null,
    unitPrice: i.unitPrice == null ? null : String(i.unitPrice),
    medicineId: i.medicineId ?? null,
    taxAmount: toMoneyString(i.taxAmount ?? '0.00'),
    taxRateBasisPoints: i.taxRateBasisPoints ?? 0,
    taxRateName: i.taxRateName ?? null,
    taxBreakdown:
      (i.taxBreakdown as { name: string; rateBasisPoints: number; amount: string }[] | null) ??
      null,
  });

  const kindOf = (i: RawInvoiceItem) => i.kind ?? InvoiceItemKind.SERVICE;

  /**
   * One collapsed line replacing many.
   *
   * The tax is summed rather than dropped: billing staff do not see WHICH
   * items, and they must still see what tax was charged — an invoice they
   * cannot reconcile is one they cannot take money against. The rate name and
   * its breakdown are deliberately not carried up, because with two rates in
   * one basket there is no single name and picking one would be a confident
   * half-truth on a document somebody files.
   */
  const summarise = (
    group: RawInvoiceItem[],
    kind: InvoiceItemKind,
    describe: (n: number, accessions?: string[]) => string,
  ): ShapedInvoiceItem => ({
    id: null,
    /*
     * The specimen numbers travel up onto the collapsed line, so billing staff
     * can map a charge to an order without ever seeing a test name. The
     * pharmacy summary takes no second argument and ignores it — there is no
     * equivalent key for a dispense, and inventing one to make the two
     * symmetrical would put something on a bill that means nothing.
     */
    description: describe(group.length, accessionsIn(group.map((g) => g.description))),
    amount: fromMinor(group.reduce((sum, m) => sum + toMinor(toMoneyString(m.amount)), 0)),
    kind,
    quantity: null,
    unitPrice: null,
    medicineId: null,
    taxAmount: fromMinor(
      group.reduce((sum, m) => sum + toMinor(toMoneyString(m.taxAmount ?? '0.00')), 0),
    ),
    taxRateBasisPoints: 0,
    taxRateName: null,
    taxBreakdown: null,
  });

  const hideMedicines = !canSeeMedicineDetail(role);
  const hideLab = !canSeeLabDetail(role);

  const medicines = hideMedicines
    ? items.filter((i) => kindOf(i) === InvoiceItemKind.MEDICINE)
    : [];
  const labs = hideLab ? items.filter((i) => kindOf(i) === InvoiceItemKind.LAB_TEST) : [];
  const hidden = new Set<RawInvoiceItem>([...medicines, ...labs]);

  const shaped = items.filter((i) => !hidden.has(i)).map(normalise);

  if (medicines.length > 0) {
    shaped.push(summarise(medicines, InvoiceItemKind.MEDICINE, pharmacySummaryDescription));
  }
  if (labs.length > 0) {
    shaped.push(summarise(labs, InvoiceItemKind.LAB_TEST, labSummaryDescription));
  }

  return shaped;
}

/**
 * Which invoice kinds a role may list at all.
 *
 * In SEPARATE mode the pharmacy and the lab are different businesses, so their
 * invoices are not billing's to see, chase or reconcile. This is a *list*
 * boundary rather than a security one — `RolesGuard` and the service-layer
 * scoping are what actually refuse — but it is the thing that stops the aging
 * report treating a shop's takings as the hospital's debtors.
 *
 * The three sets are disjoint by design rather than nested. A pharmacist has no
 * business in the lab's ledger and a technician none in the pharmacy's; only
 * the administrator, who owns all of them, sees all of them.
 */
export function visibleInvoiceKinds(role: UserRole | undefined | null): InvoiceKind[] {
  switch (role) {
    case UserRole.PHARMACIST:
      return [InvoiceKind.PHARMACY];
    case UserRole.LAB_TECHNICIAN:
      return [InvoiceKind.LAB];
    /*
     * BILLING_STAFF gets the laboratory's invoices as well as the hospital's,
     * and the pharmacy's still not at all.
     *
     * WHY THE TWO ARE NOT SYMMETRIC
     * -----------------------------
     * Reported from use as `GET /billing/invoices/247 → 404`: a clinic with a
     * doctor and no bench sends its tests out, the patient pays *there*, and
     * the charge lands on a LAB invoice — which the clinic's own billing staff
     * could not open, list, take payment on or refund. The only people who
     * could were an administrator and a laboratory technician, and a clinic
     * with no bench has no technician. So the person whose entire job is
     * collecting money was the one role refused.
     *
     * The wall was copied wholesale from the pharmacy, where it earns its keep:
     * in SEPARATE mode a pharmacy is a shop, its counter takings are not the
     * hospital's debtors, and an unsettled counter sale is an unreconciled till
     * rather than somebody to chase at 90 days. None of that is true of a
     * laboratory charge raised against a patient the clinic is treating.
     *
     * **Nothing clinical crosses by widening this**, which is the part worth
     * being sure of. `MAY_SEE_LAB_DETAIL` is a separate list and BILLING_STAFF
     * is deliberately not on it, so every LAB_TEST line still collapses to
     * `LAB · 26-000412-K · Tests (2 items)` for them — a count and an accession,
     * never a test name. The two rules were always independent; only the ledger
     * boundary moves here.
     *
     * A standalone laboratory tenant is unaffected in substance: its billing
     * staff, if it has any, are its own, and its invoices are the ones they
     * should be chasing.
     */
    case UserRole.BILLING_STAFF:
      return [InvoiceKind.HOSPITAL, InvoiceKind.LAB];
    case UserRole.ADMIN:
      return [InvoiceKind.HOSPITAL, InvoiceKind.PHARMACY, InvoiceKind.LAB];
    default:
      return [InvoiceKind.HOSPITAL];
  }
}

/**
 * Which invoice kinds are somebody's *debt*, for aging.
 *
 * THE RULE THIS FILE CLAIMED AND DID NOT IMPLEMENT
 * -----------------------------------------------
 * CLAUDE.md has said since the pharmacy shipped that "aging counts hospital
 * invoices only: a counter sale is paid at the counter or it does not happen,
 * and an unsettled one is an unreconciled till, not a debtor to chase at 30, 60
 * and 90 days." The reasoning is right and `aging()` had **no kind filter at
 * all** — so a pharmacy walk-in who never paid has been sitting in the 90-day
 * bucket as a patient debt this whole time. A stated rule with no test is a
 * rule that drifts, and this one never held for a day.
 *
 * It is fixed here rather than by keying aging on the caller's role, because
 * the caller can be an ADMIN — who sees pharmacy invoices legitimately, and
 * would then drag them back into the buckets. What belongs in an aging report
 * is a property of the invoice, not of who is reading it.
 *
 * LAB is included and PHARMACY is not, which is the whole distinction: a
 * laboratory charge is raised against a named patient at the moment a doctor
 * requests a test, and goes unpaid exactly as a consultation does. A counter
 * sale is money that either crossed the counter or did not.
 */
export const AGEABLE_INVOICE_KINDS: InvoiceKind[] = [InvoiceKind.HOSPITAL, InvoiceKind.LAB];
