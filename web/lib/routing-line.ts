import type { RoutingTrail } from './types';

/**
 * The routing trail as one line a clinician can read.
 *
 * WHY THIS IS SHARED RATHER THAN WRITTEN TWICE
 * --------------------------------------------
 * Two clients wording the same fact differently is how a doctor at a desk and
 * the same doctor on a phone come to believe different things about where a
 * prescription went. The same reasoning as `course-quantity.ts`, and a byte
 * comparison in `types.drift.test.ts`'s neighbourhood keeps the copies honest.
 *
 * WHAT IT REFUSES TO SAY
 * ----------------------
 * A prescription sent outside this hospital has no return leg — the receiving
 * pharmacy would have to write into the sender's rows to report a collection.
 * So the line says *sent*, and says plainly that what happened next is not
 * known here. Leaving it blank would read as "nothing happened", and a doctor
 * concluding a patient never collected their medicine when the system simply
 * cannot tell is the misreading worth spending a sentence to prevent.
 */
export function routingLine(trail: RoutingTrail | undefined, when: (iso: string) => string): {
  where: string;
  outcome: string;
  /** True where the outcome is a refusal the clinician has to act on. */
  needsAction: boolean;
} | null {
  if (!trail) return null;

  const where =
    trail.destination === 'IN_HOUSE'
      ? 'This hospital'
      : trail.destination === 'PARTNER'
        ? (trail.partnerName ?? 'A partner')
        : 'Outside — the patient carries it';

  if (trail.declinedAt) {
    return {
      where,
      outcome: `Declined ${when(trail.declinedAt)}${
        trail.declineReason ? ` — ${trail.declineReason}` : ''
      }`,
      needsAction: true,
    };
  }

  if (trail.reportedAt) {
    return { where, outcome: `Reported ${when(trail.reportedAt)}`, needsAction: false };
  }

  if (trail.fulfilmentUnknown) {
    return {
      where,
      outcome: `Sent ${when(trail.sentAt)} — collection is not tracked here`,
      needsAction: false,
    };
  }

  return { where, outcome: `Sent ${when(trail.sentAt)} — awaiting report`, needsAction: false };
}
