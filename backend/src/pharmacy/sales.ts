import { InvoiceItemKind, InvoiceKind, PharmacyBillingMode, Prisma } from '@prisma/client';
import { PriceBasis, apportionTax, taxLine, taxTotals } from '../billing/tax';
import { fromMinor } from '../billing/money';
import { PricedLine, lineTotalMinor, priceSale, toPriceUnits } from './pricing';

/**
 * Turning medicine that left the shelf into a charge.
 *
 * WHERE THE MONEY LANDS, AND WHY IT IS A TENANT SETTING
 * -----------------------------------------------------
 * A hospital pharmacy is either a department or a business, and which one it is
 * changes the answer to three separate questions: whose invoice this goes on,
 * who may take the payment, and whose takings it counts towards. Those are not
 * three settings — they follow from one, so there is one:
 * `Tenant.pharmacyBilling`.
 *
 *   SEPARATE  — its own PHARMACY invoice, paid at the pharmacy counter, and
 *               absent from the billing staff's list entirely. The default,
 *               because it is the mode where drug names never reach a role with
 *               no clinical business.
 *   COMBINED  — appended to the patient's open hospital invoice, so there is one
 *               balance to settle. Billing staff see a rolled-up line; the
 *               itemisation is on the same invoice and shown only to roles that
 *               may read it.
 *
 * WHAT A LINE SAYS
 * ----------------
 * A MEDICINE line names the drug, and that is not negotiable: a receipt that
 * does not say what was bought is not a receipt, and in most places not a legal
 * one either. CLAUDE.md's rule — that an invoice line must never be generated
 * from dispensing — was written to stop a *consultation* invoice leaking a
 * *diagnosis* to a general billing clerk. The pharmacist who sold the
 * amoxicillin already knows about the amoxicillin.
 *
 * So the itemisation exists and the *response* is shaped by role, which is the
 * mechanism `toPatientResponse` already uses for exactly this problem. See
 * `invoice-response.ts`.
 */

/** A medicine leaving stock, with the price it is being sold at. */
export interface SaleLine {
  medicineId: number;
  medicineName: string;
  form: string;
  strength: string;
  quantity: number;
  /** Price units, or null when the medicine has no price set. */
  priceUnits: number | null;
  /**
   * The tax rate this medicine carries, already resolved against the
   * hospital's default. Zero when the hospital charges no tax, which is the
   * default and costs nothing.
   */
  taxRateBasisPoints?: number;
  taxRateName?: string | null;
  /** CGST/SGST, or state/county/city. Empty for a flat rate. */
  taxComponents?: { name: string; rateBasisPoints: number }[];
}

export interface PricedSale {
  /**
   * What the patient pays: net plus tax.
   *
   * Named `totalMinor` still, because it has always meant "what this sale
   * comes to" and every caller uses it that way. A hospital with no tax rates
   * sees exactly the number it saw before.
   */
  totalMinor: number;
  /** The tax inside that total. Zero where no rate applies. */
  taxMinor: number;
  /** Before tax. `netMinor + taxMinor === totalMinor`, always. */
  netMinor: number;
  /** Invoice line data, one per medicine — never one per batch. */
  items: {
    medicineId: number;
    description: string;
    quantity: number;
    unitPrice: string;
    /** NET of tax. `taxAmount` completes it. */
    amount: string;
    taxAmount: string;
    taxRateBasisPoints: number;
    taxRateName: string | null;
    /**
     * The split as applied, apportioned so the parts sum to `taxAmount`
     * exactly. Null for a flat rate, which is the ordinary case.
     */
    taxBreakdown: { name: string; rateBasisPoints: number; amount: string }[] | null;
  }[];
  /** Names of medicines that had no price and were therefore not charged. */
  unpriced: string[];
}

/**
 * What one unit of a medicine is called on a bill.
 *
 * Deliberately a plain function rather than an interpolation at the call site,
 * so there is one place to look when somebody asks what appears on a receipt.
 * It carries the catalogue name, form and strength and nothing else — not the
 * prescriber, not the indication, not the ward.
 */
export function medicineLineDescription(line: {
  medicineName: string;
  form: string;
  strength: string;
}): string {
  return `${line.medicineName} ${line.strength} ${line.form}`.replace(/\s+/g, ' ').trim();
}

/**
 * The single line billing staff see in COMBINED mode.
 *
 * A constant with a count, in the shape of `'CONS · Consultation'`. It has to
 * stay free of anything derived from the medicines themselves — "PHARM ·
 * Antibiotics (2)" would be a therapeutic class on an invoice, which is the
 * leak wearing a tidier hat.
 */
export function pharmacySummaryDescription(itemCount: number): string {
  return `PHARM · Medicines (${itemCount} item${itemCount === 1 ? '' : 's'})`;
}

/**
 * Collapses FEFO allocations into one priced line per medicine.
 *
 * Stock comes off in batches — 12 from one box and 9 from another — and a
 * patient does not want a receipt itemised by batch number. The batches are
 * still recorded individually on `DispenseLine`, which is where the traceability
 * question ("which box did this come from") is actually asked.
 */
export function priceLines(lines: SaleLine[], basis: PriceBasis = 'EXCLUSIVE'): PricedSale {
  const byMedicine = new Map<number, SaleLine>();
  for (const line of lines) {
    const existing = byMedicine.get(line.medicineId);
    if (existing) existing.quantity += line.quantity;
    else byMedicine.set(line.medicineId, { ...line });
  }

  const merged = [...byMedicine.values()];
  const priced: PricedLine[] = merged.map((m) => ({
    medicineId: m.medicineId,
    quantity: m.quantity,
    priceUnits: m.priceUnits,
  }));

  const result = priceSale(priced);

  /*
   * Tax, applied to the line total rather than to the unit price.
   *
   * Same reasoning as the rounding rule above: taking a fraction of a penny of
   * tax per tablet and multiplying by thirty is wrong in one direction every
   * time. See `billing/tax.ts` for why the basis matters and why inclusive
   * mode derives the tax by subtraction.
   */
  const taxed = merged
    .map((m, i) => ({ m, total: result.lineTotals[i] }))
    .filter((entry): entry is { m: SaleLine; total: number } => entry.total !== null)
    .map(({ m, total }) => ({ m, tax: taxLine(total, m.taxRateBasisPoints ?? 0, basis) }));

  const items = taxed.map(({ m, tax }) => ({
    medicineId: m.medicineId,
    description: medicineLineDescription(m),
    quantity: m.quantity,
    unitPrice: fromPriceUnitsSafe(m.priceUnits),
    amount: fromMinor(tax.netMinor),
    taxAmount: fromMinor(tax.taxMinor),
    taxRateBasisPoints: tax.rateBasisPoints,
    taxRateName: m.taxRateName ?? null,
    /*
     * Apportioned from the line's tax rather than computed per component.
     *
     * Computing each part independently and rounding leaves them disagreeing
     * with the tax line above them, and an invoice whose components do not add
     * up is one an auditor rejects. See `apportionTax`.
     */
    taxBreakdown:
      (m.taxComponents ?? []).length === 0
        ? null
        : apportionTax(tax.taxMinor, m.taxComponents!).map((c) => ({
            name: c.name,
            rateBasisPoints: c.rateBasisPoints,
            amount: fromMinor(c.amountMinor),
          })),
  }));

  const totals = taxTotals(taxed.map((t) => t.tax));

  const unpriced = merged
    .filter((m) => result.unpricedMedicineIds.includes(m.medicineId))
    .map((m) => medicineLineDescription(m));

  return {
    // The gross is what the patient pays and what the invoice is raised for.
    // In exclusive mode it is more than `result.totalMinor`; in inclusive mode
    // it is exactly that number, with the tax carved out of it.
    totalMinor: totals.grossMinor,
    taxMinor: totals.taxMinor,
    netMinor: totals.netMinor,
    items,
    unpriced,
  };
}

function fromPriceUnitsSafe(units: number | null): string {
  if (units === null) throw new Error('A priced line cannot have a null unit price');
  const whole = Math.floor(units / 10_000);
  return `${whole}.${String(units % 10_000).padStart(4, '0')}`;
}

/** Per-batch unit price and line total, for the `DispenseLine` record. */
export function batchLineValues(
  priceUnits: number | null,
  quantity: number,
): { unitPrice: string | null; lineTotal: string | null } {
  if (priceUnits === null) return { unitPrice: null, lineTotal: null };
  return {
    unitPrice: fromPriceUnitsSafe(priceUnits),
    lineTotal: fromMinor(lineTotalMinor(priceUnits, quantity)),
  };
}

/** Reads a `Medicine.sellingPrice` off a Prisma row into price units. */
export function sellingPriceUnits(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return toPriceUnits(String(value));
}

export interface InvoiceTarget {
  /** An existing open hospital invoice to append to, or null to create one. */
  appendToInvoiceId: number | null;
  kind: InvoiceKind;
}

/**
 * Decides which invoice a sale lands on.
 *
 * Pure, and separate from the transaction that acts on it, because the rule is
 * the interesting part and the writes are not. The COMBINED case has one edge
 * that is easy to miss and annoying in practice: the consultation invoice is
 * raised at check-in and may already be settled by the time the patient reaches
 * the pharmacy. Appending to a paid invoice would reopen a closed balance —
 * exactly the loop the credit-note work was written to close — so a settled
 * invoice gets a second one rather than being reopened.
 */
export function chooseInvoice(
  mode: PharmacyBillingMode,
  openHospitalInvoiceId: number | null,
): InvoiceTarget {
  if (mode === PharmacyBillingMode.COMBINED && openHospitalInvoiceId !== null) {
    return { appendToInvoiceId: openHospitalInvoiceId, kind: InvoiceKind.HOSPITAL };
  }
  return {
    appendToInvoiceId: null,
    kind: mode === PharmacyBillingMode.COMBINED ? InvoiceKind.HOSPITAL : InvoiceKind.PHARMACY,
  };
}

/** The `InvoiceItem.kind` a medicine line carries, wherever it lands. */
export const MEDICINE_ITEM_KIND = InvoiceItemKind.MEDICINE;
