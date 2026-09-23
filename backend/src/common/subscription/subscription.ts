import { SubscriptionStatus } from '@prisma/client';

/**
 * What a lapsed subscription is allowed to do to a hospital.
 *
 * THE RULE: IT TAKES AWAY WRITES. IT NEVER TAKES AWAY READS, AND IT NEVER
 * TAKES AWAY LOGIN.
 * ------------------------------------------------------------------------
 * The commercial instinct is to deny access until somebody pays, and in most
 * products that is fine. Here it is not. A clinician who cannot open a patient's
 * allergy list mid-consultation is a patient-safety problem, and the cause —
 * a card that expired, an invoice sitting in somebody's inbox — is invisible to
 * everyone in the building. The people harmed are not the people who owe the
 * money.
 *
 * This is the same argument `consultation-billing.spec.ts` already enforces one
 * level down: software must not refuse care over an unpaid balance. It would be
 * incoherent to hold that line for a patient's bill and abandon it for the
 * vendor's.
 *
 * Blocking writes is real leverage and it is safe. A hospital that cannot book
 * tomorrow's appointments will call within the hour, and nothing about that
 * endangers anyone who is already in the building: their record is readable,
 * their history is readable, their allergies are readable.
 *
 * WHAT STAYS OPEN EVEN WHEN LAPSED
 * --------------------------------
 * Authentication, because being unable to sign in is a lockout by another name.
 * Changing your own password, because a forced change would otherwise be an
 * unpassable door. And every GET.
 *
 * A NULL END DATE IS NOT AN EXPIRED ONE
 * -------------------------------------
 * Open-ended is the normal shape of an invoiced hospital contract. Treating a
 * missing date as expired would turn a data-entry gap into an outage, which is
 * the failure this whole file exists to avoid.
 */

/** The commercial facts a request needs to decide whether it may write. */
export interface SubscriptionState {
  status: SubscriptionStatus;
  endsAt: Date | null;
}

/**
 * States that restrict writes on their own, regardless of any date.
 *
 * PAST_DUE is deliberately absent. Chasing an invoice and restricting a
 * hospital are different decisions taken at different times, and collapsing
 * them means the first overdue day silently becomes the restriction — with no
 * human having decided that it should.
 */
const RESTRICTED: SubscriptionStatus[] = [
  SubscriptionStatus.SUSPENDED,
  SubscriptionStatus.CANCELLED,
];

/** True when the hospital may still write. Pure, so the edges can be pinned. */
export function canWrite(state: SubscriptionState, now: Date = new Date()): boolean {
  if (RESTRICTED.includes(state.status)) return false;
  // Open-ended contract. See the header.
  if (state.endsAt === null) return true;
  return state.endsAt.getTime() > now.getTime();
}

/** True when the period has run out on a status that would otherwise allow writes. */
export function hasExpired(state: SubscriptionState, now: Date = new Date()): boolean {
  if (RESTRICTED.includes(state.status)) return false;
  return state.endsAt !== null && state.endsAt.getTime() <= now.getTime();
}

/**
 * How long is left, in whole days. Negative once it has passed, null if open.
 *
 * Used for the warning a hospital admin sees before anything stops working.
 * Somebody being surprised by a restriction is most of the harm here, and a
 * fortnight's notice removes it.
 */
export function daysRemaining(state: SubscriptionState, now: Date = new Date()): number | null {
  if (state.endsAt === null) return null;
  const ms = state.endsAt.getTime() - now.getTime();
  return Math.floor(ms / 86_400_000);
}

/** Days before expiry at which the hospital starts being told. */
export const RENEWAL_WARNING_DAYS = 14;

export function shouldWarn(state: SubscriptionState, now: Date = new Date()): boolean {
  if (!canWrite(state, now)) return false;
  if (state.status === SubscriptionStatus.PAST_DUE) return true;
  const left = daysRemaining(state, now);
  return left !== null && left <= RENEWAL_WARNING_DAYS;
}

/**
 * What the hospital is told when a write is refused.
 *
 * Names the vendor relationship rather than saying "forbidden", because a
 * receptionist meeting this has done nothing wrong and needs to know who to
 * tell. It carries no invoice numbers or amounts — that is between the vendor
 * and whoever signed, not something to put on a clerk's screen.
 */
export function refusalMessage(state: SubscriptionState): string {
  const reason =
    state.status === SubscriptionStatus.CANCELLED
      ? 'This hospital’s subscription has ended.'
      : state.status === SubscriptionStatus.SUSPENDED
        ? 'This hospital’s subscription is suspended.'
        : 'This hospital’s subscription has expired.';

  return (
    `${reason} Existing records stay fully readable, but new entries cannot be saved. ` +
    'Ask an administrator to contact the provider to restore access.'
  );
}
