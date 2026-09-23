import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Billing a consultation must not tell billing what the consultation was.
 *
 * WHY THIS IS A SOURCE TEST
 * -------------------------
 * The rule it defends is about what a *string* contains, and the failure it
 * prevents is silent: an invoice line reading "Consultation — Dr Chen" is
 * perfectly valid data that quietly routes a department, and therefore a
 * clinical fact, to a role `toPatientResponse` withholds it from. No runtime
 * assertion catches that; only reading the line does.
 *
 * `patient-response.spec.ts` asserts on the *absence* of fields for the same
 * reason — a test that only checks the doctor sees allergies would still pass
 * if reception saw them too.
 */

const BACKEND = resolve(__dirname, '../..');
const SERVICE = readFileSync(resolve(__dirname, './billing.service.ts'), 'utf8');
const SCHEMA = readFileSync(resolve(BACKEND, 'prisma/schema.prisma'), 'utf8');
const APPT_CONTROLLER = readFileSync(
  resolve(BACKEND, 'src/appointments/appointments.controller.ts'),
  'utf8',
);
const ACCESS_MATRIX = readFileSync(
  resolve(BACKEND, 'src/common/guards/access-matrix.spec.ts'),
  'utf8',
);

/** The block of `invoiceForAppointment`, which is what actually builds a line. */
/**
 * The method body, with comments stripped.
 *
 * Stripping matters: the assertions below look for words like "medicine" that
 * must not appear in the *code*, and a comment explaining why they must not
 * appear would fail the test it is explaining. This repo has now been caught
 * by that five times — a test matching its own prose — so the extraction does
 * it rather than each assertion working around it.
 */
function invoiceForAppointment(): string {
  const start = SERVICE.indexOf('async invoiceForAppointment(');
  expect(start).toBeGreaterThan(-1);
  return SERVICE.slice(start, SERVICE.indexOf('\n  async ', start + 10))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('the consultation invoice line', () => {
  const body = invoiceForAppointment();

  it('is a tariff code, not a description of the visit', () => {
    expect(body).toContain("description: 'CONS · Consultation'");
  });

  it('never interpolates anything into the description', () => {
    /*
     * A template literal here is the whole risk. Today it would be the doctor's
     * name; the next person's convenience change is the reason for the visit,
     * and by then the shape looks established.
     */
    expect(body).not.toMatch(/description:\s*`/);
  });

  it('does not read a diagnosis, prescription or medicine to build the invoice', () => {
    // CLAUDE.md: "never generated from prescriptions or dispensing". The select
    // above is the boundary — if it does not fetch clinical data, no line can
    // accidentally contain it.
    for (const forbidden of ['diagnosis', 'prescription', 'medicine', 'medicalRecord']) {
      expect(body.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('billing a consultation twice', () => {
  it('is impossible in the database, not merely discouraged', () => {
    /*
     * The service checks for a readable message. The unique constraint is what
     * holds when two receptionists tap "Bill" in the same second — the same
     * argument as the appointment slot indexes.
     */
    expect(SCHEMA).toMatch(/appointmentId Int\?\s+@unique/);
  });

  it('translates the constraint into something reception can act on', () => {
    expect(invoiceForAppointment()).toContain('already been invoiced');
  });
});

describe('what can be billed', () => {
  const body = invoiceForAppointment();

  it('is billable from arrival onwards, not only after the consultation', () => {
    /*
     * Payment comes before the doctor in an outpatient clinic: the patient
     * arrives, pays at the desk, then waits. The first version required
     * COMPLETED, which is the insurance-led model and means chasing someone who
     * has already walked out.
     */
    expect(body).toContain('AppointmentStatus.CHECKED_IN');
    expect(body).toContain('AppointmentStatus.IN_PROGRESS');
    expect(body).toContain('AppointmentStatus.COMPLETED');
  });

  it('refuses a patient who has not arrived, and one who never will', () => {
    // SCHEDULED may still become a no-show; CANCELLED and NO_SHOW are an empty
    // chair. An invoice against any of them is revenue invented from a visit
    // that did not happen.
    expect(body).toContain('AppointmentStatus.SCHEDULED');
    expect(body).not.toMatch(/BILLABLE[\s\S]{0,120}CANCELLED/);
  });

  it('refuses when no fee is set, rather than billing zero', () => {
    /*
     * No fee and a free consultation are different facts. Defaulting to zero
     * would make a forgotten price look like a decision, and the first anyone
     * would know is a month of consultations billed at nothing.
     */
    expect(body).toContain('No consultation fee is set');
  });
});

describe('payment is offered, never required', () => {
  /*
   * Reading the clinical path and asserting a *gate is absent*.
   *
   * Same shape as `patient-response.spec.ts`, which asserts on missing fields:
   * checking that something works proves less than checking that something
   * cannot start existing. A payment gate is the kind of change that looks like
   * an improvement — "surely the doctor shouldn't see them until they've paid"
   * — and the person adding it would not be thinking about the patient who
   * deteriorated in the waiting room, or the one the clinic decided to treat
   * for nothing.
   *
   * Refusing care over an unpaid balance is not a decision software should make
   * on a clinic's behalf. If a clinic ever genuinely wants it, it belongs
   * behind an explicit per-tenant setting with a documented override — not as
   * an `if` somebody added on a Tuesday.
   */
  const CLINICAL_PATH = [
    'src/appointments/appointments.service.ts',
    'src/me/me.service.ts',
    'src/medical-records/medical-records.service.ts',
    'src/prescriptions/prescriptions.service.ts',
  ];

  it.each(CLINICAL_PATH)('%s does not gate on payment', (file) => {
    const src = readFileSync(resolve(BACKEND, file), 'utf8');

    // Reading an invoice at all in these services would be the first step
    // toward it, and none of them has any reason to.
    expect(src).not.toMatch(/invoice\.(findFirst|findUnique|count)/);
    expect(src).not.toMatch(/amountPaid/);
    expect(src).not.toMatch(/\bsettled\b/);
  });

  it('keeps COMPLETED billable, so a charge can follow the consultation', () => {
    // The half of "pay at check-in" that is easy to lose: if payment can happen
    // later, the appointment must still be billable after it is finished.
    expect(invoiceForAppointment()).toContain('AppointmentStatus.COMPLETED');
  });
});

describe('where the checkout route lives', () => {
  it('is on appointments, not billing', () => {
    /*
     * access-matrix asserts every BillingController route is exactly
     * [ADMIN, BILLING_STAFF] and calls it "the cleanest role boundary in the
     * system". Reception raising a charge is a checkout action on an
     * appointment; moving it into billing to save an import would have traded a
     * real guarantee for a file location.
     */
    expect(APPT_CONTROLLER).toContain("@Post(':id/invoice')");
    expect(APPT_CONTROLLER).toContain('UserRole.RECEPTIONIST');
    expect(ACCESS_MATRIX).toContain('is reachable only by billing and admin');
  });

  it('is audited under its own action name', () => {
    // "who charged this patient, and when" must be answerable from the trail.
    expect(APPT_CONTROLLER).toContain("@AuditAction('APPOINTMENT_INVOICE_RAISED')");
  });
});

/**
 * The refund loop, and where it ends.
 *
 * Found in use, not by a test: refunding gave the money back and left the
 * charge standing, so the balance reappeared under "outstanding", the invoice
 * could be paid again, refunded again, and so on. There was no terminal state.
 *
 * A refund and a credit answer different questions — "we gave the money back"
 * and "we should not have charged for it" — and the loop existed because only
 * the first was implemented.
 */
describe('a refund can cancel the charge it reverses', () => {
  const SERVICE = readFileSync(resolve(__dirname, './billing.service.ts'), 'utf8');

  function refundBody(): string {
    const start = SERVICE.indexOf('async refund(');
    expect(start).toBeGreaterThan(-1);
    return SERVICE.slice(start, SERVICE.indexOf('\n  async ', start + 10));
  }

  it('credits the invoice by default, so no balance reappears', () => {
    const body = refundBody();
    // Opt *out*, not opt in. The overwhelmingly common case is that the charge
    // was wrong too, and defaulting the other way recreates the loop.
    expect(body).toContain('dto.cancelCharge === false');
    expect(body).toContain('creditedAmount');
  });

  it('caps the credit at what is still chargeable', () => {
    // Otherwise repeated partial refunds credit more than was ever billed, and
    // the invoice ends up owing the patient money it never charged.
    expect(refundBody()).toMatch(/Math\.min\([\s\S]{0,80}chargeableMinor/);
  });

  it('closes an invoice that has been fully refunded and fully credited', () => {
    /*
     * The exit. Nothing left to charge and nothing held means the invoice is
     * finished — it leaves both the outstanding and the paid views rather than
     * sitting in one of them forever.
     */
    const body = refundBody();
    expect(body).toContain('nextCreditedMinor >= totalMinor && outcome.paidMinor === 0');
    expect(body).toContain('InvoiceStatus.CANCELLED');
    // Voided, not deleted — the charge, the reversal and the reason all survive.
    expect(body).toContain('voidReason');
  });

  it('still allows a refund that leaves the charge standing', () => {
    // A returned deposit against money the patient genuinely still owes. Rare,
    // real, and the reason the credit is a choice rather than implied.
    expect(refundBody()).toContain('dto.cancelCharge === false');
  });

  it('computes what is owed from the credited total, not the original charge', () => {
    /*
     * `total - paid` is what made a refund reopen a balance nobody was
     * chasing. The charge minus what was cancelled minus what is held is the
     * figure that means something.
     */
    expect(SERVICE).toContain('const outstandingMinor = chargeableMinor - paidMinor');
  });

  it('never rewrites what the invoice says it charged', () => {
    /*
     * An invoice that quietly changes its own total is not a record — a
     * printed copy and the database would disagree about the charge, and only
     * one of them is in front of the patient. The reduction lives beside it as
     * `creditedAmount`.
     *
     * Asserted against the *write*, not the whole file: `shape()` reads
     * `totalAmount` and must go on doing so.
     */
    const body = refundBody();
    const update = body.slice(body.indexOf('tx.invoice.update'));
    expect(update.length).toBeGreaterThan(50);
    // `select` above reads totalAmount, and must. The write must not touch it.
    expect(update).not.toMatch(/totalAmount:/);
    expect(update).toContain('creditedAmount:');
  });
});
