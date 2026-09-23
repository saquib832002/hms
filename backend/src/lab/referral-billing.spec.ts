import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ReferralBilling } from '@prisma/client';
import { REFERRAL_BILLING_LABEL, billingPhrase, hospitalCharges } from './referral-billing';

/**
 * Exactly one invoice exists between two hospitals for one piece of referred
 * work — and for a long time the number was zero.
 *
 * THE HOLE THIS CLOSES
 * --------------------
 * `LabService.create` charged only `IN_HOUSE` orders, and `LabOrder.invoiceId`
 * documented it as deliberate: *"Null for a partner or external order, which
 * this hospital does not bill for."* True of the invoice and false of the
 * money. The **receiving** laboratory raises its charge against the sending
 * hospital on accession, so a clinic that referred a test billed nobody and
 * owed somebody. Every partner referral was a straight loss.
 *
 * It stayed invisible because the two halves live in two tenants. The clinic's
 * books showed no line and nothing missing; the lab's showed an ordinary
 * receivable. No screen in either hospital could have shown the pair.
 *
 * WHAT IS ASSERTED
 * ----------------
 * The property, in both directions: for any one referral, exactly one of the
 * two organisations raises a charge, and it is the one the referral says.
 * Everything else here exists to stop that property being quietly weakened —
 * particularly by merging "we chose not to charge" with "nobody priced it",
 * which would make it unobservable again.
 */

const read = (f: string) => readFileSync(path.join(__dirname, f), 'utf8');
const LAB = read('lab.service.ts');
const REFERRAL = read('lab-referral.service.ts');

describe('exactly one organisation charges', () => {
  it('bills the patient here when we are the ones paying the lab', () => {
    expect(hospitalCharges('PARTNER', ReferralBilling.ORIGIN_PAYS)).toBe(true);
  });

  it('bills nothing here when the patient pays the lab', () => {
    expect(hospitalCharges('PARTNER', ReferralBilling.PATIENT_PAYS)).toBe(false);
  });

  it('bills the patient for our own work regardless of any arrangement', () => {
    expect(hospitalCharges('IN_HOUSE', null)).toBe(true);
    expect(hospitalCharges('IN_HOUSE', ReferralBilling.PATIENT_PAYS)).toBe(true);
  });

  it('bills nothing for a named laboratory outside the platform', () => {
    /*
     * EXTERNAL has no partnership row and no accession here — the patient
     * takes a form and pays whoever runs it. That is PATIENT_PAYS in
     * everything but name, and it gets the same treatment rather than being
     * left as the one destination nobody thought about.
     */
    expect(hospitalCharges('EXTERNAL', null)).toBe(false);
    expect(hospitalCharges('EXTERNAL', ReferralBilling.ORIGIN_PAYS)).toBe(false);
  });

  it('never bills at both ends and never at neither', () => {
    /*
     * The property itself, stated as one assertion rather than inferred from
     * the four above. `chargeReferredOrder` always charges *somebody*, so the
     * sending side charging is exactly the complement of the patient paying
     * the lab.
     */
    for (const mode of [ReferralBilling.ORIGIN_PAYS, ReferralBilling.PATIENT_PAYS]) {
      const senderCharges = hospitalCharges('PARTNER', mode);
      const labChargesThePatient = mode === ReferralBilling.PATIENT_PAYS;
      expect(senderCharges).toBe(!labChargesThePatient);
    }
  });
});

describe('the sending hospital', () => {
  it('decides from the arrangement, not from the destination', () => {
    /*
     * The exact regression. `destination === IN_HOUSE ? charge : nothing` is
     * the expression that lost the money, and it reads as obviously correct.
     */
    expect(LAB).toMatch(/const charges = hospitalCharges\(destination, partner\?\.billing \?\? null\)/);
    expect(LAB).toMatch(/const charge = charges$/m);
    expect(LAB).not.toMatch(/destination === LabOrderDestination\.IN_HOUSE\s*\n?\s*\?\s*await this\.chargeOrder/);
  });

  it('records that somebody else is charging, rather than leaving a blank', () => {
    /*
     * `payableExternally` is what keeps the decision observable.
     *
     * Without it a deliberately uncharged test is indistinguishable from one
     * nobody priced, so every "went out uncharged" figure in the system —
     * the lab dashboard, the admin overview, the accession notice — reports
     * these forever and people stop reading the figure that catches the real
     * ones. Third time on this project: blank is not zero for
     * `Medicine.sellingPrice` and `Doctor.consultationFee`, and here *not ours
     * to charge* is not *nobody charged*.
     */
    expect(LAB).toMatch(/payableExternally: !charges/);
    expect(LAB).toMatch(/payableExternally: i\.payableExternally/);
  });
});

describe('the receiving laboratory', () => {
  it('reads the payer from the referral and never from the partnership', () => {
    /*
     * `lab_partners` lives in the *sender's* scope and is unreachable here, so
     * the tempting shortcut does not even work — but a future reader with a
     * cross-tenant read to hand would find it one line shorter. The referral
     * is a snapshot: a term renegotiated next quarter must not restate who
     * owed what for work already accepted, exactly as `DispenseLine.unitPrice`
     * and `PrescriptionItem.medicineName` are captured rather than looked up.
     */
    expect(REFERRAL).toMatch(/referral\.billing,/);
    expect(REFERRAL).not.toMatch(/partner\.billing[\s\S]{0,200}chargeReferredOrder/);
  });

  it('charges the institution with no patient, and the patient with no payer note', () => {
    /*
     * A patientless invoice is attributable only by its note, and a patient's
     * invoice carrying "Referred by …" would read as somebody else's debt on
     * their own bill. The two branches differ in exactly these two ways.
     */
    expect(LAB).toMatch(
      /billing === ReferralBilling\.PATIENT_PAYS\s*\n?\s*\?\s*this\.chargeOrder\(tx, orderId, patientId, items, tax\)\s*\n?\s*:\s*this\.chargeOrder\(tx, orderId, null, items, tax, `Referred by \$\{payer\}`\)/,
    );
  });

  it('captures the arrangement when the work is sent', () => {
    expect(REFERRAL).toMatch(/billing: partner\.billing,/);
  });
});

describe('the handshake', () => {
  it('re-checks the receiving lab at ordering, not only when the partnership was made', () => {
    /*
     * Terms change at the other end without anybody here being told. Trusting
     * the row saved months ago sends the specimen anyway and discovers the
     * disagreement when an unexpected invoice arrives — or, worse, when
     * neither party bills at all, which is the hole above returning by a
     * different route.
     */
    expect(REFERRAL).toMatch(/requirePartner[\s\S]{0,1600}await this\.requireAccepted\(/);
  });

  it('checks it on create and on change too', () => {
    // Three call sites, because the answer can differ at each.
    expect(REFERRAL.match(/requireAccepted\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(REFERRAL).toMatch(/acceptedReferralBilling\.includes\(billing\)/);
  });

  it('names the arrangement in the refusal rather than saying only "not allowed"', () => {
    /*
     * The person who meets this refusal is usually a doctor mid-consultation
     * who cannot fix it. A refusal with no route out is the failure this
     * project has had to reopen five times — seed-only wards, seed-only
     * medicines, doctor profiles, unschedulable chart items,
     * `acceptsExternalLabOrders`.
     */
    expect(billingPhrase(ReferralBilling.ORIGIN_PAYS)).toBe('billed to the referring hospital');
    expect(billingPhrase(ReferralBilling.PATIENT_PAYS)).toBe(
      'paid by the patient at their counter',
    );
    expect(REFERRAL).toMatch(/\$\{label\} does not accept work \$\{billingPhrase\(billing\)\}/);
  });

  it('tells the sending client which modes a lab will take', () => {
    /*
     * So a picker offers only what will be honoured, and names the reason for
     * the rest. An option quietly omitted is indistinguishable from a feature
     * that does not exist — how the partner-pharmacy handshake read as broken,
     * where switching on the receiving half showed the sender nothing at all.
     */
    expect(REFERRAL).toMatch(/accepts: lab\?\.acceptedReferralBilling \?\? \[\]/);
    expect(REFERRAL).toMatch(/lapsed:/);
  });
});

describe('payment still gates nothing', () => {
  /*
   * PATIENT_PAYS makes a gate more tempting than anywhere else in this system:
   * the payer is standing right there, and refusing to draw blood until they
   * pay looks like ordinary shop behaviour.
   *
   * It is the same gate `lab-billing.spec.ts` and `consultation-billing.spec.ts`
   * assert the absence of. A patient who has given blood has given blood; the
   * invoice sits outstanding on the till like any other, and the report is
   * released on verification regardless of it.
   */
  const paths = ['lab.service.ts', 'lab-referral.service.ts'];

  it.each(paths)('%s never reads an invoice status to decide what to do', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/InvoiceStatus\.(PAID|PARTIALLY_PAID)[\s\S]{0,80}throw/);
    expect(source).not.toMatch(/amountPaid[\s\S]{0,120}throw new (Forbidden|Conflict)/);
  });

  it('collects on the way past, never as a condition', () => {
    // `chargeReferredOrder` returns an invoice id; nothing downstream requires
    // it to be settled before collecting, resulting or verifying.
    expect(REFERRAL).not.toMatch(/invoice[\s\S]{0,60}before (collecting|resulting|reporting)/i);
  });
});

describe('the referring hospital can see what it owes', () => {
  /*
   * THE SECOND HALF OF THE SAME HOLE
   * --------------------------------
   * Closing the first one — a referral that billed nobody — left the mirror
   * image standing: under ORIGIN_PAYS the laboratory raises a real invoice
   * against the sending hospital, **in the laboratory's own tenant**. So the
   * debt was invisible from the side that owed it. Their books showed the
   * patient's charge and nothing owing, and "what do we owe this lab" could
   * not be answered anywhere in the product. It arrived as a statement.
   *
   * Both faults are the same shape: a number that exists in one tenant and
   * matters in two.
   */

  it('writes the notice into the sending hospital, not into ours', () => {
    // `forTenant` into the *source* tenant, exactly as the result write-back
    // does. No policy exception anywhere — the row is theirs and is protected
    // by their own policy like any other row of theirs.
    expect(REFERRAL).toMatch(/forTenant\(referral\.sourceTenantId/);
    expect(REFERRAL).toMatch(/partnerLabCharge\.create/);
  });

  it('writes it after the accession transaction, never inside it', () => {
    /*
     * The write enters another tenant's scope, and `TenantInterceptor` already
     * holds one pool connection for this request. Nesting a second `forTenant`
     * inside the accession transaction is the self-deadlock this project has
     * already shipped once — which is why `transmit` is outside too.
     */
    expect(REFERRAL).toMatch(/\}\);\s*\n[\s\S]{0,1400}await this\.noticeCharge\(referral, accepted\);/);
    expect(REFERRAL).not.toMatch(/tx\.partnerLabCharge/);
  });

  it('writes nothing when the hospital owes nothing', () => {
    /*
     * PATIENT_PAYS means the patient settles at the counter. A zero row, or one
     * marked "not yours", would put another company's transaction into their
     * payables for the sake of symmetry.
     */
    expect(REFERRAL).toMatch(/if \(referral\.billing !== ReferralBilling\.ORIGIN_PAYS\) return;/);
  });

  it('swallows a duplicate and nothing else', () => {
    /*
     * The write is outside the transaction, so a retry is a real possibility
     * and the unique index is what makes it safe. Swallowing anything wider
     * would turn a failure into a debt the other hospital never learns about —
     * which is the fault this whole section exists to fix, reappearing quietly.
     */
    expect(REFERRAL).toMatch(/code === 'P2002'\) return;\s*\n\s*throw err;/);
  });

  it('carries the amount that was charged, not one recomputed later', () => {
    // Same rule as `DispenseLine.unitPrice`: captured, never derived twice.
    expect(REFERRAL).toMatch(/amount: accepted\.chargedTotal as string/);
    expect(LAB).toMatch(/total: fromMinor\(priced\.totalMinor\)/);
  });

  it('names no test on the payable', () => {
    /*
     * A test name is a sharper leak than a drug name — it frequently *is* the
     * question. This row goes to whoever reconciles bills, so it carries a
     * count and nothing else, the same rule `labSummaryDescription` follows on
     * an invoice line.
     */
    expect(REFERRAL).toMatch(/testCount: accepted\.chargedTests/);
    expect(REFERRAL).not.toMatch(/partnerLabCharge\.create[\s\S]{0,600}testName/);
  });

  it('settling is a note, not a payment', () => {
    /*
     * No money moves between two companies inside this system. Writing a
     * `Payment` row here would put a number into this hospital's takings that
     * never passed through a till — and takings are counted from `Payment`.
     */
    expect(REFERRAL).toMatch(/async settlePartnerCharge/);
    expect(REFERRAL).not.toMatch(/settlePartnerCharge[\s\S]{0,700}payment\.create/);
    // Reversible, because the commonest correction is marking the wrong row.
    expect(REFERRAL).toMatch(/settledAt: null, settledById: null, settledNote: null/);
  });
});

describe('the two client copies do not drift', () => {
  /*
   * `web/lib/referral-billing.ts` and `mobile/lib/referral-billing.ts` are
   * byte-identical, for the reason `course-quantity.ts`, `routing-line.ts` and
   * `types.ts` are: Metro resolves no shared package here without config
   * nobody has run on a device.
   *
   * The thing that must not happen is the two clients describing the same
   * arrangement differently — an administrator who reads "we pay the lab" on
   * the desktop and something else on the phone has no way to tell whether
   * they are looking at one setting or two, and the consequence of guessing is
   * an invoice nobody expected or a test nobody billed for.
   *
   * The backend keeps its own copy rather than being a third party to this
   * one: it needs the Prisma enum for its types, and the clients must not
   * import from `@prisma/client`.
   */
  const root = path.resolve(__dirname, '../../..');
  const canonical = readFileSync(path.join(root, 'web/lib/referral-billing.ts'), 'utf8');

  it('mobile matches web', () => {
    expect(readFileSync(path.join(root, 'mobile/lib/referral-billing.ts'), 'utf8')).toBe(canonical);
  });

  it('imports only its own types, so the copies stay portable', () => {
    // Anything else — a backend path, a UI library, an alias only one bundler
    // resolves — makes the file undistributable and this test unsatisfiable.
    const imports = canonical.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual(["import type { ReferralBilling } from './types';"]);
  });

  it('says the same thing as the backend', () => {
    /*
     * Not byte-identical — it cannot be, the backend keys its records off the
     * Prisma enum — so the user-visible strings are compared instead. A screen
     * and a server refusal describing the same arrangement in different words
     * is the thing an administrator has to reconcile by guessing.
     */
    for (const mode of ['ORIGIN_PAYS', 'PATIENT_PAYS'] as const) {
      expect(canonical).toContain(REFERRAL_BILLING_LABEL[mode]);
    }
  });
});

describe('wording is shared, not retyped', () => {
  it('has a label for every mode', () => {
    /*
     * A `Record<ReferralBilling, string>` rather than a lookup with a
     * fallback, so adding a member to the enum is a compile error until
     * somebody names it — the rule `ROLE_LABEL` settled on after a role
     * existed everywhere except where it could be granted.
     */
    expect(Object.keys(REFERRAL_BILLING_LABEL).sort()).toEqual(['ORIGIN_PAYS', 'PATIENT_PAYS']);
  });
});
