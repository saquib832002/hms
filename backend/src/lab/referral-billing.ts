import { ReferralBilling } from '@prisma/client';

/**
 * Words for who pays the laboratory, in one place.
 *
 * The two modes are told apart by a single enum member and mean opposite
 * things about whose money is involved, so the phrasing has to be identical
 * everywhere it appears — the ordering screen, the accession notice, the
 * partner list, the invoice. Retyping it per screen is how the pharmacy ended
 * up describing the same setting three different ways.
 */
export const REFERRAL_BILLING_LABEL: Record<ReferralBilling, string> = {
  ORIGIN_PAYS: 'We pay the lab',
  PATIENT_PAYS: 'Patient pays the lab',
};

/** The same fact from the receiving laboratory's side of the table. */
export const REFERRAL_BILLING_LABEL_INBOUND: Record<ReferralBilling, string> = {
  ORIGIN_PAYS: 'Billed to the referring hospital',
  PATIENT_PAYS: 'Billed to the patient',
};

export const REFERRAL_BILLING_HINT: Record<ReferralBilling, string> = {
  ORIGIN_PAYS:
    'We charge the patient here and settle with the laboratory ourselves. They never deal with the lab.',
  PATIENT_PAYS:
    'We charge nothing for the test. The patient goes to the laboratory and pays at their counter.',
};

/**
 * How a refusal names the arrangement, mid-sentence.
 *
 * Separate from the label because a refusal reads as prose — "no longer
 * accepts referrals we pay for" is not a sentence, and a message somebody
 * cannot parse is one they act on wrongly.
 */
export function billingPhrase(mode: ReferralBilling): string {
  return mode === ReferralBilling.ORIGIN_PAYS
    ? 'billed to the referring hospital'
    : 'paid by the patient at their counter';
}

/**
 * Is this hospital charging the patient for this test?
 *
 * `false` here is deliberately **not** the same as "unpriced", and the two must
 * never be merged into one absence. See `LabOrderItem.payableExternally`.
 */
export function hospitalCharges(
  destination: 'IN_HOUSE' | 'PARTNER' | 'EXTERNAL',
  mode: ReferralBilling | null,
): boolean {
  if (destination === 'IN_HOUSE') return true;
  /*
   * EXTERNAL is a named laboratory outside the platform — no partnership row,
   * no accession here, and the patient walks in and pays them. Which is
   * PATIENT_PAYS in everything but name, and it gets the same treatment: no
   * charge raised, and the item flagged so it is not counted as one nobody
   * priced.
   */
  if (destination === 'EXTERNAL') return false;
  return mode === ReferralBilling.ORIGIN_PAYS;
}
