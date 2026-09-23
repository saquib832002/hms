import type { ReferralBilling } from './types';

/**
 * Words for who pays a laboratory for referred work.
 *
 * ONE FILE, TWO BYTE-IDENTICAL COPIES
 * -----------------------------------
 * `web/lib/referral-billing.ts` and `mobile/lib/referral-billing.ts` are the
 * same file, for the reason `course-quantity.ts`, `routing-line.ts` and
 * `types.ts` are: Metro resolves no shared package here without config nobody
 * has run on a device. A drift test pins them together.
 *
 * WHY THE WORDING IS SHARED AND NOT RETYPED
 * -----------------------------------------
 * Two modes, told apart by one enum member, meaning opposite things about
 * whose money is at stake. A screen that says "patient pays" where another
 * says "we pay" — or, worse, one that abbreviates to "external" — leaves an
 * administrator guessing which way round a partnership is set up, and the
 * consequence of guessing wrong is an invoice nobody expected or a test
 * nobody billed for.
 *
 * The pharmacy settings ended up describing one setting three different ways
 * for exactly this reason.
 */

/** From the sending hospital's side: whose money leaves this building. */
export const BILLING_LABEL: Record<ReferralBilling, string> = {
  ORIGIN_PAYS: 'We pay the lab',
  PATIENT_PAYS: 'Patient pays the lab',
};

/** From the performing laboratory's side: whose money arrives. */
export const BILLING_LABEL_INBOUND: Record<ReferralBilling, string> = {
  ORIGIN_PAYS: 'Billed to the referring hospital',
  PATIENT_PAYS: 'Billed to the patient',
};

export const BILLING_HINT: Record<ReferralBilling, string> = {
  ORIGIN_PAYS:
    'We charge the patient here and settle with the laboratory ourselves. They never deal with the lab.',
  PATIENT_PAYS:
    'We charge nothing for the test. The patient goes to the laboratory and pays at their counter.',
};

/**
 * Every mode, in a fixed order, so a picker cannot be built from
 * `Object.keys` and silently reorder itself when the enum changes.
 *
 * `ORIGIN_PAYS` first because it is the default and the arrangement every
 * partnership predating this had.
 */
export const BILLING_MODES: ReferralBilling[] = ['ORIGIN_PAYS', 'PATIENT_PAYS'];

/**
 * Why a partnership can no longer be used, in words an administrator can act
 * on.
 *
 * The person who *meets* this refusal is usually a doctor mid-consultation who
 * cannot fix it, so the sentence names the other hospital's decision and who
 * here can respond to it. A bare "not available" is the dead end this project
 * has had to reopen five times.
 */
export function lapsedReason(
  lapsed: 'no-longer-accepting' | 'billing-not-accepted' | null,
  label: string,
): string | null {
  if (lapsed === 'no-longer-accepting') {
    return `${label} has stopped accepting work from other hospitals. Tests cannot be sent there until they switch it back on.`;
  }
  if (lapsed === 'billing-not-accepted') {
    return `${label} no longer accepts work billed this way. Change how this partnership is billed, or ask them to switch it back on.`;
  }
  return null;
}

/**
 * Why a mode cannot be chosen for a given partner.
 *
 * Returned instead of hiding the option. A hidden option is indistinguishable
 * from a feature that does not exist, and the administrator on this side has
 * no way to discover that the missing half is a switch at the other end —
 * which is precisely how the partner-pharmacy handshake read as broken.
 */
export function unavailableReason(
  mode: ReferralBilling,
  accepts: ReferralBilling[],
  label: string,
): string | null {
  if (accepts.includes(mode)) return null;
  if (accepts.length === 0) {
    return `${label} has not said how it will take referred work. Ask them to set it under their clinic settings.`;
  }
  return mode === 'ORIGIN_PAYS'
    ? `${label} does not invoice hospitals. They take payment from the patient at their counter.`
    : `${label} does not take payment from patients directly. They invoice the referring hospital.`;
}
