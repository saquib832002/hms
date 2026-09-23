import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, InvoiceKind, InvoiceStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import {
  applyPayment,
  applyRefund,
  fromMinor,
  MoneyError,
  sumAmounts,
  toMinor,
  toMoneyString,
} from './money';
import { apportionTax, formatRate, taxLine } from './tax';
import { buildAgingReport, bucketFor, daysOverdue } from './aging';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';
import { RefundDto } from './dto/refund.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';
import {
  AGEABLE_INVOICE_KINDS,
  shapeInvoiceItems,
  visibleInvoiceKinds,
} from './invoice-response';
import { accessionsIn } from '../lab/lab-charge';

@Injectable()
export class BillingService {
  constructor(private prisma: PrismaService) {}

  /**
   * Raise the invoice for a finished consultation.
   *
   * WHERE THE FLOW WAS BROKEN
   * -------------------------
   * Nothing connected treatment to money. A doctor marked a consultation
   * complete and the patient walked out; billing only ever existed if somebody
   * remembered to walk over and type an amount from memory. There was not even
   * a field recording what a doctor charges.
   *
   * WHEN, AND WHY IT MOVED
   * ----------------------
   * At **check-in**, before the consultation — not after it.
   *
   * The first version required COMPLETED, on the assumption that treatment
   * comes first and billing follows. That is the insurance-led model. Most
   * outpatient clinics, and every clinic this product is aimed at, work the
   * other way: the patient arrives, pays at the desk, and then waits to be
   * seen. Billing after the fact means chasing someone who has already walked
   * out of the building.
   *
   * So an invoice can be raised from CHECKED_IN onwards. Not from SCHEDULED —
   * a patient who has not arrived may never arrive, and an invoice raised
   * against them is a debt for a visit that did not happen.
   *
   * Still a deliberate tap rather than automatic on check-in. Free follow-ups,
   * staff patients and written-off visits are ordinary, and each one
   * auto-invoiced would need voiding. An audit trail full of corrections is
   * worse than one tap by the person the patient is standing in front of.
   *
   * PAYING IS NOT A PRECONDITION, AND MUST NOT BECOME ONE
   * -----------------------------------------------------
   * Nothing in the clinical path checks whether an invoice exists or is
   * settled. A doctor can start and complete a consultation for a patient who
   * has not paid, and the charge can be raised or collected afterwards — which
   * is why COMPLETED stays billable.
   *
   * This is a safety position, not an oversight. A gate on payment reads as
   * tidy and fails at the only moment it matters: the patient who deteriorated
   * in the waiting room, the one whose payment failed, the one the clinic has
   * decided to treat for nothing. Software refusing care over an unpaid balance
   * is a decision no system should make on a clinic's behalf.
   *
   * `consultation-billing.spec.ts` asserts the absence of such a gate, because
   * adding one looks like an improvement to anyone who has not thought it
   * through.
   *
   * THE LINE DESCRIPTION CARRIES NO CLINICAL FACT
   * ---------------------------------------------
   * `CONS · Consultation`. Not the diagnosis, not the prescription, and
   * deliberately **not the doctor's name either**: in a hospital with an
   * oncology department, "Consultation — Dr Chen" tells billing which
   * department the patient attended, and that is a clinical fact reaching a
   * role that `toPatientResponse` withholds it from. The `appointmentId` link
   * carries the detail for anyone actually authorised to see it.
   *
   * This is the rule CLAUDE.md states: if auto-generation is ever added, the
   * description must be a tariff code.
   */
  async invoiceForAppointment(appointmentId: number) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        status: true,
        patientId: true,
        scheduledAt: true,
        doctor: { select: { fullName: true, consultationFee: true } },
        invoice: { select: { id: true } },
      },
    });

    if (!appointment) throw new NotFoundException(`Appointment ${appointmentId} not found`);

    /*
     * Billable from arrival onwards.
     *
     * CANCELLED and NO_SHOW are excluded because both mean the visit did not
     * happen — invoicing either is revenue invented from an empty chair.
     * SCHEDULED is excluded because the patient has not turned up yet.
     */
    const BILLABLE: AppointmentStatus[] = [
      AppointmentStatus.CHECKED_IN,
      AppointmentStatus.IN_PROGRESS,
      AppointmentStatus.COMPLETED,
    ];

    if (!BILLABLE.includes(appointment.status)) {
      throw new ConflictException(
        appointment.status === AppointmentStatus.SCHEDULED
          ? 'Check the patient in first — an invoice for someone who has not arrived is a debt for a visit that may not happen.'
          : `This appointment is ${appointment.status.toLowerCase().replace('_', ' ')} and cannot be billed.`,
      );
    }

    // Checked for the message; the unique index on Invoice.appointmentId is
    // what actually guarantees it, including against two taps at once.
    if (appointment.invoice) {
      throw new ConflictException('This consultation has already been invoiced');
    }

    const fee = appointment.doctor?.consultationFee;
    if (fee === null || fee === undefined) {
      throw new ConflictException(
        `No consultation fee is set for Dr ${appointment.doctor?.fullName ?? 'this doctor'}. ` +
          'An administrator can set one on the doctor’s profile.',
      );
    }

    const amount = toMoneyString(fee);
    if (toMinor(amount) <= 0) {
      throw new ConflictException('That doctor’s consultation fee is zero — nothing to invoice');
    }

    /*
     * Tax on the consultation, from its OWN rate.
     *
     * Deliberately not the medicine default. In India healthcare services are
     * largely exempt while the medicines dispensed at the same visit are not,
     * so one rate covering both would be wrong for one of them — and which one
     * would depend on which the hospital happened to configure first.
     *
     * A hospital with tax switched off, or with no consultation rate set, gets
     * zero and an invoice identical to the one it got before tax existed.
     */
    const tenant = await this.prisma.tenant.findUnique({
      // Scoped client: `tenants` has no policy, and a second pool connection
      // inside the request's transaction is what deadlocked the app.
      where: { id: currentTenantId() },
      select: { taxEnabled: true, pricesIncludeTax: true, consultationTaxRateId: true },
    });

    /*
     * Which taxes apply to a consultation.
     *
     * Naming one on Clinic Settings applies exactly that rate. Naming none
     * applies EVERY active rate — the same rule medicines follow, so a
     * hospital that entered CGST and SGST as two rows gets both, on both.
     *
     * This was the bug: the setting was read as "the one rate", so two rates
     * meant one applied and the other silently did not. Half the tax collected,
     * on an invoice that looked entirely plausible.
     *
     * To leave consultations untaxed — which is the ordinary answer in India,
     * where healthcare services are largely exempt — point them at a 0% rate
     * named "Exempt". That is why rates carry names: exempt and zero-rated are
     * different on a statutory invoice and identical to the arithmetic.
     */
    const activeRates = tenant?.taxEnabled
      ? await this.prisma.taxRate.findMany({
          where: {
            isActive: true,
            ...(tenant.consultationTaxRateId ? { id: tenant.consultationTaxRateId } : {}),
          },
          orderBy: { rateBasisPoints: 'desc' },
          select: {
            name: true,
            rateBasisPoints: true,
            components: {
              orderBy: { position: 'asc' },
              select: { name: true, rateBasisPoints: true },
            },
          },
        })
      : [];

    /*
     * Added, never compounded — every rate is charged on the same fee. Each
     * contributes its own parts where it has them, so the invoice prints one
     * line per named tax whichever shape the hospital used.
     */
    const combinedBasisPoints = activeRates.reduce((sum, r) => sum + r.rateBasisPoints, 0);
    const components = activeRates.flatMap((r) =>
      r.components.length > 0
        ? r.components
        : [{ name: r.name, rateBasisPoints: r.rateBasisPoints }],
    );
    const rate = activeRates.length === 1 ? activeRates[0] : null;

    const taxed = taxLine(
      toMinor(amount),
      combinedBasisPoints,
      tenant?.pricesIncludeTax ? 'INCLUSIVE' : 'EXCLUSIVE',
    );

    try {
      const invoice = await this.prisma.invoice.create({
        data: {
          tenantId: currentTenantId(),
          patientId: appointment.patientId,
          appointmentId: appointment.id,
          // What the patient pays. Equal to `amount` when no tax applies, which
          // is every hospital that has not switched tax on.
          totalAmount: fromMinor(taxed.grossMinor),
          items: {
            create: [
              {
                tenantId: currentTenantId(),
                description: 'CONS · Consultation',
                // NET. `taxAmount` completes it, and the two always sum to the
                // invoice total — see `tax.ts` for why that is by subtraction.
                amount: fromMinor(taxed.netMinor),
                taxAmount: fromMinor(taxed.taxMinor),
                taxRateBasisPoints: taxed.rateBasisPoints,
                /*
                 * The rate's NAME, captured like `medicineName` on a
                 * prescription. An invoice must stay readable after the rate
                 * it used has been renamed or retired — and "GST 12%" on a
                 * bill is not a clinical fact, so it crosses to billing
                 * staff without touching the minimum-necessary rule.
                 */
                taxRateName: rate?.name ?? null,
                /*
                 * The split, apportioned from this line's tax so the parts sum
                 * to it exactly. Null for a flat rate. An Indian statutory
                 * invoice is invalid without CGST and SGST shown separately,
                 * and it must still print correctly next year after the rate
                 * has been restructured — hence captured, not resolved.
                 */
                taxBreakdown:
                  components.length === 0
                    ? undefined
                    : apportionTax(taxed.taxMinor, components).map((c) => ({
                        name: c.name,
                        rateBasisPoints: c.rateBasisPoints,
                        amount: fromMinor(c.amountMinor),
                      })),
              },
            ],
          },
        },
        include: this.detailInclude(),
      });
      return this.shape(invoice);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('This consultation has already been invoiced');
      }
      throw err;
    }
  }

  /**
   * Create an invoice from line items.
   *
   * WHY LINES ARE TYPED BY HAND AND NOT PULLED FROM CLINICAL DATA
   * ------------------------------------------------------------
   * The obvious feature is "generate the invoice from what was dispensed".
   * Don't. An itemised line reading "Amoxicillin 500mg × 21" hands billing
   * staff a medication history — which is precisely the clinical data every
   * other part of this system keeps away from them. Auto-generation would route
   * PHI to billing through the back door, past the response shaping that exists
   * to prevent exactly that.
   *
   * If auto-generation is added later, the description must be a service or
   * tariff code, not a drug name.
   */
  async createInvoice(dto: CreateInvoiceDto) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: dto.patientId },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException(`Patient ${dto.patientId} not found`);

    // The total is derived from the lines, never accepted from the client — a
    // total that disagrees with its own lines is an invoice nobody can defend.
    let total: string;
    try {
      total = sumAmounts(dto.items.map((i) => i.amount));
    } catch (err) {
      throw new BadRequestException(err instanceof MoneyError ? err.message : 'Invalid amount');
    }

    if (toMinor(total) <= 0) {
      throw new BadRequestException('An invoice must total more than zero');
    }

    const invoice = await this.prisma.invoice.create({
      data: {
        tenantId: currentTenantId(),
        patientId: dto.patientId,
        totalAmount: total,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        notes: dto.notes,
        items: {
          // Nested creates are not top-level `data`, so the write proxy does not
          // reach them. Named explicitly, and the compiler insists.
          create: dto.items.map((i) => ({
            tenantId: currentTenantId(),
            description: i.description,
            amount: toMoneyString(i.amount),
          })),
        },
      },
      include: this.detailInclude(),
    });

    return this.shape(invoice);
  }

  /**
   * The invoice list, scoped to what this role's business is.
   *
   * `visibleInvoiceKinds` is what keeps a separately-billing pharmacy's sales
   * out of the hospital's debtor list. A pharmacist asking for invoices gets
   * the pharmacy's; billing staff get the hospital's; an admin owns both.
   *
   * This is scoping, not security — `RolesGuard` and `@Roles` are what refuse a
   * caller outright. What it prevents is subtler and would never look like a
   * bug: an aging report chasing a shop's counter takings as overdue patient
   * debt, and a "collected today" that silently merges two businesses.
   */
  async findAll(
    query: {
      status?: InvoiceStatus;
      patientId?: number;
      overdueOnly?: boolean;
      /**
       * `institution` narrows to invoices owed by another organisation rather
       * than by a patient — referred laboratory work, billed to the hospital
       * that sent it.
       *
       * A laboratory doing send-out work has two ledgers with very different
       * shapes: patients who pay at the counter today, and hospitals invoiced
       * monthly. Mixed into one list, the second is a handful of "no patient"
       * rows scattered among the first, and "what do referring hospitals owe
       * us" cannot be answered at all — reported exactly that way.
       *
       * Keyed on `patientId: null`, which is what an institutional invoice is.
       * The only other row shaped that way is a pharmacy walk-in, and that
       * lives in a different `kind` the lab never sees.
       */
      payer?: 'patient' | 'institution';
    },
    role?: UserRole | null,
  ) {
    const where: Prisma.InvoiceWhereInput = {
      kind: { in: visibleInvoiceKinds(role) },
      ...(query.status ? { status: query.status } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...(query.payer === 'institution'
        ? { patientId: null }
        : query.payer === 'patient'
          ? { patientId: { not: null } }
          : {}),
    };

    const invoices = await this.prisma.invoice.findMany({
      where,
      orderBy: { issuedAt: 'desc' },
      take: 200,
      include: this.detailInclude(),
    });

    const shaped = invoices.map((i) => this.shape(i, role));
    return {
      data: query.overdueOnly ? shaped.filter((i) => i.daysOverdue > 0 && !i.settled) : shaped,
    };
  }

  async findOne(id: number, role?: UserRole | null) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`);

    /*
     * A 404 rather than a 403, and that is the considered choice.
     *
     * Telling a pharmacist "invoice 812 exists but is not yours" leaks that it
     * exists, and invoice ids are sequential — walking them would map the
     * hospital's billing volume from the pharmacy counter. The same argument
     * the patient lookup already makes.
     */
    if (!visibleInvoiceKinds(role).includes(invoice.kind)) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }

    return this.shape(invoice, role);
  }

  /**
   * Record a payment.
   *
   * One transaction: insert the payment, increment the running total, recompute
   * the status. Splitting these would let money be received with the invoice
   * still reading PENDING, or a status say PAID with no payment behind it.
   */
  async recordPayment(invoiceId: number, dto: RecordPaymentDto, user: AuthUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        kind: true,
        totalAmount: true,
        amountPaid: true,
        status: true,
        voidedAt: true,
      },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found`);

    /*
     * A pharmacist cannot take a payment against a hospital invoice, and
     * billing cannot take one against a pharmacy sale.
     *
     * `@Roles` cannot answer this — both callers are legitimately allowed to
     * record payments, just not against each other's books. This is the
     * resource layer, and it is the layer a guard structurally cannot reach.
     */
    if (!visibleInvoiceKinds(user.role).includes(invoice.kind)) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }

    if (invoice.voidedAt || invoice.status === InvoiceStatus.CANCELLED) {
      throw new ConflictException('That invoice has been voided and cannot take a payment');
    }

    const totalMinor = toMinor(toMoneyString(invoice.totalAmount));
    const paidMinor = toMinor(toMoneyString(invoice.amountPaid));

    let outcome;
    try {
      outcome = applyPayment(totalMinor, paidMinor, toMinor(dto.amount));
    } catch (err) {
      // Overpayment and paying a settled invoice both land here. The message
      // states the arithmetic, which is more useful than "bad request".
      if (err instanceof MoneyError) throw new ConflictException(err.message);
      throw err;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          tenantId: currentTenantId(),
          invoiceId,
          amount: toMoneyString(dto.amount),
          method: dto.method,
          reference: dto.reference,
          notes: dto.notes,
          receivedById: user.userId,
          receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : new Date(),
        },
      });

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          amountPaid: fromMinor(outcome.paidMinor),
          status: outcome.fullySettled ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID,
        },
      });
    });

    return this.findOne(invoiceId, user.role);
  }

  /**
   * Give money back.
   *
   * WHY THIS IS NOT A NEGATIVE PAYMENT
   * ----------------------------------
   * Every takings figure in the system sums `Payment` rows. A refund written as
   * a negative payment would quietly reduce "collected today" with nothing on
   * screen saying it had happened, and the day would stop reconciling against
   * the bank. Gross in, gross out, net derived — see `financeReport`.
   *
   * WHAT IT DOES TO THE INVOICE
   * ---------------------------
   * `amountPaid` is what the invoice currently *holds*, so a refund reduces it
   * and the outstanding balance goes back up. That is the honest reading: the
   * charge still stands and the money is no longer here. An invoice refunded to
   * zero returns to PENDING rather than being cancelled — voiding it is a
   * separate decision, and it becomes possible precisely because nothing is
   * held any more.
   */
  async refund(invoiceId: number, dto: RefundDto, user: AuthUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        kind: true,
        totalAmount: true,
        amountPaid: true,
        creditedAmount: true,
        status: true,
        voidedAt: true,
      },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found`);

    // Same books-are-separate check as `recordPayment`. Refunding out of
    // somebody else's till is the version of this that costs real money.
    if (!visibleInvoiceKinds(user.role).includes(invoice.kind)) {
      throw new NotFoundException(`Invoice ${invoiceId} not found`);
    }

    if (invoice.voidedAt) {
      // A voided invoice holds nothing by construction — it cannot have taken a
      // payment. Reaching here means the data disagrees with itself.
      throw new ConflictException('That invoice has been voided');
    }

    /*
     * A named payment must belong to this invoice.
     *
     * Without the check, a paymentId from another invoice would be accepted and
     * stored, and the refund would appear against a payment it did not reverse
     * — in a table whose whole purpose is explaining where money went.
     */
    if (dto.paymentId !== undefined) {
      const payment = await this.prisma.payment.findFirst({
        where: { id: dto.paymentId, invoiceId },
        select: { id: true },
      });
      if (!payment) {
        throw new ConflictException(
          `Payment ${dto.paymentId} is not against invoice ${invoiceId}`,
        );
      }
    }

    const totalMinor = toMinor(toMoneyString(invoice.totalAmount));
    const paidMinor = toMinor(toMoneyString(invoice.amountPaid));

    let outcome;
    try {
      outcome = applyRefund(totalMinor, paidMinor, toMinor(dto.amount));
    } catch (err) {
      // "Nothing held" and "more than is held" both land here, and both
      // messages state the arithmetic — more useful than "bad request".
      if (err instanceof MoneyError) throw new ConflictException(err.message);
      throw err;
    }

    /*
     * The credit, and the loop it closes.
     *
     * Without it a refund leaves the charge standing, the balance reappears in
     * "outstanding", and the invoice can be paid and refunded indefinitely with
     * no state that terminates. Crediting the same amount says the charge was
     * wrong as well as the money returned.
     *
     * Capped at what is still chargeable, so repeated partial refunds cannot
     * credit more than was ever billed.
     */
    const creditedMinor = toMinor(toMoneyString(invoice.creditedAmount));
    const chargeableMinor = totalMinor - creditedMinor;
    const credit =
      dto.cancelCharge === false ? 0 : Math.min(toMinor(dto.amount), Math.max(chargeableMinor, 0));

    const nextCreditedMinor = creditedMinor + credit;
    const owedMinor = totalMinor - nextCreditedMinor - outcome.paidMinor;

    await this.prisma.$transaction(async (tx) => {
      await tx.refund.create({
        data: {
          tenantId: currentTenantId(),
          invoiceId,
          paymentId: dto.paymentId,
          amount: toMoneyString(dto.amount),
          method: dto.method,
          reason: dto.reason,
          refundedById: user.userId,
        },
      });

      /*
       * An invoice with nothing left to charge and nothing held is finished,
       * and it is voided rather than left sitting in a list. This is the exit
       * the loop was missing: it leaves both the outstanding and the paid
       * views, and the row survives with the refund reason on it — a charge
       * that was raised, reversed, and cancelled, all still readable.
       */
      const finished = nextCreditedMinor >= totalMinor && outcome.paidMinor === 0;

      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          amountPaid: fromMinor(outcome.paidMinor),
          creditedAmount: fromMinor(nextCreditedMinor),
          status: finished
            ? InvoiceStatus.CANCELLED
            : owedMinor <= 0
              ? InvoiceStatus.PAID
              : outcome.paidMinor === 0
                ? InvoiceStatus.PENDING
                : InvoiceStatus.PARTIALLY_PAID,
          ...(finished
            ? {
                voidedAt: new Date(),
                voidReason: `Refunded and cancelled: ${dto.reason}`,
              }
            : {}),
        },
      });
    });

    return this.findOne(invoiceId, user.role);
  }

  /**
   * Void an invoice.
   *
   * Never a delete. A gap in the invoice numbering is indistinguishable from a
   * cover-up, and the audit trail references a row that has to still exist.
   *
   * An invoice still HOLDING money cannot be voided — pretending the charge
   * never existed would leave a real payment attached to nothing. Refund it
   * first; once nothing is held, voiding is available and both facts survive in
   * the trail.
   */
  async voidInvoice(id: number, dto: VoidInvoiceDto) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: { id: true, amountPaid: true, voidedAt: true, _count: undefined },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`);
    if (invoice.voidedAt) throw new ConflictException('That invoice is already voided');

    /*
     * Keyed on what is HELD, not on whether payments exist.
     *
     * This used to count payment rows, which meant a fully refunded invoice
     * could never be voided — the money was back with the patient and the
     * charge was still standing, with no way to withdraw it. The question that
     * matters is whether voiding would orphan money, and after a full refund
     * it would not.
     */
    if (toMinor(toMoneyString(invoice.amountPaid)) > 0) {
      throw new ConflictException(
        'That invoice is holding money that was actually received. Refund it first — voiding it now would orphan the payment.',
      );
    }

    await this.prisma.invoice.update({
      where: { id },
      data: {
        status: InvoiceStatus.CANCELLED,
        voidedAt: new Date(),
        voidReason: dto.reason,
      },
    });

    return this.findOne(id);
  }

  /** How much is owed, and for how long. */
  async aging() {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        /*
         * Hospital and laboratory charges, never the pharmacy's counter.
         *
         * This filter did not exist, so every unsettled walk-in sale has been
         * sitting in the 90-day bucket as a patient debt — while CLAUDE.md said
         * in as many words that aging counted hospital invoices only. The rule
         * was right and nothing implemented it; see `AGEABLE_INVOICE_KINDS`.
         */
        kind: { in: AGEABLE_INVOICE_KINDS },
        voidedAt: null,
        status: { notIn: [InvoiceStatus.PAID, InvoiceStatus.CANCELLED] },
      },
      select: { id: true, dueDate: true, totalAmount: true, amountPaid: true },
    });

    return buildAgingReport(
      invoices.map((i) => ({
        id: i.id,
        dueDate: i.dueDate as Date | null,
        outstandingMinor:
          toMinor(toMoneyString(i.totalAmount)) - toMinor(toMoneyString(i.amountPaid)),
      })),
    );
  }

  /**
   * Every movement of money, in and out, newest first.
   *
   * WHY REFUNDS ARE IN HERE
   * ----------------------
   * This list used to be payments only, which made a refund invisible in the
   * one place somebody goes to ask "what happened to that money". A refund *is*
   * a transaction — its own row, with its own timestamp, its own operator, and
   * a reference to the payment it reverses — and a ledger that omits half the
   * movements is not a ledger.
   *
   * They are separate rows rather than an adjusted payment, for the same reason
   * the `Refund` model exists at all: an invoice that took 120 and gave 120
   * back is not the same as one never paid, and netting them into a single
   * figure destroys the difference.
   *
   * `signedAmount` is negative for a refund and is computed here rather than in
   * each client, so nothing has to remember which direction a row points — and
   * so two screens cannot disagree about what a day was worth.
   */
  async payments(limit = 50) {
    const take = Math.min(limit, 200);

    const [payments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        orderBy: { receivedAt: 'desc' },
        take,
        include: {
          receivedBy: { select: { id: true, fullName: true } },
          invoice: { select: { id: true, patient: { select: { id: true, fullName: true } } } },
        },
      }),
      this.prisma.refund.findMany({
        orderBy: { refundedAt: 'desc' },
        take,
        include: {
          refundedBy: { select: { id: true, fullName: true } },
          invoice: { select: { id: true, patient: { select: { id: true, fullName: true } } } },
        },
      }),
    ]);

    /*
     * How much of each payment has already been handed back.
     *
     * Sent so a client never has to work it out — and so it cannot offer to
     * refund a payment that is already fully reversed, which is exactly what
     * the phone was doing. The server would have refused the second attempt,
     * but a button that exists in order to fail is a bug in its own right.
     *
     * Only refunds that *named* a payment count. A refund raised against the
     * invoice as a whole carries no `paymentId` — there is nothing to attribute
     * it to, and guessing which payment it reversed would be inventing a fact.
     * Those still reduce what the invoice holds, and the server enforces that
     * ceiling regardless.
     */
    const refundedByPayment = new Map<number, number>();
    for (const r of refunds) {
      if (r.paymentId === null) continue;
      refundedByPayment.set(
        r.paymentId,
        (refundedByPayment.get(r.paymentId) ?? 0) + toMinor(toMoneyString(r.amount)),
      );
    }

    const rows = [
      ...payments.map((p) => {
        const paidMinor = toMinor(toMoneyString(p.amount));
        const backMinor = refundedByPayment.get(p.id) ?? 0;
        return {
          id: p.id,
          kind: 'PAYMENT' as const,
          amount: toMoneyString(p.amount),
          signedAmount: toMoneyString(p.amount),
          method: p.method,
          reference: p.reference,
          notes: p.notes,
          receivedAt: p.receivedAt,
          receivedBy: p.receivedBy?.fullName ?? null,
          invoiceId: p.invoiceId,
          patient: p.invoice?.patient ?? null,
          reversesPaymentId: null,
          reason: null,
          /** Refunds explicitly raised against this payment. */
          refundedAmount: fromMinor(backMinor),
          /** Nothing of this payment is left to give back. */
          fullyRefunded: backMinor >= paidMinor,
        };
      }),
      ...refunds.map((r) => ({
        id: r.id,
        kind: 'REFUND' as const,
        amount: toMoneyString(r.amount),
        // Negative, because that is the direction the money went.
        signedAmount: fromMinor(-toMinor(toMoneyString(r.amount))),
        method: r.method,
        reference: null,
        notes: null,
        receivedAt: r.refundedAt,
        receivedBy: r.refundedBy?.fullName ?? null,
        invoiceId: r.invoiceId,
        patient: r.invoice?.patient ?? null,
        /** The payment this reverses, where one was identified at the time. */
        reversesPaymentId: r.paymentId,
        reason: r.reason,
        // Meaningless on a refund row, but the shape has to be uniform or the
        // clients need two types for one list.
        refundedAmount: '0.00',
        fullyRefunded: false,
      })),
    ];

    /*
     * Merged and re-sorted, then trimmed.
     *
     * Both queries take `limit` and the merge takes `limit` from the result, so
     * a day of heavy refunding cannot push payments off the page or the
     * reverse — each side is fully represented before the cut.
     */
    rows.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

    return { data: rows.slice(0, take) };
  }

  /**
   * Every currency field leaves as a string, and the derived figures are
   * computed here rather than in the client — two clients doing their own
   * subtraction is two chances to disagree about what a patient owes.
   */
  private shape(invoice: Record<string, unknown>, role?: UserRole | null) {
    const totalMinor = toMinor(toMoneyString(invoice.totalAmount));
    const paidMinor = toMinor(toMoneyString(invoice.amountPaid));
    /*
     * What is owed is the charge minus what has been cancelled minus what is
     * held — not `total - paid`.
     *
     * That older arithmetic is what made a refund reopen a balance the clinic
     * was not actually chasing: the money went back, the charge stayed, and the
     * invoice reappeared as though the patient still owed it.
     *
     * `totalAmount` is never rewritten. An invoice that quietly changes what it
     * says it charged is not a record, so the reduction lives beside it.
     */
    const creditedMinor = toMinor(toMoneyString(invoice.creditedAmount));
    const chargeableMinor = totalMinor - creditedMinor;
    const outstandingMinor = chargeableMinor - paidMinor;
    const dueDate = (invoice.dueDate as Date | null) ?? null;

    return {
      id: invoice.id as number,
      patient: invoice.patient as { id: number; fullName: string } | null,
      /*
       * Who owes it, when that is not a patient.
       *
       * A lab invoice for referred work is billed to the hospital that sent
       * the work — the patient may never learn this lab was involved. Without
       * this the till renders "No patient" against every such row, which reads
       * as data missing rather than as a debt belonging to a company.
       *
       * `notes` is the only free-text field on an invoice and holds
       * "Referred by …", written at accession.
       */
      payer: (invoice.notes as string | null) ?? null,

      /**
       * The laboratory order numbers this invoice charges for.
       *
       * WHY ON THE INVOICE AND NOT ONLY ON ITS LINES
       * --------------------------------------------
       * The accession already travels in each line's description, and the
       * lines are one click *inside* an invoice. So a till showing forty rows
       * gave no way to tell which order any of them was for without opening
       * each one — reported as *"the lab invoice does not have any reference
       * on the doctor's test order number… difficult to track"*.
       *
       * Derived rather than stored, by the same exact pattern the descriptions
       * were written with. A column would be a migration that leaves every
       * historical invoice holding a value it never had, and would then need
       * keeping in step with the lines it duplicates.
       *
       * Safe for every role that can see the invoice at all: an accession is
       * an opaque key naming no analyte, no discipline and no patient, which
       * is exactly why the collapsed line may carry it while a test name may
       * not.
       */
      labAccessions: accessionsIn(
        ((invoice.items as { description?: string }[] | undefined) ?? []).map(
          (i) => i.description ?? '',
        ),
      ),

      issuedAt: invoice.issuedAt as Date,
      dueDate,
      status: invoice.status as InvoiceStatus,
      notes: (invoice.notes as string | null) ?? null,
      voidedAt: (invoice.voidedAt as Date | null) ?? null,
      voidReason: (invoice.voidReason as string | null) ?? null,

      totalAmount: fromMinor(totalMinor),
      /** Cancelled by credit. Zero on almost every invoice. */
      creditedAmount: fromMinor(creditedMinor),
      /** What is actually chargeable now — total less any credit. */
      chargeable: fromMinor(chargeableMinor),
      amountPaid: fromMinor(paidMinor),
      outstanding: fromMinor(outstandingMinor),
      settled: outstandingMinor <= 0,

      daysOverdue: outstandingMinor > 0 ? daysOverdue(dueDate) : 0,
      agingBucket: outstandingMinor > 0 ? bucketFor(dueDate) : 'current',

      /**
       * Which invoice this is — the hospital's or the pharmacy's. Sent so a
       * client can label a mixed list without inferring it from the lines,
       * which is exactly the inference the collapse is meant to prevent.
       */
      kind: (invoice.kind as InvoiceKind) ?? InvoiceKind.HOSPITAL,

      /*
       * Role-shaped. Billing staff get medicine lines rolled into one total;
       * the pharmacist who sold them, and the admin who owns both sets of
       * books, get the itemisation. See `invoice-response.ts` for why this is
       * the response's job and not the query's.
       */
      items: shapeInvoiceItems(
        ((invoice.items as Record<string, unknown>[]) ?? []).map((i) => ({
          id: i.id as number,
          description: i.description as string,
          amount: i.amount,
          kind: i.kind as never,
          quantity: i.quantity as number | null,
          unitPrice: i.unitPrice,
          medicineId: i.medicineId as number | null,
          taxAmount: i.taxAmount,
          taxRateBasisPoints: i.taxRateBasisPoints as number | null,
          taxRateName: i.taxRateName as string | null,
          taxBreakdown: i.taxBreakdown,
        })),
        role,
      ),

      /*
       * Invoice-level tax, summed from the lines that are actually shown.
       *
       * Not recomputed from the total: with two rates in one basket, tax on
       * the sum is a different number from the sum of the line taxes, and it
       * is the one that cannot be reconciled against what is printed. Zero for
       * every hospital that charges no tax, so the clients can simply omit the
       * row rather than print "Tax 0.00" on every bill.
       */
      /*
       * Tax rows for the bill, one per named component.
       *
       * An Indian statutory invoice shows CGST and SGST as separate lines with
       * their percentages, not a combined "GST 12.00" — and a US receipt has to
       * show state, county and city for the same reason. So the summary is
       * built from what each line captured: its `taxBreakdown` where the rate
       * was split, and its own rate name where it was flat.
       *
       * Aggregated by (name, rate) across the whole invoice, so ten medicines
       * at 12% produce two rows rather than twenty. Summed from the per-line
       * amounts that were already rounded and apportioned, so these rows add
       * up to the invoice's tax exactly — recomputing from the totals would
       * give a different number that reconciles against nothing.
       */
      taxSummary: (() => {
        const rows = new Map<string, { name: string; rateBasisPoints: number; minor: number }>();

        for (const raw of (invoice.items as Record<string, unknown>[]) ?? []) {
          const lineTaxMinor = toMinor(toMoneyString(raw.taxAmount ?? '0.00'));
          if (lineTaxMinor === 0) continue;

          const parts =
            (raw.taxBreakdown as { name: string; rateBasisPoints: number; amount: string }[] | null) ??
            null;

          if (parts && parts.length > 0) {
            for (const c of parts) {
              const key = `${c.name}|${c.rateBasisPoints}`;
              const at = rows.get(key) ?? {
                name: c.name,
                rateBasisPoints: c.rateBasisPoints,
                minor: 0,
              };
              at.minor += toMinor(toMoneyString(c.amount));
              rows.set(key, at);
            }
            continue;
          }

          /*
           * A flat rate still gets a named row. "Tax" as a bare label is what
           * this replaces — a bill has to say what the tax *is*, and the rate
           * name is the only thing that distinguishes exempt from zero-rated.
           */
          const name = (raw.taxRateName as string | null) ?? 'Tax';
          const rate = (raw.taxRateBasisPoints as number | null) ?? 0;
          const key = `${name}|${rate}`;
          const at = rows.get(key) ?? { name, rateBasisPoints: rate, minor: 0 };
          at.minor += lineTaxMinor;
          rows.set(key, at);
        }

        return [...rows.values()]
          .sort((a, b) => b.rateBasisPoints - a.rateBasisPoints || a.name.localeCompare(b.name))
          .map((r) => ({
            name: r.name,
            rateBasisPoints: r.rateBasisPoints,
            label: formatRate(r.rateBasisPoints),
            amount: fromMinor(r.minor),
          }));
      })(),

      taxTotal: fromMinor(
        ((invoice.items as Record<string, unknown>[]) ?? []).reduce(
          (sum, i) => sum + toMinor(toMoneyString(i.taxAmount ?? '0.00')),
          0,
        ),
      ),
      payments: ((invoice.payments as Record<string, unknown>[]) ?? []).map((p) => ({
        id: p.id as number,
        amount: toMoneyString(p.amount),
        method: p.method as string,
        reference: (p.reference as string | null) ?? null,
        receivedAt: p.receivedAt as Date,
        receivedBy:
          (p.receivedBy as { fullName?: string } | undefined)?.fullName ?? null,
      })),
      refunds: ((invoice.refunds as Record<string, unknown>[]) ?? []).map((r) => ({
        id: r.id as number,
        amount: toMoneyString(r.amount),
        method: r.method as string,
        reason: r.reason as string,
        paymentId: (r.paymentId as number | null) ?? null,
        refundedAt: r.refundedAt as Date,
        refundedBy:
          (r.refundedBy as { fullName?: string } | undefined)?.fullName ?? null,
      })),
    };
  }

  private detailInclude() {
    return {
      patient: { select: { id: true, fullName: true } },
      items: true,
      payments: {
        orderBy: { receivedAt: 'desc' as const },
        include: { receivedBy: { select: { id: true, fullName: true } } },
      },
      /*
       * Shown beside the payments, never subtracted from them.
       *
       * An invoice that took £120 and gave £120 back is not the same as an
       * invoice that was never paid, and a screen showing only the net figure
       * cannot tell you which one you are looking at.
       */
      refunds: {
        orderBy: { refundedAt: 'desc' as const },
        include: { refundedBy: { select: { id: true, fullName: true } } },
      },
    };
  }
}
