import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DrugClass,
  InvoiceKind,
  InvoiceStatus,
  PharmacyBillingMode,
  PrescriptionDestination,
  PrescriptionStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';
import { AuthUser } from '../common/types/auth-user';
import { checkAllergies, hasBlockingConflict } from './allergy-check';
import { computeQuantity } from './dispense-quantity';
import { allocateFefo, expiringSoon, inDateQuantity, InsufficientStockError, suggestQuantity } from './stock-selection';
import {
  allItemsComplete,
  canBeSettledByHand,
  completionOf,
} from './dispense-completion';
import { DispenseDto } from './dto/dispense.dto';
import { CounterSaleDto } from './dto/counter-sale.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';
import {
  MEDICINE_ITEM_KIND,
  PricedSale,
  SaleLine,
  batchLineValues,
  chooseInvoice,
  pharmacySummaryDescription,
  priceLines,
  sellingPriceUnits,
} from './sales';
import { fromMinor, sumAmounts, toMinor, toMoneyString } from '../billing/money';
import { toPriceString } from './pricing';
import { hospitalDayRange, hospitalMonthRange } from '../common/utils/hospital-time';
import { PriceBasis } from '../billing/tax';
import { TaxContext, TaxContextService } from '../billing/tax-context.service';

/** `Medicine.sellingPrice` as a four-decimal string, or null when unpriced. */
function toPriceStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toPriceString(value);
}

/**
 * Which slice of the referral list to return.
 *
 * A union rather than a boolean pair: "waiting" and "dispensed" and
 * "declined" are three states of one row, and two booleans would allow the
 * two combinations that cannot exist.
 */
export type ReferralStatus = 'waiting' | 'dispensed' | 'declined' | 'all';

/** Batches inside this window show on the "use or lose" report. */
const EXPIRY_WARNING_DAYS = 60;

@Injectable()
export class PharmacyService {
  constructor(
    private prisma: PrismaService,
    // The hospital's timezone decides what "today" contains on this dashboard.
    // A clinic left on another's clock reports a day that ends before its
    // staff arrive, which reads as missing takings rather than a wrong setting.
    private clinic: ClinicSettingsService,
    // Shared with the lab, so the two cannot tax the same hospital differently.
    private tax: TaxContextService,
  ) {}

  /**
   * Prescriptions waiting to be dispensed, oldest first.
   *
   * A patient standing at the counter has been waiting longest, so the queue
   * is FIFO regardless of who wrote the prescription.
   */
  async queue() {
    const prescriptions = await this.prisma.prescription.findMany({
      where: {
        status: { in: [PrescriptionStatus.ISSUED, PrescriptionStatus.PARTIALLY_DISPENSED] },
        /*
         * Only what is meant for this counter.
         *
         * Every prescription used to land here, so a clinic with no pharmacy
         * grew a queue nobody worked, and a patient filling theirs at a chemist
         * near home still showed as waiting at a counter they would never
         * visit. A queue that lists work that is not yours teaches people to
         * ignore it.
         *
         * A filter, not a refusal: `prepareDispense` and `dispense` do NOT
         * check the destination, so if the patient turns up here after all, the
         * pharmacist opens the prescription and hands it over. People change
         * their minds, and a routing note must not become "computer says no".
         */
        destination: PrescriptionDestination.IN_HOUSE,
      },
      orderBy: { issuedAt: 'asc' },
      take: 100,
      include: {
        items: { include: { medicine: true } },
        patient: {
          select: { id: true, fullName: true, dob: true, allergies: { select: { id: true } } },
        },
        doctor: { select: { id: true, fullName: true } },
      },
    });

    return {
      data: prescriptions.map((p) => ({
        id: p.id,
        issuedAt: p.issuedAt,
        status: p.status,
        notes: p.notes,
        patient: {
          id: p.patient!.id,
          fullName: p.patient!.fullName,
          // A flag only. The substances appear when the pharmacist opens the
          // prescription, which is an audited read.
          hasAllergies: (p.patient!.allergies?.length ?? 0) > 0,
        },
        doctor: p.doctor?.fullName ?? null,
        itemCount: p.items?.length ?? 0,
        /** Any item with no catalogue link cannot be allergy-checked by class. */
        hasUncataloguedItem: (p.items ?? []).some((i) => i.medicineId === null),
      })),
    };
  }

  /**
   * Everything the dispensing screen needs: the prescription, per-item stock,
   * a suggested quantity where one can be worked out, and the allergy check.
   *
   * One call rather than several — a pharmacist should not be able to see the
   * medicines before the allergy check has loaded.
   */
  async prepareDispense(prescriptionId: number) {
    const prescription = await this.prisma.prescription.findUnique({
      where: { id: prescriptionId },
      include: {
        items: { include: { medicine: true } },
        patient: { select: { id: true, fullName: true, dob: true, allergies: true } },
        doctor: { select: { id: true, fullName: true, registrationNo: true } },
      },
    });
    if (!prescription) throw new NotFoundException(`Prescription ${prescriptionId} not found`);

    const now = new Date();
    /*
     * The tax context, resolved once for the whole sheet.
     *
     * Sent so the dispensing screen can show the charge building up WITH tax
     * before the pharmacist commits — a running total that excludes tax is a
     * number the patient will not recognise when the invoice appears.
     */
    const tax = await this.taxContext();
    const items = [];

    for (const item of prescription.items ?? []) {
      const batches = item.medicineId
        ? await this.prisma.stockBatch.findMany({
            where: { medicineId: item.medicineId, quantity: { gt: 0 } },
            orderBy: { expiresAt: 'asc' },
          })
        : [];

      /*
       * What is still owed, measured against what the prescriber ORDERED where
       * they said so, and only falling back to the inferred course otherwise.
       *
       * `completionOf` returns `unknown` rather than zero when there is no
       * total to measure against — a PRN or open-ended item. Zero would read on
       * screen as "nothing left to give", which is the opposite of what an
       * open-ended course means.
       */
      const completion = completionOf(item);
      const outstanding = completion.state === 'outstanding' ? completion.remaining : 0;

      items.push({
        id: item.id,
        medicineName: item.medicineName,
        dosage: item.dosage,
        frequency: item.frequency,
        duration: item.duration,
        quantityDispensed: item.quantityDispensed,
        medicine: item.medicine
          ? {
              id: item.medicine.id,
              name: item.medicine.name,
              form: item.medicine.form,
              strength: item.medicine.strength,
              drugClass: item.medicine.drugClass,
              isControlled: item.medicine.isControlled,
            }
          : null,
        /**
         * What one unit sells for, as a string, or null if nobody has priced it.
         *
         * Sent so the pharmacist can see the charge building up before they
         * commit to it. Null renders as "not priced" rather than as 0.00 —
         * a zero here would read as "free", and the two are different.
         */
        unitPrice: item.medicine ? toPriceStringOrNull(item.medicine.sellingPrice) : null,
        /*
         * The rate that WILL be applied, resolved against the hospital's
         * default. Zero when tax is switched off, which is most hospitals.
         */
        taxRateBasisPoints: tax.rateFor(item.medicine?.taxRateId ?? null).basisPoints,
        taxRateName: tax.rateFor(item.medicine?.taxRateId ?? null).name,
        /** The parts, so the sheet shows the same rows the invoice will. */
        taxComponents: tax.rateFor(item.medicine?.taxRateId ?? null).components,
        /**
         * What the prescriber ordered, or null if they left it open.
         *
         * Sent separately from the suggestion so the sheet can say which it is
         * showing. "The doctor ordered 21" and "we think a 7-day course is 21"
         * are different claims, and only one of them is a fact.
         */
        quantityPrescribed: item.quantityPrescribed,
        /** Null means the system will not guess — the pharmacist types it. */
        suggestedQuantity: suggestQuantity(item.dosage, item.frequency, item.duration),
        outstandingQuantity: outstanding > 0 ? outstanding : null,
        /**
         * `complete` | `outstanding` | `unknown`.
         *
         * `unknown` is the one that matters: it is the honest state for an
         * open-ended course, and it used to be silently treated as "not
         * finished", which is how a fully dispensed prescription stayed
         * PARTIALLY_DISPENSED forever.
         */
        completion: completion.state,
        inDateStock: inDateQuantity(batches, now),
        batches: batches.map((b) => ({
          id: b.id,
          batchNumber: b.batchNumber,
          expiresAt: b.expiresAt,
          quantity: b.quantity,
          expired: b.expiresAt <= now,
        })),
      });
    }

    const { conflicts, unmatched } = checkAllergies(
      (prescription.items ?? []).map((i) => ({
        medicineName: i.medicineName,
        drugClass: (i.medicine?.drugClass as DrugClass | undefined) ?? null,
        catalogueName: i.medicine?.name ?? null,
      })),
      (prescription.patient?.allergies ?? []).map((a) => ({
        substance: a.substance,
        severity: a.severity,
      })),
    );

    return {
      /*
       * The pricing mode, so the sheet previews the same arithmetic the server
       * will apply. A pharmacist has no access to clinic settings, so it comes
       * with the data rather than from a second request they cannot make.
       */
      pricesIncludeTax: tax.basis === 'INCLUSIVE',
      id: prescription.id,
      issuedAt: prescription.issuedAt,
      status: prescription.status,
      notes: prescription.notes,
      patient: {
        id: prescription.patient!.id,
        fullName: prescription.patient!.fullName,
        dob: prescription.patient!.dob,
        allergies: (prescription.patient?.allergies ?? []).map((a) => ({
          id: a.id,
          substance: a.substance,
          severity: a.severity,
          notes: a.notes,
        })),
      },
      doctor: prescription.doctor,
      items,
      allergyConflicts: conflicts,
      uncataloguedItems: unmatched,
      requiresOverride: hasBlockingConflict(conflicts),
    };
  }

  /**
   * Which invoice this sale should land on.
   *
   * Reads the hospital's billing mode and, in COMBINED mode, looks for an
   * unsettled hospital invoice for this patient today. See `chooseInvoice` for
   * why a settled invoice is not reopened.
   */
  private async resolveInvoiceTarget(patientId: number | null) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: currentTenantId() },
      select: { pharmacyBilling: true },
    });
    const mode = tenant?.pharmacyBilling ?? PharmacyBillingMode.SEPARATE;

    if (mode !== PharmacyBillingMode.COMBINED || patientId === null) {
      return chooseInvoice(mode, null);
    }

    /*
     * The most recent hospital invoice that still has something to pay.
     *
     * Not "any open invoice ever" — an unpaid bill from three months ago is a
     * debt being chased, and quietly growing it with today's paracetamol makes
     * an aging report meaningless. Voided invoices are excluded for the obvious
     * reason: appending to one would un-void it in substance while it still
     * read as cancelled.
     */
    const open = await this.prisma.invoice.findFirst({
      where: {
        patientId,
        kind: InvoiceKind.HOSPITAL,
        voidedAt: null,
        issuedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { issuedAt: 'desc' },
      select: { id: true, totalAmount: true, amountPaid: true, creditedAmount: true },
    });

    if (!open) return chooseInvoice(mode, null);

    const outstanding =
      toMinor(toMoneyString(open.totalAmount)) -
      toMinor(toMoneyString(open.creditedAmount)) -
      toMinor(toMoneyString(open.amountPaid));

    return chooseInvoice(mode, outstanding > 0 ? open.id : null);
  }

  /**
   * Writes the charge, and returns the invoice it landed on.
   *
   * Returns null when there was nothing to charge — every medicine unpriced, or
   * a hospital that has set no prices at all. An invoice for 0.00 is not the
   * same as no invoice: it looks settled, appears in every list, and hides the
   * fact that nobody has priced anything.
   */

  /**
   * The tax settings in force for this hospital, resolved once per sale.
   *
   * Delegates to `TaxContextService`, which is where the rules live now that
   * the lab charges for its own work. Kept as a method so every call site below
   * reads unchanged, and so there is exactly one place a future reader has to
   * look to confirm the pharmacy and the lab tax identically.
   */
  private taxContext(): Promise<TaxContext> {
    return this.tax.current();
  }

  /**
   * Undo a dispense that never left the counter.
   *
   * WHAT THIS IS FOR, AND WHAT IT IS NOT
   * ------------------------------------
   * The patient could not pay, or changed their mind, and the medicine is
   * still on the pharmacist's side of the counter. Nothing physically
   * happened, so nothing should be recorded as having happened: stock returns
   * to the exact batches it came from, the prescription becomes dispensable
   * again, and the invoice is voided.
   *
   * It is NOT a return. Medicine that has left the premises cannot lawfully be
   * resold in most jurisdictions, so putting it back into saleable stock
   * automatically would be a regulatory problem wearing the shape of a
   * convenience — and it would overstate the number the entire dispensing flow
   * trusts. A genuine return is a refund (money back) plus
   * `POST /pharmacy/stock` (a deliberate restock, with its own trail).
   *
   * The caller has to affirm the medicine did not leave. That is not a
   * formality: it is the only fact that distinguishes the two cases, and no
   * data in the system can tell them apart.
   *
   * WHY MONEY IS REFUSED RATHER THAN REVERSED
   * -----------------------------------------
   * If anything has been paid, this refuses and says so. Returning money is a
   * deliberate act with its own record — `POST /pharmacy/invoices/:id/refunds`
   * — and quietly voiding a paid invoice would make a payment disappear from
   * the day's takings with nothing to explain the gap. Refund first, then
   * reverse.
   */
  async reverseDispense(eventId: number, reason: string, notLeftPremises: boolean, user: AuthUser) {
    if (!notLeftPremises) {
      throw new BadRequestException(
        'A dispense can only be reversed while the medicine is still in the pharmacy. If the patient has taken it, refund the invoice and put the stock back through Receive stock, which records who returned what.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const event = await tx.dispenseEvent.findUnique({
        where: { id: eventId },
        include: {
          lines: true,
          invoice: { select: { id: true, amountPaid: true, voidedAt: true } },
        },
      });
      if (!event) throw new NotFoundException(`Dispense ${eventId} not found`);
      if (event.reversedAt) {
        throw new ConflictException('That dispense has already been reversed');
      }

      if (event.invoice && toMinor(toMoneyString(event.invoice.amountPaid)) > 0) {
        throw new ConflictException(
          'Money has been taken against this sale. Refund it first — a reversal must not make a payment vanish from the day’s takings.',
        );
      }

      /*
       * Stock back to the batch it came from, not to "the medicine".
       *
       * Returning it to whichever batch happens to be nearest expiry would
       * quietly move stock between batches, and the batch number is the thing
       * a recall is traced by. `DispenseLine.batchId` records exactly where
       * each unit came from, which is why this is possible at all.
       */
      for (const line of event.lines) {
        await tx.stockBatch.update({
          where: { id: line.batchId },
          data: { quantity: { increment: line.quantity } },
        });

        /*
         * And the prescription item is un-dispensed by the same amount, so a
         * partially dispensed prescription returns to exactly where it was.
         */
        if (line.prescriptionItemId) {
          await tx.prescriptionItem.update({
            where: { id: line.prescriptionItemId },
            data: { quantityDispensed: { decrement: line.quantity } },
          });
        }
      }

      /*
       * The prescription goes back into the queue.
       *
       * Recomputed from what is left outstanding rather than blindly set to
       * ISSUED: a prescription dispensed in two goes, with only the second
       * reversed, is PARTIALLY_DISPENSED and not ISSUED. Deriving it from the
       * items cannot disagree with the items.
       */
      if (event.prescriptionId) {
        const items = await tx.prescriptionItem.findMany({
          where: { prescriptionId: event.prescriptionId },
          select: { quantityDispensed: true },
        });
        const anyDispensed = items.some((i) => i.quantityDispensed > 0);

        await tx.prescription.update({
          where: { id: event.prescriptionId },
          data: {
            status: anyDispensed
              ? PrescriptionStatus.PARTIALLY_DISPENSED
              : PrescriptionStatus.ISSUED,
            // Cleared so the queue and the drug chart stop treating it as done.
            dispensedAt: anyDispensed ? undefined : null,
          },
        });
      }

      /*
       * The invoice is voided rather than deleted. It was raised, and a bill
       * that vanishes is one nobody can explain to the person who saw it.
       */
      if (event.invoice && !event.invoice.voidedAt) {
        await tx.invoice.update({
          where: { id: event.invoice.id },
          data: {
            voidedAt: new Date(),
            status: InvoiceStatus.CANCELLED,
            notes: `Reversed: ${reason}`,
          },
        });
      }

      return tx.dispenseEvent.update({
        where: { id: eventId },
        data: {
          reversedAt: new Date(),
          reversedById: user.userId,
          reversalReason: reason,
        },
        select: { id: true, reversedAt: true, reversalReason: true },
      });
    });
  }


  /**
   * What the pharmacy sold, took and gave back — today, this week, this month.
   *
   * WHY THE PHARMACY NEEDS ITS OWN, RATHER THAN THE ADMIN DASHBOARD
   * ---------------------------------------------------------------
   * In SEPARATE billing mode these are two businesses. The admin dashboard
   * reports the hospital's takings and deliberately keeps the shop's counter
   * trade beside them rather than inside them — so a pharmacist looking there
   * either sees nothing of their own or sees it mixed with consultations.
   *
   * And the questions differ. An owner asks what the clinic collected; a
   * pharmacist asks what left the shelf, what came back, and whether anything
   * went out unpriced. The last is the one nothing else surfaces daily, and it
   * is how a month of unbilled stock happens.
   *
   * EVERY FIGURE IS GROSS, WITH ITS REVERSAL BESIDE IT
   * --------------------------------------------------
   * Billed and refunded are reported separately and the net is derived — the
   * same rule the admin finance report was rewritten to follow after two
   * screens disagreed about one day. "Sales minus refunds" as a single number
   * is the figure nobody can reconcile against a till.
   */
  async dashboard() {
    const tz = (await this.clinic.current()).timezone;
    const now = new Date();

    const today = hospitalDayRange(now, tz);
    const month = hospitalMonthRange(now, tz);
    /*
     * Seven days INCLUDING today, not "the last calendar week". A pharmacist
     * comparing today against the last week wants a rolling window; a week
     * that resets on Monday makes Monday look catastrophic every Monday.
     */
    const weekStart = new Date(today.start.getTime() - 6 * 24 * 3600_000);

    const windows = [
      { key: 'today' as const, start: today.start, end: today.end },
      { key: 'week' as const, start: weekStart, end: today.end },
      { key: 'month' as const, start: month.start, end: month.end },
    ];

    const periods = [];
    for (const w of windows) {
      /*
       * Sales are counted from dispense events rather than invoices, because a
       * handover with no price still leaves the shelf — and that is exactly the
       * number a pharmacist must not lose sight of. Reversed events are
       * excluded from the sales figure and counted separately: a reversal
       * means the medicine never left, so counting it as a sale and then again
       * as a return would double-count something that did not happen.
       */
      const [events, reversals, invoices, refunds] = await Promise.all([
        this.prisma.dispenseEvent.findMany({
          where: { dispensedAt: { gte: w.start, lt: w.end }, reversedAt: null },
          select: { id: true, invoiceId: true },
        }),
        this.prisma.dispenseEvent.count({
          where: { reversedAt: { gte: w.start, lt: w.end } },
        }),
        this.prisma.invoice.findMany({
          where: {
            kind: InvoiceKind.PHARMACY,
            issuedAt: { gte: w.start, lt: w.end },
            voidedAt: null,
          },
          select: { totalAmount: true, items: { select: { taxAmount: true } } },
        }),
        this.prisma.refund.findMany({
          where: {
            refundedAt: { gte: w.start, lt: w.end },
            invoice: { kind: InvoiceKind.PHARMACY },
          },
          select: { amount: true },
        }),
      ]);

      const payments = await this.prisma.payment.findMany({
        where: {
          receivedAt: { gte: w.start, lt: w.end },
          invoice: { kind: InvoiceKind.PHARMACY },
        },
        select: { amount: true },
      });

      const billedMinor = invoices.reduce(
        (sum, i) => sum + toMinor(toMoneyString(i.totalAmount)),
        0,
      );
      const taxMinor = invoices.reduce(
        (sum, i) =>
          sum + i.items.reduce((t, it) => t + toMinor(toMoneyString(it.taxAmount ?? '0.00')), 0),
        0,
      );
      const collectedMinor = payments.reduce(
        (sum, p) => sum + toMinor(toMoneyString(p.amount)),
        0,
      );
      const refundedMinor = refunds.reduce(
        (sum, r) => sum + toMinor(toMoneyString(r.amount)),
        0,
      );

      periods.push({
        period: w.key,
        sales: events.length,
        /** Handovers with no invoice: nothing on them had a price. */
        unpricedSales: events.filter((e) => e.invoiceId === null).length,
        reversals,
        billed: fromMinor(billedMinor),
        tax: fromMinor(taxMinor),
        collected: fromMinor(collectedMinor),
        refunded: fromMinor(refundedMinor),
        /*
         * Derived, and the headline. Gross in, gross out, net computed — never
         * a single "collected" that has already had refunds taken off it,
         * because that is the figure that cannot be reconciled against either.
         */
        net: fromMinor(collectedMinor - refundedMinor),
      });
    }

    /*
     * What is still owed at this counter, regardless of when it was sold.
     *
     * Not windowed: an unpaid sale from last week is still money outstanding
     * today, and a figure that dropped it at midnight would quietly understate
     * what the till is short.
     */
    const outstanding = await this.prisma.invoice.findMany({
      where: { kind: InvoiceKind.PHARMACY, voidedAt: null },
      select: { totalAmount: true, amountPaid: true, creditedAmount: true },
    });

    const outstandingMinor = outstanding.reduce((sum, i) => {
      const due =
        toMinor(toMoneyString(i.totalAmount)) -
        toMinor(toMoneyString(i.amountPaid)) -
        toMinor(toMoneyString(i.creditedAmount ?? '0.00'));
      return sum + Math.max(0, due);
    }, 0);

    return { periods, outstanding: fromMinor(outstandingMinor) };
  }

  private async chargeSale(
    tx: Prisma.TransactionClient,
    input: {
      target: { appendToInvoiceId: number | null; kind: InvoiceKind };
      patientId: number | null;
      totalMinor: number;
      /** `amount` is NET; `taxAmount` completes it. See `billing/tax.ts`. */
      items: PricedSale['items'];
    },
  ): Promise<number | null> {
    if (input.items.length === 0 || input.totalMinor <= 0) return null;

    const tenantId = currentTenantId();
    const itemData = input.items.map((i) => ({
      tenantId,
      description: i.description,
      amount: i.amount,
      kind: MEDICINE_ITEM_KIND,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      medicineId: i.medicineId,
      /*
       * The rate as applied, copied onto the line.
       *
       * `amount` is the NET; `taxAmount` completes it. Captured rather than
       * referenced for the same reason `unitPrice` is: changing a rate next
       * year must not restate what this patient was charged today.
       */
      taxAmount: i.taxAmount,
      taxRateBasisPoints: i.taxRateBasisPoints,
      taxRateName: i.taxRateName,
      taxBreakdown: i.taxBreakdown ?? undefined,
    }));

    if (input.target.appendToInvoiceId === null) {
      const invoice = await tx.invoice.create({
        data: {
          tenantId,
          patientId: input.patientId,
          kind: input.target.kind,
          totalAmount: fromMinor(input.totalMinor),
          items: { create: itemData },
        },
        select: { id: true },
      });
      return invoice.id;
    }

    /*
     * Appending to an existing invoice re-derives the total from its own lines
     * rather than incrementing it.
     *
     * `{ increment }` is one query shorter and is the version that drifts: a
     * retried request, or a second dispense racing the first, adds twice while
     * the lines are only written once. Summing what is actually there cannot
     * disagree with what is actually there.
     */
    await tx.invoiceItem.createMany({
      data: itemData.map((i) => ({ ...i, invoiceId: input.target.appendToInvoiceId! })),
    });

    const lines = await tx.invoiceItem.findMany({
      where: { invoiceId: input.target.appendToInvoiceId },
      // Net AND tax: the invoice total is what the patient pays. Summing
      // `amount` alone was correct while every line was tax-free and became
      // an under-charge the moment a rate existed.
      select: { amount: true, taxAmount: true },
    });

    await tx.invoice.update({
      where: { id: input.target.appendToInvoiceId },
      data: {
        totalAmount: sumAmounts(
          lines.flatMap((l) => [toMoneyString(l.amount), toMoneyString(l.taxAmount)]),
        ),
      },
    });

    return input.target.appendToInvoiceId;
  }

  /**
   * Hand over medicine.
   *
   * Everything happens in one transaction: stock decremented, dispense event
   * written, item totals updated, prescription status recalculated. A partial
   * failure here would leave stock counted as gone with no record of where it
   * went, or a signed dispense against stock that was never taken.
   */
  async dispense(prescriptionId: number, dto: DispenseDto, user: AuthUser) {
    const prepared = await this.prepareDispense(prescriptionId);

    if (prepared.status === PrescriptionStatus.CANCELLED) {
      throw new ConflictException('That prescription was cancelled and cannot be dispensed');
    }
    if (prepared.status === PrescriptionStatus.DISPENSED) {
      throw new ConflictException('That prescription has already been fully dispensed');
    }
    if (dto.lines.length === 0) {
      throw new BadRequestException('Nothing to dispense');
    }

    /**
     * A blocking allergy conflict stops here unless the pharmacist explicitly
     * overrides with a reason.
     *
     * Not a hard refusal: there are real situations where a medicine is given
     * despite a recorded allergy — a label that turns out to be an intolerance
     * rather than an allergy, or a decision taken with the prescriber. A system
     * that cannot express that gets worked around, and the workaround is
     * invisible.
     *
     * So the override exists, demands a reason, and is recorded on the event
     * where anyone reviewing the dispense will see it.
     */
    if (prepared.requiresOverride) {
      if (!dto.overrideReason?.trim()) {
        throw new ConflictException(
          `Blocked: ${prepared.allergyConflicts
            .filter((c) => c.level === 'BLOCKING')
            .map((c) => c.message)
            .join('; ')}. Dispensing this requires a documented reason.`,
        );
      }
      if (dto.overrideReason.trim().length < 10) {
        throw new BadRequestException('The override reason needs to explain the decision');
      }
    }

    const itemsById = new Map(prepared.items.map((i) => [i.id, i]));
    const now = new Date();

    // Work out every allocation before touching anything. If one line cannot
    // be filled, nothing should have moved.
    const planned: { itemId: number; medicineId: number; batchId: number; quantity: number }[] = [];

    for (const line of dto.lines) {
      const item = itemsById.get(line.prescriptionItemId);
      if (!item) {
        throw new BadRequestException(`Item ${line.prescriptionItemId} is not on this prescription`);
      }
      if (!item.medicine) {
        throw new BadRequestException(
          `"${item.medicineName}" is not linked to the catalogue, so stock cannot be tracked. Map it to a medicine first.`,
        );
      }
      if (line.quantity <= 0) {
        throw new BadRequestException('Quantity must be greater than zero');
      }

      try {
        const allocations = allocateFefo(
          item.batches.map((b) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            expiresAt: b.expiresAt as Date,
            quantity: b.quantity,
          })),
          line.quantity,
          now,
        );
        for (const a of allocations) {
          planned.push({
            itemId: item.id,
            medicineId: item.medicine.id,
            batchId: a.batchId,
            quantity: a.quantity,
          });
        }
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          throw new ConflictException(
            `Not enough in-date stock for ${item.medicineName}: ${err.available} available, ${line.quantity} requested`,
          );
        }
        throw err;
      }
    }

    /*
     * Price before the transaction opens.
     *
     * Reading `sellingPrice` is a read, and doing it inside the write
     * transaction lengthens the window in which two pharmacists are contending
     * for the same batch rows for no benefit — the price is not what they are
     * contending over.
     */
    const medicineIds = [...new Set(planned.map((p) => p.medicineId))];
    const catalogue = new Map(
      (
        await this.prisma.medicine.findMany({
          where: { id: { in: medicineIds } },
          select: { id: true, name: true, form: true, strength: true, sellingPrice: true, taxRateId: true },
        })
      ).map((m) => [m.id, m]),
    );

    const tax = await this.taxContext();
    const saleLines: SaleLine[] = planned.map((p) => {
      const m = catalogue.get(p.medicineId);
      return {
        medicineId: p.medicineId,
        medicineName: m?.name ?? 'Unknown medicine',
        form: m?.form ?? '',
        strength: m?.strength ?? '',
        quantity: p.quantity,
        priceUnits: sellingPriceUnits(m?.sellingPrice ?? null),
        taxRateBasisPoints: tax.rateFor(m?.taxRateId ?? null).basisPoints,
        taxRateName: tax.rateFor(m?.taxRateId ?? null).name,
        taxComponents: tax.rateFor(m?.taxRateId ?? null).components,
      };
    });
    const priced = priceLines(saleLines, tax.basis);
    const priceByMedicine = new Map(saleLines.map((l) => [l.medicineId, l.priceUnits]));

    const patientId = prepared.patient.id;
    const target = await this.resolveInvoiceTarget(patientId);

    const eventId = await this.prisma.$transaction(async (tx) => {
      const invoiceId = await this.chargeSale(tx, {
        target,
        patientId,
        totalMinor: priced.totalMinor,
        items: priced.items,
      });

      const event = await tx.dispenseEvent.create({
        data: {
          tenantId: currentTenantId(),
          prescriptionId,
          patientId,
          invoiceId,
          pharmacistId: user.userId,
          notes: dto.overrideReason
            ? `ALLERGY OVERRIDE: ${dto.overrideReason.trim()}${dto.notes ? ` — ${dto.notes}` : ''}`
            : dto.notes,
        },
      });

      for (const p of planned) {
        // Conditional decrement: `quantity: { gte: p.quantity }` means a
        // concurrent dispense that emptied the batch first makes this update
        // match zero rows rather than driving stock negative.
        const updated = await tx.stockBatch.updateMany({
          where: { id: p.batchId, quantity: { gte: p.quantity } },
          data: { quantity: { decrement: p.quantity } },
        });
        if (updated.count === 0) {
          throw new ConflictException(
            'Stock changed while this was being dispensed. Reload and try again.',
          );
        }

        // The price is written onto the line, not looked up later. Repricing
        // the catalogue tomorrow must not restate what this patient was
        // charged today — the same decision as `medicineName` staying free
        // text on a prescription item.
        const values = batchLineValues(priceByMedicine.get(p.medicineId) ?? null, p.quantity);

        await tx.dispenseLine.create({
          data: {
            tenantId: currentTenantId(),
            eventId: event.id,
            prescriptionItemId: p.itemId,
            medicineId: p.medicineId,
            batchId: p.batchId,
            quantity: p.quantity,
            unitPrice: values.unitPrice,
            lineTotal: values.lineTotal,
          },
        });
      }

      // Per-item running totals.
      const perItem = new Map<number, number>();
      for (const p of planned) perItem.set(p.itemId, (perItem.get(p.itemId) ?? 0) + p.quantity);
      for (const [itemId, quantity] of perItem) {
        await tx.prescriptionItem.update({
          where: { id: itemId },
          data: { quantityDispensed: { increment: quantity } },
        });
      }

      /*
       * Fully dispensed when every item has met what the prescriber ordered.
       *
       * The old rule compared against a quantity INFERRED from free text, and
       * treated "could not infer" as "not finished" — so an unparseable
       * duration meant the prescription could never leave
       * PARTIALLY_DISPENSED, however much had gone over the counter. See
       * `dispense-completion.ts`.
       *
       * An item with no fixed total still withholds the automatic verdict,
       * because "we cannot tell about this line" is not "it is finished". The
       * difference is that the pharmacist can now say so, through
       * `markFullyDispensed`.
       */
      const items = await tx.prescriptionItem.findMany({ where: { prescriptionId } });
      const complete = allItemsComplete(items);

      await tx.prescription.update({
        where: { id: prescriptionId },
        data: {
          status: complete ? PrescriptionStatus.DISPENSED : PrescriptionStatus.PARTIALLY_DISPENSED,
          dispensedAt: complete ? new Date() : null,
          dispensedById: complete ? user.userId : null,
        },
      });

      return event.id;
    });

    const event = await this.dispenseEvent(eventId);
    return {
      ...event,
      /*
       * The charge, reported back rather than left to be discovered.
       *
       * `unpriced` is the half that matters: those medicines were handed over
       * and not billed, which is a thing the pharmacist can still act on while
       * the patient is in front of them. Silence here is how a month of
       * unbilled stock happens.
       */
      charge: {
        invoiceId: event?.invoiceId ?? null,
        total: fromMinor(priced.totalMinor),
        unpriced: priced.unpriced,
      },
    };
  }

  async dispenseEvent(id: number) {
    return this.prisma.dispenseEvent.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            medicine: { select: { id: true, name: true, form: true, strength: true } },
            batch: { select: { id: true, batchNumber: true, expiresAt: true } },
          },
        },
        pharmacist: { select: { id: true, fullName: true } },
        prescription: {
          select: { id: true, status: true, patient: { select: { id: true, fullName: true } } },
        },
      },
    });
  }

  async history(limit = 50) {
    return {
      data: await this.prisma.dispenseEvent.findMany({
        orderBy: { dispensedAt: 'desc' },
        take: Math.min(limit, 200),
        include: {
          lines: { include: { medicine: { select: { name: true } } } },
          pharmacist: { select: { id: true, fullName: true } },
          prescription: {
            select: { id: true, patient: { select: { id: true, fullName: true } } },
          },
        },
      }),
    };
  }

  /**
   * Stock, with the two questions a pharmacist actually asks: what is running
   * out, and what is about to expire.
   */
  // ── prescriptions written somewhere else ──────────────────────────────────

  /**
   * Prescriptions sent to this pharmacy by another hospital.
   *
   * These are `PrescriptionReferral` rows — copies transmitted into this
   * tenant, owned by it, read through its own policy like anything else. There
   * is no link back to the other hospital's data and there is not meant to be.
   */
  async referrals(status: ReferralStatus = 'waiting') {
    /*
     * A queue that only ever showed what was waiting.
     *
     * Once a referral was dispensed or declined it left the list and there
     * was nowhere else to look — so "which patients did the other hospital
     * send us, and what happened to them" could not be answered at all, even
     * though every row records it. The trail was complete and invisible.
     *
     * Reported from use, and it is the third time this exact shape has
     * appeared: the pharmacy invoice list hid every settled invoice, the
     * refund screen could not find a paid one. A working list filtered to the
     * open items is the most natural thing to build and it is wrong every
     * time, because the question people actually bring to a screen is often
     * about something that has already finished.
     */
    const where =
      status === 'waiting'
        ? { dispensedAt: null, declinedAt: null }
        : status === 'dispensed'
          ? { dispensedAt: { not: null } }
          : status === 'declined'
            ? { declinedAt: { not: null } }
            : {};

    const rows = await this.prisma.prescriptionReferral.findMany({
      where,
      /*
       * Waiting reads oldest-first — the patient who has waited longest is
       * next. History reads newest-first, because looking something up means
       * looking for something recent.
       */
      orderBy: status === 'waiting' ? { createdAt: 'asc' } : { createdAt: 'desc' },
      take: 100,
      include: { items: true },
    });

    return {
      data: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        from: r.sourceTenantName,
        patientName: r.patientName,
        patientDob: r.patientDob,
        prescriberName: r.prescriberName,
        prescriberRegistrationNo: r.prescriberRegistrationNo,
        issuedAt: r.issuedAt,
        createdAt: r.createdAt,
        /*
         * The outcome, always sent rather than inferred from absence.
         *
         * A pharmacist looking at history needs "declined, out of stock" to
         * read differently from "still waiting", and both differently from
         * "dispensed". Sending only what a filtered list implies would put
         * that reasoning back in the client, where the two would drift.
         */
        dispensedAt: r.dispensedAt,
        declinedAt: r.declinedAt,
        declineReason: r.declineReason,
        items: (r.items ?? []).map((i) => ({
          /*
           * The line as written, plus what it works out to.
           *
           * Computed here rather than in each client: two implementations of
           * "twice a day for a week is fourteen" is two chances to disagree,
           * on a number somebody counts tablets against.
           */
          ...computeQuantity(i.dosage, i.frequency, i.duration),
          medicineName: i.medicineName,
          dosage: i.dosage,
          frequency: i.frequency,
          duration: i.duration,
        })),
        /*
         * Stated, not implied.
         *
         * The sending hospital deliberately does not transmit allergies —
         * minimum-necessary across a company boundary — so this pharmacy has
         * nothing to check against. An empty warnings list would read as
         * "nothing found"; this says "nothing was looked at", which is a
         * different and much more important sentence. Same distinction the
         * counter sale already makes.
         */
        allergyChecked: false,
      })),
    };
  }

  /**
   * Decline one. Kept rather than deleted.
   *
   * Out of stock, wrong pharmacy, a patient who never arrived — all ordinary.
   * A referral that vanished is indistinguishable from one that never arrived,
   * and the sending hospital has no way to ask.
   */
  /**
   * The pharmacist says a prescription is finished.
   *
   * WHY A HUMAN HAS TO BE ABLE TO DO THIS
   * -------------------------------------
   * Some courses genuinely have no computable total — "as directed", "until
   * review", an inhaler, a PRN analgesic. The system is right not to guess at
   * one. But until now that refusal led nowhere: the prescription sat at
   * PARTIALLY_DISPENSED permanently, and nothing anywhere could move it, even
   * with the medicine already in the patient's hand.
   *
   * That is the same shape as the drug-chart items the parser refused to
   * schedule and no screen could set, and the wards only the seed could create.
   * A safe refusal with no route for a human to supply the answer is not safe.
   *
   * TWO REFUSALS, BOTH LOAD-BEARING
   * -------------------------------
   * Nothing may be *known* to be outstanding. If a line still owes twenty
   * tablets, closing the prescription would record a half-filled course as
   * finished — a worse error than leaving it open, and one the patient
   * discovers rather than the pharmacist.
   *
   * And something must actually have been dispensed. Marking an untouched
   * prescription complete would take it out of the queue without anybody
   * receiving anything, which is how a prescription silently goes unfilled.
   */
  async markFullyDispensed(prescriptionId: number, user: AuthUser) {
    const prescription = await this.prisma.prescription.findUnique({
      where: { id: prescriptionId },
      include: { items: true },
    });
    if (!prescription) throw new NotFoundException(`Prescription ${prescriptionId} not found`);

    if (prescription.status === PrescriptionStatus.DISPENSED) {
      throw new ConflictException('That prescription is already marked fully dispensed');
    }
    if (prescription.status === PrescriptionStatus.CANCELLED) {
      throw new ConflictException('That prescription was cancelled');
    }

    const items = prescription.items ?? [];

    if (!items.some((i) => i.quantityDispensed > 0)) {
      throw new ConflictException(
        'Nothing has been dispensed against this prescription yet. Dispense it first.',
      );
    }

    if (!canBeSettledByHand(items)) {
      const owing = items
        .map((i) => ({ item: i, c: completionOf(i) }))
        .filter((x) => x.c.state === 'outstanding');

      if (owing.length > 0) {
        throw new ConflictException(
          `Still outstanding: ${owing
            .map((x) => `${x.item.medicineName} (${(x.c as { remaining: number }).remaining} more)`)
            .join(', ')}. Dispense the rest, or this would record a half-filled course as finished.`,
        );
      }
      throw new ConflictException('Every item already has a quantity and has been met');
    }

    return this.prisma.prescription.update({
      where: { id: prescriptionId },
      data: {
        status: PrescriptionStatus.DISPENSED,
        dispensedAt: new Date(),
        // Who decided, not who dispensed. On an open-ended course those can be
        // different people on different days, and the trail should say which
        // pharmacist called it finished.
        dispensedById: user.userId,
      },
      include: { items: true },
    });
  }

  async declineReferral(id: number, reason: string) {
    const referral = await this.prisma.prescriptionReferral.findUnique({ where: { id } });
    if (!referral) throw new NotFoundException(`Referral ${id} not found`);
    if (referral.dispensedAt) {
      throw new ConflictException('That referral has already been dispensed');
    }

    await this.prisma.prescriptionReferral.update({
      where: { id },
      data: { declinedAt: new Date(), declineReason: reason.trim() },
    });
    return { id, declined: true };
  }

  async inventory(query?: string, sort: 'expiry' | 'name' = 'expiry') {
    const now = new Date();
    const tax = await this.taxContext();
    const medicines = await this.prisma.medicine.findMany({
      where: {
        isActive: true,
        ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      include: { batches: { orderBy: { expiresAt: 'asc' } } },
    });

    const rows = medicines.map((m) => {
      const batches = (m.batches ?? []).map((b) => ({
        id: b.id,
        batchNumber: b.batchNumber,
        expiresAt: b.expiresAt,
        quantity: b.quantity,
        expired: b.expiresAt <= now,
      }));
      const inDate = inDateQuantity(
        batches.map((b) => ({ ...b, expiresAt: b.expiresAt as Date })),
        now,
      );

      return {
        id: m.id,
        name: m.name,
        form: m.form,
        strength: m.strength,
        drugClass: m.drugClass,
        isControlled: m.isControlled,
        reorderLevel: m.reorderLevel,
        /** Per unit, or null when unpriced. Never coerced to 0.0000. */
        sellingPrice: toPriceStringOrNull(m.sellingPrice),
        /*
         * The rate that will apply at the till, resolved against the
         * hospital's default. Sent so the counter sale can show the tax
         * building up before the sale is committed — a basket total that
         * excludes tax is a number the customer will not recognise on the
         * receipt.
         */
        taxRateBasisPoints: tax.rateFor(m.taxRateId).basisPoints,
        taxRateName: tax.rateFor(m.taxRateId).name,
        /*
         * The parts, so the till can show CGST and SGST as separate rows
         * before the sale is committed rather than one combined "Tax". A
         * running total that groups differently from the receipt is a
         * discrepancy the customer sees at the counter.
         */
        taxComponents: tax.rateFor(m.taxRateId).components,
        inDateQuantity: inDate,
        expiredQuantity: batches.filter((b) => b.expired).reduce((s, b) => s + b.quantity, 0),
        belowReorderLevel: inDate < m.reorderLevel,
        expiringSoon: expiringSoon(
          batches.map((b) => ({ ...b, expiresAt: b.expiresAt as Date })),
          EXPIRY_WARNING_DAYS,
          now,
        ),
        /**
         * The soonest date any sellable unit of this medicine goes out of date.
         *
         * In-date batches with stock only. An expired batch cannot be sold, so
         * including it would put a medicine at the top of a "shift this first"
         * list on the strength of stock that has to be destroyed — the opposite
         * of the answer. Null when there is nothing sellable at all.
         */
        earliestExpiry:
          batches
            .filter((b) => !b.expired && b.quantity > 0)
            .reduce<Date | null>(
              (soonest, b) =>
                soonest === null || (b.expiresAt as Date) < soonest ? (b.expiresAt as Date) : soonest,
              null,
            ) ?? null,
        batches,
      };
    });

    /*
     * Ordered by what expires first, because that is what should be sold first.
     *
     * FEFO already decides which *batch* leaves the shelf — `allocateFefo` does
     * that on every dispense and counter sale, and no display order can change
     * it. What this changes is which *medicine* a pharmacist thinks to push,
     * which is a judgement they can only make if the list tells them.
     *
     * Medicines with nothing sellable sort last whatever the mode. A null
     * expiry sorts first in most naive comparators, which would head the list
     * with rows that have nothing to sell — the exact opposite of the point.
     *
     * Name order stays available: it is the right mode when you are checking a
     * count against a shelf, which runs alphabetically.
     */
    if (sort === 'expiry') {
      rows.sort((a, b) => {
        if (a.earliestExpiry === null && b.earliestExpiry === null) {
          return a.name.localeCompare(b.name);
        }
        if (a.earliestExpiry === null) return 1;
        if (b.earliestExpiry === null) return -1;
        return (
          a.earliestExpiry.getTime() - b.earliestExpiry.getTime() || a.name.localeCompare(b.name)
        );
      });
    }

    return {
      /*
       * The pricing mode, alongside the rows.
       *
       * The client needs it to preview correctly: in INCLUSIVE mode the tax is
       * carved out of the price shown, in EXCLUSIVE it is added on top. Sent
       * from the server rather than fetched from clinic settings, which a
       * pharmacist has no access to.
       */
      pricesIncludeTax: tax.basis === 'INCLUSIVE',
      data: rows,
      stats: {
        medicines: rows.length,
        belowReorderLevel: rows.filter((r) => r.belowReorderLevel).length,
        outOfStock: rows.filter((r) => r.inDateQuantity === 0).length,
        expiringSoon: rows.filter((r) => r.expiringSoon.length > 0).length,
        hasExpiredStock: rows.filter((r) => r.expiredQuantity > 0).length,
      },
    };
  }

  async receiveStock(
    medicineId: number,
    batchNumber: string,
    expiresAt: Date,
    quantity: number,
    user: AuthUser,
    costPrice?: string | null,
  ) {
    if (user.role !== 'PHARMACIST' && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only pharmacy staff can receive stock');
    }
    if (quantity <= 0) throw new BadRequestException('Quantity must be greater than zero');
    if (expiresAt <= new Date()) {
      throw new BadRequestException('That batch has already expired');
    }

    const medicine = await this.prisma.medicine.findUnique({ where: { id: medicineId } });
    if (!medicine) throw new NotFoundException(`Medicine ${medicineId} not found`);

    // Validated here rather than trusted from the DTO: `toPriceUnits` refuses
    // to coerce, so a malformed cost is rejected instead of quietly becoming a
    // margin figure somebody later reports on.
    const cost = costPrice === undefined || costPrice === null ? undefined : toPriceString(costPrice);

    /*
     * A batch is a physical lot, and the lot is the unit of everything.
     *
     * A delivery with a *different* batch number is already a separate row —
     * that is what `StockBatch` is for, and it is why FEFO can pick the
     * shortest-dated box, why an expiry warning names which carton, and why a
     * cost price can differ between deliveries without restating the last one.
     * Nothing about that needed changing.
     *
     * What did: the same batch number arriving twice.
     */
    const existing = await this.prisma.stockBatch.findUnique({
      where: { medicineId_batchNumber: { medicineId, batchNumber } },
      select: { id: true, expiresAt: true, costPrice: true },
    });

    if (!existing) {
      return this.prisma.stockBatch.create({
        data: {
          tenantId: currentTenantId(),
          medicineId,
          batchNumber,
          expiresAt,
          quantity,
          costPrice: cost ?? null,
        },
      });
    }

    /*
     * THE BUG THIS REPLACES
     * ---------------------
     * The upsert's update branch incremented the quantity and never touched
     * `expiresAt`, so receiving the same batch number with a different expiry
     * date **silently kept the old one**. Both directions are wrong and one is
     * dangerous: if the new carton expires sooner, its units are now recorded
     * as in date past their real expiry and FEFO will happily dispense them.
     *
     * Two rows is not the answer either — `@@unique([medicineId, batchNumber])`
     * exists because a batch number identifies one manufactured lot, and two
     * rows claiming to be the same lot with different expiries is a stock count
     * nobody can reconcile.
     *
     * So it is refused, with both dates named. Same batch number and a
     * different expiry means one of the two is a typo, and a human holding the
     * carton is the only thing that can say which.
     */
    if (existing.expiresAt.getTime() !== expiresAt.getTime()) {
      throw new ConflictException(
        `Batch ${batchNumber} of ${medicine.name} is already recorded as expiring ` +
          `${existing.expiresAt.toISOString().slice(0, 10)}, but this delivery says ` +
          `${expiresAt.toISOString().slice(0, 10)}. A batch number identifies one lot, so one ` +
          `of these is wrong — check the carton. If it is genuinely a different lot, it needs ` +
          `its own batch number.`,
      );
    }

    return this.prisma.stockBatch.update({
      where: { id: existing.id },
      data: {
        quantity: { increment: quantity },
        /*
         * Cost is set once per lot and then left alone.
         *
         * Overwriting it was the previous behaviour and it restates history:
         * units from this batch may already have been sold and reported at the
         * old cost, and changing it moves a margin figure for a sale that
         * happened last month. Averaging would be the accountant's answer and
         * needs a decision about what to do with those already-sold units, so
         * it is absent rather than half-built.
         *
         * A genuinely different price means a different purchase, which means a
         * different batch number — the same conclusion the expiry check reaches.
         */
        ...(cost && existing.costPrice === null ? { costPrice: cost } : {}),
      },
    });
  }

  /**
   * Sell medicine over the counter, with no prescription behind it.
   *
   * WHAT MAKES THIS DIFFERENT FROM DISPENSING
   * -----------------------------------------
   * No prescription, so no allergy check is possible unless a patient is named
   * — and often none is, because somebody buying paracetamol is not under the
   * hospital's care. That absence is stated in the response rather than left
   * implied: a screen showing no warnings looks identical whether it checked
   * and found nothing or never checked at all, and only one of those is safe to
   * trust. `hasUncataloguedItem` and the dispensing queue's allergy dot rest on
   * the same distinction.
   *
   * Where a patient *is* named, their allergies are checked and returned as
   * warnings. They do not block. An over-the-counter sale is a person choosing
   * to buy something, and refusing it against a record they cannot see would be
   * the software overruling them with no way to argue — different from
   * dispensing, where a prescriber has already made the decision and the
   * pharmacist is the second check on it.
   */
  async counterSale(dto: CounterSaleDto, user: AuthUser) {
    /*
     * A referral being filled. Checked before anything moves, so a stale
     * screen cannot dispense the same one twice.
     */
    let referral: { id: number; reference: string; patientName: string } | null = null;
    if (dto.referralId !== undefined) {
      const row = await this.prisma.prescriptionReferral.findUnique({
        where: { id: dto.referralId },
        select: { id: true, reference: true, patientName: true, dispensedAt: true, declinedAt: true },
      });
      if (!row) throw new NotFoundException(`Referral ${dto.referralId} not found`);
      if (row.dispensedAt) throw new ConflictException('That referral has already been dispensed');
      if (row.declinedAt) throw new ConflictException('That referral was declined');
      referral = { id: row.id, reference: row.reference, patientName: row.patientName };
    }

    const medicineIds = [...new Set(dto.lines.map((l) => l.medicineId))];
    const medicines = await this.prisma.medicine.findMany({
      where: { id: { in: medicineIds }, isActive: true },
      select: {
        id: true,
        name: true,
        form: true,
        strength: true,
        sellingPrice: true,
        drugClass: true,
        taxRateId: true,
      },
    });
    const byId = new Map(medicines.map((m) => [m.id, m]));

    const missing = medicineIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`Medicine ${missing.join(', ')} is not in the catalogue`);
    }

    const now = new Date();
    const planned: { medicineId: number; batchId: number; quantity: number }[] = [];

    // Allocate everything before writing anything, exactly as `dispense` does:
    // if one line cannot be filled, no stock should have moved.
    for (const line of dto.lines) {
      const batches = await this.prisma.stockBatch.findMany({
        where: { medicineId: line.medicineId, quantity: { gt: 0 } },
        orderBy: { expiresAt: 'asc' },
      });

      try {
        for (const a of allocateFefo(
          batches.map((b) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            expiresAt: b.expiresAt,
            quantity: b.quantity,
          })),
          line.quantity,
          now,
        )) {
          planned.push({ medicineId: line.medicineId, batchId: a.batchId, quantity: a.quantity });
        }
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          throw new ConflictException(
            `Not enough in-date stock for ${byId.get(line.medicineId)!.name}: ${err.available} available, ${line.quantity} requested`,
          );
        }
        throw err;
      }
    }

    const tax = await this.taxContext();
    const saleLines: SaleLine[] = planned.map((p) => {
      const m = byId.get(p.medicineId)!;
      return {
        medicineId: m.id,
        medicineName: m.name,
        form: m.form,
        strength: m.strength,
        quantity: p.quantity,
        priceUnits: sellingPriceUnits(m.sellingPrice),
        taxRateBasisPoints: tax.rateFor(m.taxRateId).basisPoints,
        taxRateName: tax.rateFor(m.taxRateId).name,
        taxComponents: tax.rateFor(m.taxRateId).components,
      };
    });
    const priced = priceLines(saleLines, tax.basis);
    const priceByMedicine = new Map(saleLines.map((l) => [l.medicineId, l.priceUnits]));

    /*
     * Always its own PHARMACY invoice, even in COMBINED mode.
     *
     * COMBINED means "put this patient's medicines on their hospital bill", and
     * a walk-in has no hospital bill to put anything on. Appending where a
     * patient *is* named would be possible and would be wrong: they came to a
     * counter and are paying at that counter, and folding the sale into an open
     * consultation invoice makes them pay twice or not at all, depending on
     * which screen somebody happens to look at.
     */
    const target = { appendToInvoiceId: null, kind: InvoiceKind.PHARMACY };

    const allergyWarnings =
      dto.patientId != null ? await this.counterAllergyCheck(dto.patientId, medicines) : [];

    const eventId = await this.prisma.$transaction(async (tx) => {
      const invoiceId = await this.chargeSale(tx, {
        target,
        patientId: dto.patientId ?? null,
        totalMinor: priced.totalMinor,
        items: priced.items,
      });

      const event = await tx.dispenseEvent.create({
        data: {
          tenantId: currentTenantId(),
          prescriptionId: null,
          patientId: dto.patientId ?? null,
          invoiceId,
          referralId: referral?.id ?? null,
          pharmacistId: user.userId,
          notes: [
            referral ? `REFERRAL ${referral.reference}` : 'COUNTER SALE',
            referral ? `for ${referral.patientName}` : null,
            dto.buyerName?.trim() ? `for ${dto.buyerName.trim()}` : null,
            dto.notes?.trim() || null,
          ]
            .filter(Boolean)
            .join(' — '),
        },
      });

      for (const p of planned) {
        const updated = await tx.stockBatch.updateMany({
          where: { id: p.batchId, quantity: { gte: p.quantity } },
          data: { quantity: { decrement: p.quantity } },
        });
        if (updated.count === 0) {
          throw new ConflictException(
            'Stock changed while this sale was being recorded. Reload and try again.',
          );
        }

        const values = batchLineValues(priceByMedicine.get(p.medicineId) ?? null, p.quantity);
        await tx.dispenseLine.create({
          data: {
            tenantId: currentTenantId(),
            eventId: event.id,
            prescriptionItemId: null,
            medicineId: p.medicineId,
            batchId: p.batchId,
            quantity: p.quantity,
            unitPrice: values.unitPrice,
            lineTotal: values.lineTotal,
          },
        });
      }

      if (referral) {
        // Closed inside the same transaction as the stock movement, so a
        // referral can never read as dispensed with nothing having left the
        // shelf, or the reverse.
        await tx.prescriptionReferral.update({
          where: { id: referral.id },
          data: { dispensedAt: new Date(), dispenseEventId: event.id },
        });
      }

      return event.id;
    });

    const event = await this.dispenseEvent(eventId);
    return {
      ...event,
      charge: {
        invoiceId: event?.invoiceId ?? null,
        total: fromMinor(priced.totalMinor),
        unpriced: priced.unpriced,
      },
      /**
       * See the note above: "not checked" is not "nothing found".
       *
       * A referral is always false here even when a patient is named locally,
       * because the sending hospital does not transmit allergies and this
       * pharmacy has nothing of its own to check against.
       */
      allergyChecked: referral === null && dto.patientId != null,
      allergyWarnings,
      referral: referral ? { id: referral.id, reference: referral.reference } : null,
    };
  }

  /** Allergy conflicts for a named buyer. Advisory only — see `counterSale`. */
  private async counterAllergyCheck(
    patientId: number,
    medicines: { name: string; drugClass: DrugClass }[],
  ) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { allergies: { select: { substance: true, severity: true } } },
    });
    if (!patient) throw new NotFoundException(`Patient ${patientId} not found`);

    const { conflicts } = checkAllergies(
      medicines.map((m) => ({
        medicineName: m.name,
        drugClass: m.drugClass,
        catalogueName: m.name,
      })),
      patient.allergies.map((a) => ({ substance: a.substance, severity: a.severity })),
    );
    return conflicts;
  }
}
