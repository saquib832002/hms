import { PrismaService } from '../../prisma/prisma.service';

/**
 * Where a prescription or a test order was sent, and what came back.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * `Prescription.destination` and `LabOrder.destination` have existed since
 * routing shipped, along with `routedToTenantId`. Neither ever reached a
 * clinical screen. So a doctor opening a patient's history saw a prescription
 * and a test order with no indication of whether they went to this hospital's
 * own pharmacy, to a partner, or out of the door with the patient — and no
 * indication of when, or whether anything came back.
 *
 * That is the question a clinician actually has when they open a history:
 * *did this happen, and where is it now.* Reported by the product owner.
 *
 * WHY THE PARTNER'S NAME AND NOT ITS ID
 * -------------------------------------
 * `routedToTenantId` is a foreign key into a table the sending hospital cannot
 * read: partner tenants are other companies, and `tenants` carries no policy
 * that would let one hospital read another's row for a *name*. What the sender
 * *can* read is its own directory — `PharmacyPartner` / `LabPartner` — which
 * holds the label that hospital chose when it added the partner. That label is
 * the right thing to show anyway: it is the name their own staff know them by.
 *
 * A removed partner still resolves, because removal is a soft delete and this
 * lookup deliberately does not filter on `isActive`. "Where did this go" is
 * asked precisely when a partnership has ended — the same reasoning that makes
 * the partner lookup ignore `isActive` when re-adding one.
 *
 * WHAT THE TRAIL CANNOT SAY, AND WHY IT SAYS SO
 * ---------------------------------------------
 * The two features are not symmetrical, and pretending otherwise would be the
 * dangerous kind of tidy.
 *
 * A **lab** referral has a return leg: the partner writes results back into the
 * ordering hospital's own rows, so `reportedAt` is a real fact this hospital
 * holds. A **prescription** referral is one-way by design — the receiving
 * pharmacy would have to write into the sender's rows to report a collection,
 * which doubles that feature's blast radius for a convenience. So a prescription
 * trail ends at "sent", and `awaitingReport` is false with `fulfilmentUnknown`
 * true, because a blank where a timestamp should be reads as "nothing happened"
 * and that is the wrong reading.
 */

/** Which side of the product a routed thing belongs to. */
export type RoutedKind = 'PRESCRIPTION' | 'LAB_ORDER';

export interface RoutingTrail {
  /** IN_HOUSE, EXTERNAL or PARTNER, echoed so a client need not infer it. */
  destination: string;
  /** The partner's label from this hospital's own directory. */
  partnerName: string | null;
  /** When it left here. */
  sentAt: Date;
  /** When a report came back. Lab only — see the note above. */
  reportedAt: Date | null;
  /** When the other side refused it, with the reason they gave. */
  declinedAt: Date | null;
  declineReason: string | null;
  /**
   * True where this hospital genuinely cannot learn the outcome, rather than
   * where it simply has not happened yet. The clients render the two
   * differently on purpose.
   */
  fulfilmentUnknown: boolean;
}

/**
 * Resolve partner labels for a batch of rows in one query.
 *
 * Per-row lookups would be an N+1 inside a patient history that already loads
 * prescriptions, records and lab orders — and this runs inside the request's
 * own transaction, which holds a pool connection throughout. The connection
 * budget in this codebase has been a real outage once already.
 */
export async function partnerLabels(
  prisma: PrismaService,
  kind: RoutedKind,
  tenantIds: (number | null | undefined)[],
): Promise<Map<number, string>> {
  const wanted = [...new Set(tenantIds.filter((id): id is number => typeof id === 'number'))];
  if (wanted.length === 0) return new Map();

  /*
   * Deliberately no `isActive` filter. A partnership that has ended is exactly
   * when somebody asks where an old prescription went, and a removed partner
   * resolving to "Unknown" would lose the one fact worth keeping.
   */
  const rows =
    kind === 'PRESCRIPTION'
      ? await prisma.pharmacyPartner.findMany({
          where: { partnerTenantId: { in: wanted } },
          select: { partnerTenantId: true, label: true },
        })
      : await prisma.labPartner.findMany({
          where: { partnerTenantId: { in: wanted } },
          select: { partnerTenantId: true, label: true },
        });

  return new Map(rows.map((r) => [r.partnerTenantId, r.label]));
}

/** Build the trail for one row, given the labels resolved above. */
export function routingTrail(
  kind: RoutedKind,
  row: {
    destination: string;
    routedToTenantId: number | null;
    sentAt: Date;
    reportedAt?: Date | null;
    declinedAt?: Date | null;
    declineReason?: string | null;
  },
  labels: Map<number, string>,
): RoutingTrail {
  const partnerName =
    row.routedToTenantId !== null ? (labels.get(row.routedToTenantId) ?? null) : null;

  return {
    destination: row.destination,
    partnerName,
    sentAt: row.sentAt,
    reportedAt: row.reportedAt ?? null,
    declinedAt: row.declinedAt ?? null,
    declineReason: row.declineReason ?? null,
    /*
     * Only for a prescription that left this hospital. An in-house one is
     * tracked all the way through dispensing, and a lab order has its return
     * leg — neither is unknowable.
     */
    fulfilmentUnknown: kind === 'PRESCRIPTION' && row.destination !== 'IN_HOUSE',
  };
}
