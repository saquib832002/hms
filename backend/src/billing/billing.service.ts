import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, InvoiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { applyPayment, fromMinor, MoneyError, sumAmounts, toMinor, toMoneyString } from './money';
import { buildAgingReport, bucketFor, daysOverdue } from './aging';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';

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

    try {
      const invoice = await this.prisma.invoice.create({
        data: {
          tenantId: currentTenantId(),
          patientId: appointment.patientId,
          appointmentId: appointment.id,
          totalAmount: amount,
          items: {
            create: [
              {
                tenantId: currentTenantId(),
                description: 'CONS · Consultation',
                amount,
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

  async findAll(query: { status?: InvoiceStatus; patientId?: number; overdueOnly?: boolean }) {
    const where: Prisma.InvoiceWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
    };

    const invoices = await this.prisma.invoice.findMany({
      where,
      orderBy: { issuedAt: 'desc' },
      take: 200,
      include: this.detailInclude(),
    });

    const shaped = invoices.map((i) => this.shape(i));
    return {
      data: query.overdueOnly ? shaped.filter((i) => i.daysOverdue > 0 && !i.settled) : shaped,
    };
  }

  async findOne(id: number) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`);
    return this.shape(invoice);
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
      select: { id: true, totalAmount: true, amountPaid: true, status: true, voidedAt: true },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found`);

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

    return this.findOne(invoiceId);
  }

  /**
   * Void an invoice.
   *
   * Never a delete. A gap in the invoice numbering is indistinguishable from a
   * cover-up, and the audit trail references a row that has to still exist.
   *
   * An invoice with payments against it cannot be voided — money changed hands,
   * and pretending the invoice never existed would leave that payment attached
   * to nothing. That case needs a refund, which is not built.
   */
  async voidInvoice(id: number, dto: VoidInvoiceDto) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: { id: true, amountPaid: true, voidedAt: true, _count: undefined },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`);
    if (invoice.voidedAt) throw new ConflictException('That invoice is already voided');

    const payments = await this.prisma.payment.count({ where: { invoiceId: id } });
    if (payments > 0) {
      throw new ConflictException(
        'That invoice has payments against it. Voiding it would orphan money that was actually received — issue a refund instead.',
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
      where: { voidedAt: null, status: { notIn: [InvoiceStatus.PAID, InvoiceStatus.CANCELLED] } },
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

  async payments(limit = 50) {
    const rows = await this.prisma.payment.findMany({
      orderBy: { receivedAt: 'desc' },
      take: Math.min(limit, 200),
      include: {
        receivedBy: { select: { id: true, fullName: true } },
        invoice: {
          select: { id: true, patient: { select: { id: true, fullName: true } } },
        },
      },
    });

    return {
      data: rows.map((p) => ({
        id: p.id,
        amount: toMoneyString(p.amount),
        method: p.method,
        reference: p.reference,
        notes: p.notes,
        receivedAt: p.receivedAt,
        receivedBy: p.receivedBy?.fullName ?? null,
        invoiceId: p.invoiceId,
        patient: p.invoice?.patient ?? null,
      })),
    };
  }

  /**
   * Every currency field leaves as a string, and the derived figures are
   * computed here rather than in the client — two clients doing their own
   * subtraction is two chances to disagree about what a patient owes.
   */
  private shape(invoice: Record<string, unknown>) {
    const totalMinor = toMinor(toMoneyString(invoice.totalAmount));
    const paidMinor = toMinor(toMoneyString(invoice.amountPaid));
    const outstandingMinor = totalMinor - paidMinor;
    const dueDate = (invoice.dueDate as Date | null) ?? null;

    return {
      id: invoice.id as number,
      patient: invoice.patient as { id: number; fullName: string } | null,
      issuedAt: invoice.issuedAt as Date,
      dueDate,
      status: invoice.status as InvoiceStatus,
      notes: (invoice.notes as string | null) ?? null,
      voidedAt: (invoice.voidedAt as Date | null) ?? null,
      voidReason: (invoice.voidReason as string | null) ?? null,

      totalAmount: fromMinor(totalMinor),
      amountPaid: fromMinor(paidMinor),
      outstanding: fromMinor(outstandingMinor),
      settled: outstandingMinor <= 0,

      daysOverdue: outstandingMinor > 0 ? daysOverdue(dueDate) : 0,
      agingBucket: outstandingMinor > 0 ? bucketFor(dueDate) : 'current',

      items: ((invoice.items as Record<string, unknown>[]) ?? []).map((i) => ({
        id: i.id as number,
        description: i.description as string,
        amount: toMoneyString(i.amount),
      })),
      payments: ((invoice.payments as Record<string, unknown>[]) ?? []).map((p) => ({
        id: p.id as number,
        amount: toMoneyString(p.amount),
        method: p.method as string,
        reference: (p.reference as string | null) ?? null,
        receivedAt: p.receivedAt as Date,
        receivedBy:
          (p.receivedBy as { fullName?: string } | undefined)?.fullName ?? null,
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
    };
  }
}
