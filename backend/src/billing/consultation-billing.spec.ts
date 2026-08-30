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
function invoiceForAppointment(): string {
  const start = SERVICE.indexOf('async invoiceForAppointment(');
  expect(start).toBeGreaterThan(-1);
  return SERVICE.slice(start, SERVICE.indexOf('\n  async ', start + 10));
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
