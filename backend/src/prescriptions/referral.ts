import { randomBytes } from 'crypto';

/**
 * Sending a prescription to a pharmacy that belongs to somebody else.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP
 * -------------------------------------
 * A row belongs to exactly one hospital, and the database decides who sees it.
 * Everything else in this system rests on that: an unfiltered `patient.count()`
 * returns 40 where the owner sees 80, because the policy — not the query — is
 * the boundary.
 *
 * Routing a prescription to another tenant is the first feature that
 * deliberately moves patient data across that line, and there were two ways to
 * do it. The rejected one was a policy exception making a prescription tagged
 * for hospital B visible to B: one line of SQL, and afterwards
 * `tenantId = app_current_tenant()` is no longer the whole truth. Every future
 * reader of that policy has to know about the carve-out, and the first mistake
 * in it is a cross-hospital breach.
 *
 * So nothing is shared. A snapshot is written into the receiving tenant, owned
 * by them, protected by their own policy like any other row of theirs. That is
 * also how real e-prescribing works — you transmit a message, you do not hand
 * out database access.
 */

/** What actually crosses the boundary. Deliberately small. */
export interface ReferralPayload {
  patientName: string;
  patientDob: Date | null;
  prescriberName: string;
  prescriberRegistrationNo: string | null;
  issuedAt: Date;
  items: { medicineName: string; dosage: string; frequency: string; duration: string }[];
}

/**
 * Everything a prescription holds that must NOT be transmitted.
 *
 * Listed as data rather than left implicit, so `referral.spec.ts` can assert on
 * it and so the next person adding a field to `Prescription` has somewhere to
 * look. Minimum-necessary applies across a company boundary at least as
 * strongly as it does across a role boundary — arguably more, because the
 * receiving pharmacy is not bound by this hospital's policies at all.
 *
 * `allergies` is on this list and it is the uncomfortable one. Transmitting
 * them would let the receiving pharmacist run the same check ours does. It also
 * sends a further slice of clinical history to another company for every
 * prescription, including the ones that are never collected. The decision was
 * to send less and to *say* that less was sent — see `allergyChecked` on the
 * dispensing side, which reports "nothing was looked at" rather than showing an
 * empty warning list that reads like "nothing was found".
 */
export const NEVER_TRANSMITTED = [
  'diagnosis',
  'notes',
  'allergies',
  'medicalRecord',
  'appointmentReason',
  'vitals',
  'admissions',
  'invoice',
] as const;

/**
 * A reference the patient reads out at a counter.
 *
 * Six characters from an alphabet with no `0`/`O` or `1`/`I`/`L`, because this
 * gets spoken down a phone and copied off a printout by somebody who has never
 * seen it before. Unguessability is not the job — the reference is useless
 * without also being the person named on it, and it is unique per receiving
 * pharmacy rather than globally so it can stay short.
 *
 * Crypto-random rather than sequential: a counter would tell the receiving
 * pharmacy how many referrals every other hospital sends.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateReference(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Reduces a prescription to what the receiving pharmacy needs.
 *
 * Pure, and an explicit allowlist rather than a spread of the Prisma row. A
 * spread passes every "does it contain X" test while silently carrying the next
 * field somebody adds to the model — the same reasoning as `toLedgerRow` in the
 * admin reports.
 */
export function toReferralPayload(input: {
  patient: { fullName: string; dob: Date | null };
  doctor: { fullName: string; registrationNo: string | null };
  issuedAt: Date;
  items: { medicineName: string; dosage: string; frequency: string; duration: string }[];
}): ReferralPayload {
  return {
    patientName: input.patient.fullName,
    patientDob: input.patient.dob,
    prescriberName: input.doctor.fullName,
    prescriberRegistrationNo: input.doctor.registrationNo,
    issuedAt: input.issuedAt,
    items: input.items.map((i) => ({
      medicineName: i.medicineName,
      dosage: i.dosage,
      frequency: i.frequency,
      duration: i.duration,
    })),
  };
}
