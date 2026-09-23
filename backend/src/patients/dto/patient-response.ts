import { Allergy, Patient, UserRole } from '@prisma/client';

/**
 * Layer 3 of access control: same route, different response body per role.
 *
 * This is what makes the minimum-necessary boundary real rather than
 * cosmetic. A receptionist and a doctor both call GET /patients/:id; the
 * receptionist's response does not merely hide the clinical fields, it does
 * not contain them.
 *
 * RULE: controllers never return a Prisma model directly. One `include:`
 * added for a doctor feature would otherwise start serving diagnoses to
 * reception, silently, with no error and no test failure.
 */

type PatientWithAllergies = Patient & { allergies?: Allergy[] };

/** Demographics. Safe for every role. */
function demographics(p: Patient) {
  return {
    id: p.id,
    fullName: p.fullName,
    dob: p.dob,
    age: ageFrom(p.dob),
    gender: p.gender,
    phone: p.phone,
    email: p.email,
    address: p.address,
    emergencyContactName: p.emergencyContactName,
    emergencyContactPhone: p.emergencyContactPhone,
    createdAt: p.createdAt,
  };
}

/**
 * Billing-relevant, non-clinical. Reception collects it at registration;
 * billing needs it to claim. A doctor has no use for a policy number, so it is
 * absent from their response — minimum-necessary cuts both ways.
 */
function insurance(p: Patient) {
  return {
    insurerName: p.insurerName ?? null,
    insurancePolicyNumber: p.insurancePolicyNumber ?? null,
  };
}

function clinicalBasics(p: PatientWithAllergies) {
  return {
    bloodGroup: p.bloodGroup,
    allergies:
      p.allergies?.map((a) => ({
        id: a.id,
        substance: a.substance,
        severity: a.severity,
        notes: a.notes,
      })) ?? [],
  };
}

export function toPatientResponse(p: PatientWithAllergies, role: UserRole) {
  switch (role) {
    // Front desk: demographics only. No allergies, no blood group, nothing
    // clinical. This is the strictest boundary in the system.
    case UserRole.RECEPTIONIST:
      return { ...demographics(p), ...insurance(p) };

    // Operational, not clinical. An admin fixing a mistyped registration does
    // not need the diagnosis. Break-glass access, if ever built, must be an
    // explicit and loudly-audited action rather than a default.
    case UserRole.ADMIN:
      return demographics(p);

    // Billing needs to identify, contact and claim for the patient. Nothing
    // clinical — an itemised invoice is as close as they get, and those lines
    // are typed by billing rather than copied from a prescription.
    case UserRole.BILLING_STAFF:
      return { ...demographics(p), ...insurance(p) };

    // Pharmacy needs allergies to dispense safely, but not the full history.
    case UserRole.PHARMACIST:
      return { ...demographics(p), ...clinicalBasics(p) };

    /*
     * The lab gets demographics and nothing clinical — not even allergies.
     *
     * Tempting to hand over the same shape as the pharmacist, since both are
     * "clinical support". They are not the same: a pharmacist needs allergies
     * because giving somebody a drug they react to is the failure dispensing
     * exists to prevent. A technician running a full blood count cannot harm a
     * patient with an allergy they do not know about, so under
     * minimum-necessary they do not get to read one.
     *
     * What the lab does need is age and sex, and those are in `demographics`:
     * reference ranges are age- and sex-banded, so a haemoglobin cannot be
     * flagged correctly without them. The clinical *question* travels on the
     * order itself (`LabOrder.clinicalDetails`), deliberately, because a lab
     * that does not know why a test was asked for cannot comment usefully on
     * the answer — and that is one field the requesting doctor chose to send,
     * not the whole record.
     */
    case UserRole.LAB_TECHNICIAN:
      return demographics(p);

    case UserRole.DOCTOR:
    case UserRole.NURSE:
      return { ...demographics(p), ...clinicalBasics(p) };

    default: {
      // Exhaustiveness check: adding a role to the enum without deciding what
      // it may see becomes a compile error, not a silent full-disclosure bug.
      const _exhaustive: never = role;
      void _exhaustive;
      return demographics(p);
    }
  }
}

/** Compact shape for list views and ⌘K search. Never includes clinical data. */
export function toPatientListItem(p: PatientWithAllergies, role: UserRole) {
  const base = {
    id: p.id,
    fullName: p.fullName,
    dob: p.dob,
    age: ageFrom(p.dob),
    gender: p.gender,
    phone: p.phone,
  };

  // Clinical roles get a flag, not the allergy details — enough to render the
  // warning dot in a list without shipping the substances to every row.
  if (role === UserRole.DOCTOR || role === UserRole.NURSE || role === UserRole.PHARMACIST) {
    return { ...base, hasAllergies: (p.allergies?.length ?? 0) > 0 };
  }
  return base;
}

function ageFrom(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
