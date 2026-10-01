/**
 * Where a hospital's prescriptions and test requests actually went.
 *
 * WHAT WAS ASKED FOR
 * ------------------
 * *"If a doctor prescribes to an outside pharmacy, we should track those
 * separately from our clinic. What different pharmacies outside my hospital has
 * that prescription gone to. Same for the tests we send to different
 * laboratories."*
 *
 * Both models already carry the answer and nothing reported it:
 * `Prescription.destination` and `LabOrder.destination` are IN_HOUSE, EXTERNAL
 * or PARTNER, with `routedToTenantId` naming the partner. So this is a report
 * over columns that have existed since routing shipped, which is the fourth
 * time in this project a field has been written and never read back.
 *
 * THREE DESTINATIONS, AND THE THIRD IS NOT A PARTNER
 * --------------------------------------------------
 * EXTERNAL is *"the patient takes it away and fills it wherever they choose"*.
 * There is no partner, no code, and nothing to name — so it is its own row
 * rather than an unnamed partner, because a row reading "Partner: (unknown)"
 * invites somebody to go looking for a partnership that was never meant to
 * exist. It is also the number an owner most wants: work walking out of the
 * building with no further trace.
 *
 * THE NAME COMES FROM OUR OWN RECORDS
 * -----------------------------------
 * `PharmacyPartner.label` and `LabPartner.label` live in the *sending*
 * hospital's scope, so resolving a partner's name needs no cross-tenant read
 * and no policy exception. It is also the right name: the label is what this
 * hospital calls them, which is what an administrator here will recognise.
 *
 * A partner whose row was removed still has prescriptions routed to it —
 * removal is a soft delete precisely so *"where did this go"* stays answerable
 * — so a missing label falls back to naming the tenant id rather than dropping
 * the row. A count that silently disappears is worse than one labelled
 * awkwardly.
 *
 * NO DRUG NAME, NO TEST NAME, EVER
 * --------------------------------
 * Counts and partner names only. A test name is frequently the clinical
 * question itself — "HIV antibody", "Beta-hCG" — and this card is read by
 * whoever reconciles bills, which is the same role `labSummaryDescription` and
 * `PartnerLabCharge` already refuse to name a test to. `referrals-out.spec.ts`
 * asserts on the absence rather than on the presence of counts, because a test
 * that only checks the counts are right would still pass if a drug name came
 * along beside them.
 */
import { fromMinor, sumMinor } from '../billing/money';

/** Named after the enum members rather than after a plan. */
export const REFERRAL_DESTINATIONS = ['IN_HOUSE', 'EXTERNAL', 'PARTNER'] as const;
export type ReferralDestination = (typeof REFERRAL_DESTINATIONS)[number];

/** One prescription or one lab order, reduced to where it went. */
export interface RoutedItem {
  destination: string;
  routedToTenantId: number | null;
}

/** A partnership row from *this* hospital's own scope. */
export interface PartnerLabel {
  partnerTenantId: number;
  label: string;
}

/** What one partner received in the period. */
export interface PartnerCount {
  /** The partner's tenant id. Safe here: it is an id this hospital already holds. */
  tenantId: number;
  /** What this hospital calls them. Never the partner's own tenant name. */
  label: string;
  count: number;
}

export interface DestinationBreakdown {
  /** Filled by this hospital's own pharmacy or bench. */
  inHouse: number;
  /**
   * Handed to the patient to fill anywhere. No partner, nothing to follow up,
   * and usually the figure an owner has never seen before.
   */
  external: number;
  /** Total sent to named partners, and the split. */
  partner: number;
  partners: PartnerCount[];
  /** Everything, so a screen never has to add three numbers to show a total. */
  total: number;
}

/**
 * Count by destination, resolving partner labels from our own partnership rows.
 *
 * Partners are sorted by count descending and then by label, so the order is
 * stable between two runs of the same report — a list that reshuffles when
 * nothing changed is one people stop trusting.
 */
export function breakdownByDestination(
  items: RoutedItem[],
  partners: PartnerLabel[],
): DestinationBreakdown {
  const labels = new Map(partners.map((p) => [p.partnerTenantId, p.label]));
  const perPartner = new Map<number, number>();

  let inHouse = 0;
  let external = 0;
  let partner = 0;

  for (const item of items) {
    if (item.destination === 'IN_HOUSE') {
      inHouse += 1;
      continue;
    }
    if (item.destination === 'EXTERNAL') {
      external += 1;
      continue;
    }
    // PARTNER. A PARTNER row with no `routedToTenantId` should not exist, and
    // counting it in the total while dropping it from the split would make the
    // parts disagree with the whole — so it is counted as external, which is
    // what it functionally is: gone, with nobody named.
    partner += 1;
    if (item.routedToTenantId === null) {
      partner -= 1;
      external += 1;
      continue;
    }
    perPartner.set(item.routedToTenantId, (perPartner.get(item.routedToTenantId) ?? 0) + 1);
  }

  const rows: PartnerCount[] = [...perPartner.entries()]
    .map(([tenantId, count]) => ({
      tenantId,
      /*
       * A removed partnership keeps its routed prescriptions — removal is a
       * soft delete exactly so "where did this go" survives — so an absent
       * label names the id rather than dropping the row.
       */
      label: labels.get(tenantId) ?? `Partner #${tenantId}`,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    inHouse,
    external,
    partner,
    partners: rows,
    total: inHouse + external + partner,
  };
}

/**
 * What one partner laboratory invoiced this hospital for, in the period.
 *
 * `partnerName` comes off the charge row itself rather than being resolved
 * from `LabPartner` — the notice captures it at accession for the same reason
 * `DispenseLine.unitPrice` and `PrescriptionItem.medicineName` are captured.
 * A partnership relabelled next quarter must not restate who charged what for
 * work already done, and a partnership *removed* would otherwise leave its
 * historic charges nameless.
 */
export interface PartnerCharge {
  partnerTenantId: number;
  partnerName: string;
  amountMinor: number;
  settled: boolean;
}

export interface PartnerOwing {
  tenantId: number;
  label: string;
  /** Raised in the period, whether settled or not. */
  charged: string;
  /** Of that, still not marked settled by anybody here. */
  unsettled: string;
  charges: number;
}

/**
 * What the partner laboratories charged us, per partner.
 *
 * `PartnerLabCharge` is a **notice**, not accounts payable — no part-payments,
 * no credit notes, no aging, and marking one settled writes no `Payment`
 * because that money never passed through a till. So this totals notices and
 * says which are still open; it deliberately does not look like a creditor
 * ledger, because modelling half of one produces a balance that disagrees with
 * both parties' real books.
 */
export function owedToPartners(charges: PartnerCharge[]): PartnerOwing[] {
  const byPartner = new Map<number, PartnerCharge[]>();

  for (const charge of charges) {
    const existing = byPartner.get(charge.partnerTenantId);
    if (existing) existing.push(charge);
    else byPartner.set(charge.partnerTenantId, [charge]);
  }

  return [...byPartner.entries()]
    .map(([tenantId, rows]) => ({
      tenantId,
      /*
       * The most recent name this partner charged under. They are all the same
       * string in practice; taking the last rather than the first means a
       * rename shows the current one without restating the amounts.
       */
      label: rows[rows.length - 1].partnerName,
      charged: fromMinor(sumMinor(rows.map((r) => r.amountMinor))),
      unsettled: fromMinor(sumMinor(rows.filter((r) => !r.settled).map((r) => r.amountMinor))),
      charges: rows.length,
    }))
    .sort((a, b) => Number(b.charged) - Number(a.charged) || a.label.localeCompare(b.label));
}

/** One lab order item, reduced to whether this hospital charged for it. */
export interface ReferredLine {
  unitPriceMinor: number | null;
  payableExternally: boolean;
}

export interface ReferredBilling {
  /** Lines this hospital charged the patient for. */
  charged: string;
  /**
   * Lines deliberately not ours to charge — `PATIENT_PAYS`, where the patient
   * pays the laboratory directly.
   *
   * **This is not `unpriced`, and merging the two would make both useless.**
   * Under `PATIENT_PAYS` no line is raised *on purpose*; without a flag saying
   * so it is indistinguishable from a test nobody got round to pricing, and
   * every "went out uncharged" figure in the system would report it forever —
   * at which point people stop reading the figure that catches the real ones.
   */
  payableElsewhere: number;
  /**
   * Referred lines with no price and no flag. Genuinely uncharged: somebody
   * meant to bill and the catalogue had no price.
   */
  unpriced: number;
}

export function referredBilling(lines: ReferredLine[]): ReferredBilling {
  const ours = lines.filter((l) => !l.payableExternally);
  return {
    charged: fromMinor(sumMinor(ours.map((l) => l.unitPriceMinor ?? 0))),
    payableElsewhere: lines.filter((l) => l.payableExternally).length,
    unpriced: ours.filter((l) => l.unitPriceMinor === null).length,
  };
}
