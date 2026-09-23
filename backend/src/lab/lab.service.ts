import {
  BadRequestException,
  Inject,
  forwardRef,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  InvoiceKind,
  InvoiceStatus,
  LabBillingMode,
  LabOrderDestination,
  LabOrderStatus,
  LabResultFlag,
  Prisma,
  ReferralBilling,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';
import { TaxContextService } from '../billing/tax-context.service';
import { AuthUser } from '../common/types/auth-user';
import { hospitalCharges } from './referral-billing';
import { formatAccession, isValidAccession, normaliseAccession } from './accession';
import {
  formatDateKey,
  groupBy,
  monthAnchor,
  monthLabel,
  nextDay,
  parseDateKey,
  parseMonthKey,
  periodLabel,
} from './lab-statement';
import { matchReferralItems, sourceItemIdByLocalId } from './referral-item-match';
import {
  hospitalDate,
  hospitalMonthKey,
  hospitalMonthRange,
  zonedTimeToUtc,
} from '../common/utils/hospital-time';
import { partnerLabels, routingTrail } from '../common/routing/routing-trail';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { NOT_TREATING, resolveTreatingScope } from '../common/clinical/treating-scope';
import { fromMinor, sumAmounts, toMinor, toMoneyString } from '../billing/money';
import { toPriceString, toPriceUnits } from '../pharmacy/pricing';
import {
  ChargeableTest,
  LAB_ITEM_KIND,
  PricedLabCharge,
  chooseLabInvoice,
  priceTests,
} from './lab-charge';
import {
  AnalyteRange,
  flagFor,
  formatRange,
  isAbnormal,
  isCritical,
  trendableValue,
} from './reference-range';
import {
  CancelLabOrderDto,
  CreateLabOrderDto,
  CreateLabTestDto,
  CriticalNotifiedDto,
  RecordResultDto,
  RejectSpecimenDto,
  UpdateLabTestDto,
  VerifyLabOrderDto,
} from './dto/lab.dto';
import { LabReferralService } from './lab-referral.service';

/**
 * The diagnostics module.
 *
 * WHAT MAKES THIS DIFFERENT FROM DISPENSING
 * -----------------------------------------
 * A prescription ends when the medicine is handed over. A test order ends when
 * a *result* reaches the person who asked the question, and everything here is
 * shaped by that: the worklist is not the feature, the report attached to the
 * patient's record is.
 *
 * TWO REFUSALS ARE LOAD-BEARING
 * -----------------------------
 * 1. **Nothing is a result until it is verified.** Values on a bench are not a
 *    report. A doctor acting on an unverified potassium is acting on something
 *    the lab has not stood behind, and the ordering screens deliberately do not
 *    show them.
 * 2. **A rejected specimen is not a cancelled order.** It means somebody has to
 *    take blood again, and collapsing the two turns "we need another sample"
 *    into "never mind" — discovered by a doctor chasing a result that is never
 *    coming.
 *
 * AND ONE ABSENCE
 * ---------------
 * Nothing here gates on payment. The collection, resulting and reporting paths
 * do not look at an invoice at all. Refusing to run a blood test because a card
 * was declined is not a decision software should make on a clinic's behalf —
 * the same position `consultation-billing.spec.ts` enforces one level up, and
 * `lab-billing.spec.ts` asserts the absence here.
 */

/** Which slice of the worklist to return. */
export type WorklistFilter =
  /** Ours to draw and hand to a courier — see `WORKLIST_WHERE.sendout`. */
  | 'sendout'
  | 'pending'
  | 'collected'
  | 'resulted'
  | 'completed'
  | 'all';

/**
 * The open statuses, in workflow order.
 *
 * `pending` is what a lab opens in the morning: ordered, and nothing taken yet.
 */
const WORKLIST_WHERE: Record<WorklistFilter, Prisma.LabOrderWhereInput> = {
  /*
   * Work going out of the building, still to be drawn or still to be sent.
   *
   * THE SCENARIO THIS EXISTS FOR
   * ----------------------------
   * A clinic with a doctor and no bench: the patient is in *its* waiting room,
   * gives the sample at *its* desk and pays *its* bill, and only the tube
   * travels to the partner laboratory. That is the ordinary reason a small
   * practice has a partner at all.
   *
   * Every other segment is filtered to `IN_HOUSE` on the reasoning that work
   * running elsewhere "is work somebody else is doing". True of the
   * examination; false of the specimen. So a PARTNER order disappeared from
   * the only screen that could record a collection, and the clinic had nowhere
   * to say the blood had been taken, no moment to print the label, and nothing
   * to hand the courier — while the patient stood in front of them.
   */
  sendout: {
    destination: LabOrderDestination.PARTNER,
    status: { in: [LabOrderStatus.ORDERED, LabOrderStatus.COLLECTED] },
    dispatchedAt: null,
  },
  pending: { status: LabOrderStatus.ORDERED },
  collected: { status: { in: [LabOrderStatus.COLLECTED, LabOrderStatus.IN_PROGRESS] } },
  resulted: { status: LabOrderStatus.RESULTED },
  completed: { status: { in: [LabOrderStatus.VERIFIED, LabOrderStatus.REJECTED] } },
  all: {},
};

/**
 * How a caller names the period a statement covers.
 *
 * `from`/`to` is the general form — any span of hospital-local days, because
 * referral agreements are written weekly, ten-daily and fortnightly as often as
 * monthly. `month` is the shorthand for the commonest one. Neither means this
 * month, resolved on the server so a client's clock cannot pick the wrong side
 * of a boundary.
 */
export interface StatementPeriodQuery {
  month?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class LabService {
  /**
   * The return leg is the one thing here that can fail without anybody
   * noticing, so it is the one thing that logs.
   *
   * Everything else in this service either succeeds or throws into the
   * exception filter, which audits it. Transmitting a report to another
   * hospital is deliberately best-effort — a network problem at their end must
   * not undo an authorisation this laboratory has committed to — and
   * "best-effort" was silently doing all of the work of "never happened".
   */
  private readonly logger = new Logger('LabReferralReturn');

  constructor(
    private readonly prisma: PrismaService,
    private readonly clinic: ClinicSettingsService,
    private readonly tax: TaxContextService,
    @Inject(forwardRef(() => LabReferralService))
    private readonly referrals: LabReferralService,
  ) {}

  // ── the catalogue ────────────────────────────────────────────────────────

  /**
   * Every test this hospital offers.
   *
   * `includeInactive` exists for the admin screen: a retired test still has to
   * be findable in order to be brought back, and a list that silently omits it
   * makes re-adding it fail as a duplicate against a row nobody can see —
   * exactly the trap the partner directory fell into.
   */
  async tests(includeInactive = false) {
    const rows = await this.prisma.labTest.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: { analytes: { orderBy: { position: 'asc' } } },
    });

    return { data: rows.map((t) => this.toTestResponse(t)) };
  }

  async createTest(dto: CreateLabTestDto) {
    const code = dto.code.trim().toUpperCase();

    const existing = await this.prisma.labTest.findFirst({ where: { code } });
    if (existing?.isActive) {
      throw new ConflictException(`A test with code ${code} already exists`);
    }
    if (existing) {
      /*
       * Reactivate rather than refuse. The unique index covers inactive rows,
       * so a plain create would fail naming a row the administrator cannot see
       * — the bug that made a removed partner pharmacy unre-addable and left
       * the database console as the only exit.
       */
      return this.updateTest(existing.id, {
        ...dto,
        isActive: true,
      } as UpdateLabTestDto);
    }

    const created = await this.prisma.labTest.create({
      data: {
        tenantId: currentTenantId(),
        code,
        name: dto.name.trim(),
        category: dto.category,
        specimenType: dto.specimenType ?? undefined,
        sellingPrice: dto.sellingPrice ? new Prisma.Decimal(dto.sellingPrice) : null,
        taxRateId: dto.taxRateId ?? null,
        turnaroundHours: dto.turnaroundHours ?? null,
        preparation: dto.preparation?.trim() || null,
        analytes: {
          create: (dto.analytes ?? []).map((a, i) => ({
            ...this.analyteData(a, i),
            tenantId: currentTenantId(),
          })),
        },
      },
      include: { analytes: { orderBy: { position: 'asc' } } },
    });

    return this.toTestResponse(created);
  }

  /**
   * Edit a test — including its price, from the worklist.
   *
   * PHARMACIST gained inline pricing on the dispensing screen because "not
   * priced" was a dead end that sent them to another screen with a patient at
   * the counter, and in practice the medicine went out unpriced. The lab has
   * the identical problem and gets the identical shortcut: LAB_TECHNICIAN may
   * price a test, which is a capability an ADMIN already had, exposed where the
   * gap is discovered.
   */
  async updateTest(id: number, dto: UpdateLabTestDto) {
    const test = await this.prisma.labTest.findUnique({ where: { id } });
    if (!test) throw new NotFoundException('No such test');

    /*
     * `@IsOptional()` accepts null as well as undefined, so "not sent" and
     * "sent as null" arrive indistinguishable unless the raw key is checked.
     * Getting this wrong is what threw a 500 on `PATCH /letterhead` the first
     * time somebody cleared a field.
     */
    const sent = (key: keyof UpdateLabTestDto) => Object.hasOwn(dto, key);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.analytes) {
        /*
         * Replaced wholesale rather than merged.
         *
         * A merge needs stable ids the editor does not have, and a
         * half-applied range is worse than either version of it: a value gets
         * flagged against limits that are neither the old ones nor the new.
         * Results already issued are unaffected — they captured their own
         * range as text at the moment they were entered.
         */
        await tx.labAnalyte.deleteMany({ where: { testId: id } });
        await tx.labAnalyte.createMany({
          data: dto.analytes.map((a, i) => ({
            ...this.analyteData(a, i),
            tenantId: currentTenantId(),
            testId: id,
          })),
        });
      }

      return tx.labTest.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.specimenType !== undefined ? { specimenType: dto.specimenType } : {}),
          ...(sent('sellingPrice')
            ? { sellingPrice: dto.sellingPrice ? new Prisma.Decimal(dto.sellingPrice) : null }
            : {}),
          ...(sent('taxRateId') ? { taxRateId: dto.taxRateId ?? null } : {}),
          ...(sent('turnaroundHours') ? { turnaroundHours: dto.turnaroundHours ?? null } : {}),
          ...(sent('preparation') ? { preparation: dto.preparation?.trim() || null } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        include: { analytes: { orderBy: { position: 'asc' } } },
      });
    });

    return this.toTestResponse(updated);
  }

  // ── ordering ─────────────────────────────────────────────────────────────

  /**
   * Order tests for a patient.
   *
   * The relationship check is `resolveTreatingScope`, shared with prescribing
   * and record-writing rather than copied. Three copies of "may this doctor
   * write for this patient" would drift, and a doctor who may prescribe but may
   * not investigate is a rule nobody intended.
   */
  async createOrder(dto: CreateLabOrderDto, user: AuthUser) {
    if (!user.doctorId) {
      // `doctorId` is withheld unless acting as DOCTOR — it is a capability,
      // not an identifier. An admin who also holds DOCTOR must switch role.
      throw new ForbiddenException('Only a doctor acting as a doctor can order tests');
    }

    const settings = await this.clinic.current();
    const scope = await resolveTreatingScope(
      this.prisma,
      settings.timezone,
      user.doctorId,
      dto.patientId,
    );
    if (!scope) throw new ForbiddenException(NOT_TREATING);

    const tests = await this.prisma.labTest.findMany({
      where: { id: { in: dto.testIds }, isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        category: true,
        specimenType: true,
        sellingPrice: true,
        taxRateId: true,
      },
    });

    if (tests.length === 0) throw new BadRequestException('None of those tests exist');

    const destination = await this.resolveDestination(dto);
    const partner =
      destination === LabOrderDestination.PARTNER
        ? await this.referrals.requirePartner(dto.partnerId as number)
        : null;

    const tax = await this.tax.current();

    /*
     * Does this hospital charge the patient for this investigation?
     *
     * THE HOLE THIS CLOSES
     * --------------------
     * It used to charge only IN_HOUSE work, and `LabOrder.invoiceId` said so —
     * *"Null for a partner or external order, which this hospital does not bill
     * for."* True of the invoice and false of the money: the *receiving* lab
     * raises its charge against this hospital on accession, so a clinic that
     * referred a test billed nobody and owed somebody. Every partner referral
     * was a straight loss, silently, with no screen anywhere that could have
     * shown it — no screen lists another company's debts, and none listed tests
     * this hospital had deliberately declined to charge for.
     *
     * It stayed invisible because the two halves live in two tenants. The
     * clinic's books showed no line and nothing missing; the lab's showed an
     * ordinary receivable.
     *
     * So the question is now the partnership's billing arrangement rather than
     * the destination, and both answers raise exactly one invoice between the
     * two organisations.
     */
    const charges = hospitalCharges(destination, partner?.billing ?? null);

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.labOrder.create({
        data: {
          tenantId: currentTenantId(),
          // The number that goes on the tube, allocated the moment the specimen
          // is asked for — a label cannot be printed without it and a worklist
          // row nobody can scan is a row somebody has to search for by name.
          accession: await this.nextAccession(tx),
          patientId: dto.patientId,
          doctorId: user.doctorId as number,
          /*
           * Linked only when the appointment is *today*, exactly as a
           * prescription is. A test ordered six weeks after a consultation is
           * not part of it, and attaching it would file the result under that
           * visit and put the charge on that visit's bill.
           */
          appointmentId: scope.sameDay ? scope.appointment?.id ?? null : null,
          admissionId: scope.admissionId,
          priority: dto.priority ?? undefined,
          destination,
          routedToTenantId: partner?.partnerTenantId ?? null,
          clinicalDetails: dto.clinicalDetails?.trim() || null,
          items: {
            create: tests.map((t) => ({
              tenantId: currentTenantId(),
              testId: t.id,
              testCode: t.code,
              testName: t.name,
              category: t.category,
              specimenType: t.specimenType,
              // Captured now. Repricing the catalogue next year must not
              // restate what this patient was charged today.
              unitPrice: t.sellingPrice,
              /*
               * Somebody else is billing for this one, so we deliberately did
               * not — which is a different fact from nobody having priced it,
               * and the whole reason this is a column rather than an inference
               * from a null price. Without it every "went out uncharged"
               * figure in the system reports these forever, and people stop
               * reading the figure that catches the real ones.
               */
              payableExternally: !charges,
            })),
          },
        },
        include: { items: true },
      });

      /*
       * Charge whoever this hospital is the one billing.
       *
       * IN_HOUSE and a partner under ORIGIN_PAYS both mean the patient settles
       * here: we did the work, or we are paying somebody else to do it and
       * recovering that. Under PATIENT_PAYS, and for a named external lab, the
       * patient pays at the counter that ran the test and a charge here would
       * bill them twice for one investigation — the second bill coming from an
       * organisation that did nothing.
       */
      const charge = charges
        ? await this.chargeOrder(tx, created.id, dto.patientId, created.items, tax)
        : { invoiceId: null, unpriced: [] as string[], total: null };

      return { created, charge };
    });

    /*
     * Transmitted outside the transaction, exactly as a prescription referral
     * is. The write enters another tenant's scope and must not be nested inside
     * this one's — see `transmitLabReferral`.
     */
    const referral = partner
      ? await this.referrals.transmit(order.created.id, partner)
      : null;

    return {
      ...(await this.orderDetail(order.created.id, user)),
      referral,
      /*
       * Named back at the moment of ordering rather than discovered in a
       * report a month later. Blank is not zero: the test is still performed.
       */
      unpricedTests: order.charge.unpriced,
    };
  }

  /**
   * Retract an order.
   *
   * Built with a caller on both clients in the same change, because
   * `PATCH /prescriptions/:id/cancel` has existed, tested and correct, with no
   * way in, since Phase 4 — and a UI that reasons about a state nobody can
   * reach is the most serious of the five endpoints with no caller.
   */
  async cancelOrder(id: number, dto: CancelLabOrderDto, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id },
      select: { id: true, status: true, invoiceId: true, collectedAt: true },
    });
    if (!order) throw new NotFoundException('No such order');

    if (order.status === LabOrderStatus.VERIFIED) {
      throw new ConflictException(
        'That test has been reported. A reported result is part of the record and cannot be withdrawn here',
      );
    }
    if (order.status === LabOrderStatus.CANCELLED) {
      throw new ConflictException('That order was already cancelled');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.labOrder.update({
        where: { id },
        data: {
          status: LabOrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: user.userId,
          cancelReason: dto.reason.trim(),
        },
      });

      /*
       * Void the charge only if nothing was taken.
       *
       * Nothing physically happened, so nothing should be recorded as having
       * happened — the same honesty as reversing a dispense that never left
       * the counter. Once a specimen exists the sample was taken and the
       * reagent used, and inventing a refund for real work is the mirror
       * error. A paid invoice is never voided either: that would make money
       * vanish from the day's takings with nothing to explain the gap.
       */
      if (order.invoiceId && order.collectedAt === null) {
        const invoice = await tx.invoice.findUnique({
          where: { id: order.invoiceId },
          select: { amountPaid: true, kind: true },
        });
        if (invoice && toMinor(toMoneyString(invoice.amountPaid)) === 0) {
          await tx.invoice.update({
            where: { id: order.invoiceId },
            data: { status: InvoiceStatus.CANCELLED },
          });
        }
      }
    });

    return { id, cancelled: true };
  }

  /**
   * Where the tests will actually be run.
   *
   * Defaults to the hospital's own lab, so the common case is nothing to think
   * about. A hospital with `hasLab = false` never has an in-house option at
   * all — every order leaves the building, and a queue nobody works never comes
   * into existence.
   *
   * A destination is a filter and never a refusal. Nothing downstream checks
   * it before collecting or resulting: if the patient comes back with the
   * sample, the lab runs it. `lab-referral.spec.ts` asserts that absence, for
   * the same reason `referral.spec.ts` does — a routing note hardening into
   * "computer says no" is the failure the payment gate and the subscription
   * guard both refuse.
   */
  private async resolveDestination(dto: CreateLabOrderDto): Promise<LabOrderDestination> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: currentTenantId() },
      select: { hasLab: true },
    });

    if (dto.destination === LabOrderDestination.PARTNER) {
      if (!dto.partnerId) throw new BadRequestException('Choose which partner lab to send it to');
      return LabOrderDestination.PARTNER;
    }
    if (dto.destination === LabOrderDestination.EXTERNAL) return LabOrderDestination.EXTERNAL;

    // No lab here means no in-house option, whatever the client asked for.
    return tenant?.hasLab ? LabOrderDestination.IN_HOUSE : LabOrderDestination.EXTERNAL;
  }

  // ── the lab's own worklist ───────────────────────────────────────────────

  /**
   * What the lab has to do.
   *
   * Segmented rather than filtered to the open items. Fifth time in this
   * codebase: the pharmacy invoice list hid every settled invoice, the refund
   * screen could not find a paid one, the referral queue dropped a row the
   * moment it was handed over. The question people bring to a screen is very
   * often about something that has already finished — "did that troponin ever
   * come back" is asked precisely once a pending-only list would have dropped
   * it.
   */
  async worklist(filter: WorklistFilter = 'pending') {
    const rows = await this.prisma.labOrder.findMany({
      where: {
        ...WORKLIST_WHERE[filter],
        /*
         * The hospital's own bench — except on the send-out list, which is
         * about the *specimen* rather than the examination. That segment
         * carries its own `destination`, so overriding it here would empty it.
         */
        ...(filter === 'sendout' ? {} : { destination: LabOrderDestination.IN_HOUSE }),
      },
      orderBy:
        filter === 'completed'
          ? [{ orderedAt: 'desc' }]
          : // STAT, then URGENT, then ROUTINE — and oldest first inside each.
            [{ priority: 'desc' }, { orderedAt: 'asc' }],
      take: 200,
      include: {
        patient: { select: { id: true, fullName: true, dob: true, gender: true } },
        doctor: { select: { fullName: true } },
        items: { include: { values: { orderBy: { position: 'asc' } } } },
        /*
         * Whether the money has been taken, on the row where somebody could
         * take it.
         *
         * The person drawing the blood is standing in front of the patient,
         * which is the only moment the payment is easy to collect — and the
         * worklist carried `invoiceId` and nothing else, so a technician could
         * see that *an* invoice existed and not whether it was settled. Which
         * is the half that decides whether to ask.
         *
         * Four columns, not the whole invoice: no lines, so no test name
         * reaches a screen through a back door it was never meant to have.
         */
        invoice: {
          select: {
            id: true,
            status: true,
            totalAmount: true,
            amountPaid: true,
            creditedAmount: true,
          },
        },
        /*
         * Whether the other hospital actually has the report.
         *
         * `LabReferral.resultedAt` is set only after the cross-tenant write
         * commits, so it is the one honest answer to "did it arrive". Without
         * it on the row, a referred order that failed to transmit sits in the
         * completed tab looking identical to one that landed — which is exactly
         * how a doctor at the other end came to be waiting for a result that
         * had been authorised days earlier.
         */
        referral: {
          select: {
            requestedByName: true,
            sourceTenantName: true,
            resultedAt: true,
            declinedAt: true,
          },
        },
      },
    });

    return { data: rows.map((r) => this.toWorklistRow(r)) };
  }

  /** Mark the specimen taken, or the patient sent for imaging. */
  async collect(id: number, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException('No such order');
    if (order.status !== LabOrderStatus.ORDERED && order.status !== LabOrderStatus.REJECTED) {
      throw new ConflictException('That order is past collection');
    }

    /*
     * The sample now exists, so it needs a number — for the orders that
     * predate accessions and would otherwise carry none forever. A no-op for
     * everything raised since, which already has one from ordering.
     */
    const accession = await this.ensureAccession(id);

    await this.prisma.labOrder.update({
      where: { id },
      data: {
        status: LabOrderStatus.COLLECTED,
        collectedAt: new Date(),
        collectedById: user.userId,
        // A recollection clears the rejection: the sample that failed is not
        // the sample now on the bench, and leaving the reason attached would
        // make the worklist read as though the new one had failed too.
        rejectedAt: null,
        rejectReason: null,
      },
    });

    /*
     * Returned so the screen can offer the label immediately. A technician who
     * has just marked a tube taken is holding it, and the next thing they need
     * is the sticker.
     */
    return { id, collected: true, accession };
  }

  /**
   * The tube has left for the partner laboratory.
   *
   * Separate from collection because the gap between them is real: a specimen
   * drawn at 09:14 and couriered at 16:00 spent the day on a bench, and a
   * potassium from it reads differently. Recording one time for both would
   * make a laboratory's judgement about sample integrity a guess.
   *
   * Refuses before the specimen exists. Marking a tube dispatched when nobody
   * has drawn it puts a hospital in the position of telling a partner that
   * something is on its way when it is not — and the partner then waits for
   * a courier rather than ringing to ask.
   *
   * The sender's times are pushed onto the referral in the partner's scope
   * afterwards, outside this transaction and for the reason `transmit` is:
   * that write enters another tenant and must not nest inside one this request
   * already holds.
   */
  async dispatch(id: number, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id },
      select: {
        id: true,
        destination: true,
        collectedAt: true,
        dispatchedAt: true,
        referralId: true,
        accession: true,
      },
    });
    if (!order) throw new NotFoundException('No such order');

    if (order.destination !== LabOrderDestination.PARTNER) {
      throw new ConflictException('That test is not going to a partner laboratory');
    }
    if (order.dispatchedAt) throw new ConflictException('That specimen has already been sent');
    if (!order.collectedAt) {
      throw new ConflictException(
        'Take the specimen first — a tube cannot be sent before it has been drawn.',
      );
    }

    const dispatchedAt = new Date();
    await this.prisma.labOrder.update({ where: { id }, data: { dispatchedAt } });

    /*
     * Tell the laboratory the tube is on its way, and when it was taken.
     *
     * Best-effort and outside any transaction. A failure here must not undo a
     * dispatch that physically happened — the courier has the tube either way —
     * and the referral is a copy rather than the record.
     */
    await this.referrals.noticeDispatch(id, order.collectedAt, dispatchedAt);

    return { id, dispatchedAt, accession: order.accession };
  }

  /**
   * The specimen could not be used.
   *
   * Returns the order to a state where it can be collected again, rather than
   * ending it. A rejection is a request for another sample; the reason is what
   * gets somebody to take one.
   */
  async reject(id: number, dto: RejectSpecimenDto) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException('No such order');
    if (order.status === LabOrderStatus.VERIFIED) {
      throw new ConflictException('That test has already been reported');
    }

    await this.prisma.labOrder.update({
      where: { id },
      data: {
        status: LabOrderStatus.REJECTED,
        rejectedAt: new Date(),
        rejectReason: dto.reason.trim(),
      },
    });

    /*
     * A referred specimen that is unusable is the sender's problem to fix.
     *
     * Rejecting is not declining: the work is still wanted, and what the
     * ordering hospital needs to hear is "take another sample" rather than
     * "never mind". It lands on their order as REJECTED, which is exactly the
     * state that makes somebody draw more blood instead of waiting for a
     * result nobody is producing.
     */
    const referred = await this.rejectIfReferred(id, dto.reason.trim());

    return { id, rejected: true, ...referred };
  }

  /**
   * Push a specimen rejection back to the hospital that referred the work.
   *
   * The same reporting rule as an authorised result, and for a sharper reason:
   * a hospital that never learns its sample was unusable is one whose patient
   * is waiting for a result nobody is producing. A silent failure here is the
   * worst of the three available outcomes.
   */
  private async rejectIfReferred(orderId: number, reason: string) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
      select: { referralId: true, accession: true },
    });
    if (!order?.referralId) return {};

    try {
      await this.referrals.rejectBack(order.referralId, reason);
      return { reportedBack: true, reportedBackError: null };
    } catch (err) {
      return this.reportFailure(
        orderId,
        order.accession,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Enter one test's result.
   *
   * Values are flagged here, on the server, against the analyte's own range —
   * and the range is **captured as text on the value** at the same moment.
   * Editing a reference range next year must not restate whether a patient's
   * result was normal at the time it was issued, and a report reprinted later
   * has to show the range that was actually applied.
   */
  async recordResult(itemId: number, dto: RecordResultDto, user: AuthUser) {
    const item = await this.prisma.labOrderItem.findUnique({
      where: { id: itemId },
      include: {
        order: { select: { id: true, status: true } },
        test: { include: { analytes: { orderBy: { position: 'asc' } } } },
      },
    });
    if (!item) throw new NotFoundException('No such test on any order');

    if (item.order.status === LabOrderStatus.VERIFIED) {
      throw new ConflictException(
        'That report has been authorised. Amending it needs a new order, so the original stays readable',
      );
    }
    if (item.order.status === LabOrderStatus.CANCELLED) {
      throw new ConflictException('That order was cancelled');
    }

    const ranges = new Map(
      (item.test?.analytes ?? []).map((a) => [
        a.name.trim().toLowerCase(),
        {
          unit: a.unit,
          range: {
            refLow: numberOrNull(a.refLow),
            refHigh: numberOrNull(a.refHigh),
            refText: a.refText,
            criticalLow: numberOrNull(a.criticalLow),
            criticalHigh: numberOrNull(a.criticalHigh),
          } satisfies AnalyteRange,
        },
      ]),
    );

    const values = (dto.values ?? []).map((v, i) => {
      const known = ranges.get(v.analyteName.trim().toLowerCase());
      /*
       * An analyte the catalogue does not know about is accepted and flagged
       * UNKNOWN rather than refused. A technician adding a line the catalogue
       * is missing is reporting a real measurement, and rejecting it would
       * send them to a settings screen with a specimen in front of them —
       * which is the dead end this project has now hit five times.
       */
      const range: AnalyteRange = known?.range ?? {
        refLow: null,
        refHigh: null,
        refText: null,
        criticalLow: null,
        criticalHigh: null,
      };
      return {
        tenantId: currentTenantId(),
        orderItemId: itemId,
        analyteName: v.analyteName.trim(),
        unit: v.unit ?? known?.unit ?? null,
        value: v.value.trim(),
        numericValue: decimalOrNull(trendableValue(v.value)),
        referenceRange: formatRange(range, v.unit ?? known?.unit ?? null),
        flag: flagFor(v.value, range),
        position: i,
      };
    });

    await this.prisma.$transaction(async (tx) => {
      // Replaced, not appended: entering a result twice is a correction, and
      // two sets of values on one test is a report nobody can read.
      await tx.labResultValue.deleteMany({ where: { orderItemId: itemId } });
      if (values.length > 0) await tx.labResultValue.createMany({ data: values });

      await tx.labOrderItem.update({
        where: { id: itemId },
        data: {
          findings: dto.findings?.trim() || null,
          impression: dto.impression?.trim() || null,
          methodology: dto.methodology?.trim() || null,
          resultedAt: new Date(),
          resultedById: user.userId,
        },
      });

      await tx.labOrder.update({
        where: { id: item.order.id },
        data: { status: await this.deriveStatus(tx, item.order.id) },
      });
    });

    return {
      itemId,
      critical: values.filter((v) => isCritical(v.flag)).map((v) => v.analyteName),
      abnormal: values.filter((v) => isAbnormal(v.flag)).map((v) => v.analyteName),
    };
  }

  /**
   * Record that a critical value was telephoned through.
   *
   * **Nothing in this system notifies anybody**, and both clients say so in as
   * many words. A control that looks like it pages a doctor and does not is
   * worse than none, because the technician stops making the call. This records
   * that a human did: who was told, when, and by whom.
   */
  async recordCriticalCall(itemId: number, dto: CriticalNotifiedDto, user: AuthUser) {
    const item = await this.prisma.labOrderItem.findUnique({
      where: { id: itemId },
      select: { id: true },
    });
    if (!item) throw new NotFoundException('No such test on any order');

    await this.prisma.labOrderItem.update({
      where: { id: itemId },
      data: {
        criticalNotifiedAt: new Date(),
        criticalNotifiedTo: dto.notifiedTo.trim(),
        criticalNotifiedById: user.userId,
      },
    });

    return { itemId, recorded: true };
  }

  /**
   * Authorise the report.
   *
   * The moment a set of numbers becomes a result. Until this happens the
   * ordering doctor sees the order as in progress and no values at all — a
   * clinician acting on an unchecked figure is acting on something the lab has
   * not stood behind, and showing it "just so they can see early" is how that
   * happens.
   */
  async verify(id: number, dto: VerifyLabOrderDto, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id },
      include: { items: { select: { id: true, resultedAt: true, testName: true } } },
    });
    if (!order) throw new NotFoundException('No such order');
    if (order.status === LabOrderStatus.VERIFIED) {
      throw new ConflictException('That report has already been authorised');
    }
    if (order.status === LabOrderStatus.CANCELLED) {
      throw new ConflictException('That order was cancelled');
    }

    const outstanding = order.items.filter((i) => i.resultedAt === null);
    if (outstanding.length > 0) {
      /*
       * Every test on the requisition, or none of it.
       *
       * Authorising a partial report puts a document in the record that looks
       * complete and is not — and the tests missing from it are exactly the
       * ones nobody then chases, because the order has left the worklist.
       */
      throw new ConflictException(
        `Still to be resulted: ${outstanding.map((i) => i.testName).join(', ')}`,
      );
    }

    await this.prisma.labOrder.update({
      where: { id },
      data: {
        status: LabOrderStatus.VERIFIED,
        verifiedAt: new Date(),
        verifiedById: user.userId,
        externalVerifiedBy: dto.externalVerifiedBy?.trim() || null,
      },
    });

    /*
     * The return leg fires here, on authorisation — not from a separate form.
     *
     * This is the whole point of accessioning a referral into the worklist. It
     * used to be possible to report a partner's work without it ever having
     * been collected, benched or authorised; now the transmission is a
     * consequence of the same gate a local report passes.
     *
     * After the local update rather than inside it: if the partner's hospital
     * is unreachable, this laboratory's own record still says the work was
     * done and authorised, which is true. The reverse — rolling back a
     * verification because a network call failed — would make this lab's
     * record depend on somebody else's availability.
     */
    const referred = await this.transmitIfReferred(id, user);

    return { id, verified: true, ...referred };
  }

  /**
   * Send an authorised result back to the hospital that referred it.
   *
   * Returns `{ reportedBack, reportedBackError }` so the technician's screen
   * can say whether the other hospital actually has it. That sentence used to
   * be in this comment and in nothing else: **no client read `reportedBack`**,
   * and the `catch` below threw the reason away without logging it. So a report
   * that never left this building looked exactly like one that arrived — the
   * technician saw "authorised", the order left the worklist, and the doctor at
   * the other end waited for a result nobody was sending.
   *
   * Reported from use, and it is the same shape as the print anchor that 401'd
   * for six phases: the failure is invisible because the success is silent.
   */
  private async transmitIfReferred(orderId: number, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
      select: {
        referralId: true,
        accession: true,
        /*
         * Ordered explicitly, both sides. Postgres returns rows in no
         * particular order unless asked, and the mapping below used to be by
         * array position across two unordered reads — so on a multi-test
         * referral a potassium could be written into the other hospital's
         * record under the glucose. It typechecked and it looked right.
         */
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            testCode: true,
            testName: true,
            findings: true,
            impression: true,
            methodology: true,
            values: { select: { analyteName: true, value: true, unit: true }, orderBy: { position: 'asc' } },
          },
        },
        referral: {
          select: {
            items: {
              orderBy: { id: 'asc' },
              select: { sourceOrderItemId: true, testCode: true },
            },
          },
        },
      },
    });

    if (!order?.referralId || !order.referral) return {};

    /*
     * Map this lab's order items back onto the sender's, **by test code**.
     *
     * `matchReferralItems` is shared with `returnResult`, which uses the same
     * pairing to carry the attached files. Two copies of this join drifting
     * would put a result on one test and its report PDF on another — worse than
     * either being wrong alone, because both halves look plausible.
     */
    const match = matchReferralItems(order.items, order.referral.items);
    const sourceIdOf = sourceItemIdByLocalId(match);

    const items = order.items
      .filter((item) => sourceIdOf.has(item.id))
      .map((item) => ({
        sourceOrderItemId: sourceIdOf.get(item.id)!,
        findings: item.findings,
        impression: item.impression,
        methodology: item.methodology,
        values: item.values.map((v) => ({
          analyteName: v.analyteName,
          value: v.value,
          unit: v.unit ?? undefined,
        })),
      }));

    const unmatched = match.unmatched;

    if (unmatched.length > 0) {
      /*
       * Refused, and named. Writing values onto the wrong test in another
       * hospital's record is worse than not writing them at all, and this is
       * the message that tells somebody to telephone rather than wait.
       */
      return this.reportFailure(
        orderId,
        order.accession,
        `These tests could not be matched back to the referral, so nothing was sent: ${unmatched.join(', ')}. Ring the referring hospital.`,
      );
    }

    try {
      await this.referrals.returnResult(order.referralId, {
        verifiedBy: user.fullName,
        items: items as never,
      });
      return { reportedBack: true, reportedBackError: null };
    } catch (err) {
      /*
       * The reason, kept. It was in hand the whole time — `returnResult` refuses
       * with a written sentence and `pushBack` surfaces a database error — and a
       * bare `catch` threw all of it away.
       */
      return this.reportFailure(
        orderId,
        order.accession,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * One place that says a report did not reach the other hospital.
   *
   * Logged as well as returned. The screen is where somebody can act on it, and
   * the log is where it is still findable tomorrow when they did not — a
   * cross-tenant write that fails at 4pm on a Friday is otherwise gone.
   */
  private reportFailure(orderId: number, accession: string | null, message: string) {
    this.logger.error(
      `Report for order ${orderId} (${accession ?? 'no specimen no.'}) was not sent back to the referring hospital: ${message}`,
    );
    return { reportedBack: false, reportedBackError: message };
  }

  /**
   * Try again, after it failed.
   *
   * WHY THIS HAD TO EXIST
   * ---------------------
   * The transmission fires from `verify`, and `verify` refuses on an order that
   * is already VERIFIED. So a report that failed to transmit was **stuck for
   * good**: authorised here, absent there, and nothing anywhere in the product
   * able to send it. Seventh instance of the family this project keeps
   * reopening — a refusal, or in this case a silent failure, with no route a
   * human can take.
   *
   * Safe to press twice. `returnResult` sets `LabReferral.resultedAt` only after
   * the cross-tenant write commits, and that write is one transaction — so
   * `resultedAt === null` means precisely that nothing landed, and a retry
   * cannot duplicate values or overwrite a report the other hospital has already
   * acted on.
   */
  async reportBack(id: number, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        referralId: true,
        referral: { select: { resultedAt: true, declinedAt: true, sourceTenantName: true } },
      },
    });
    if (!order) throw new NotFoundException('No such order');

    if (!order.referralId || !order.referral) {
      throw new BadRequestException(
        'That order was raised here, so there is no other hospital to report it to',
      );
    }
    if (order.referral.declinedAt) {
      throw new ConflictException('That referral was declined, so no result is owed');
    }
    if (order.referral.resultedAt) {
      throw new ConflictException(
        `${order.referral.sourceTenantName} already has this report. A correction is a new order, so the original stays readable`,
      );
    }
    if (order.status !== LabOrderStatus.VERIFIED) {
      /*
       * Named rather than silently doing nothing. The two-step gate is the
       * point of accessioning a referral, and "authorise it first" is an
       * instruction the person reading it can actually follow.
       */
      throw new ConflictException(
        'Nothing is sent until the report is authorised — authorise it and it goes automatically',
      );
    }

    return { id, ...(await this.transmitIfReferred(id, user)) };
  }

  // ── reading results ──────────────────────────────────────────────────────

  /** Every order for one patient, newest first. */
  async forPatient(patientId: number, user: AuthUser) {
    const rows = await this.prisma.labOrder.findMany({
      where: { patientId },
      orderBy: { orderedAt: 'desc' },
      take: 100,
      include: {
        doctor: { select: { fullName: true } },
        items: { include: { values: { orderBy: { position: 'asc' } } } },
      },
    });

    /*
     * "Where did this test go, and has anything come back."
     *
     * `destination` reached the client already; the partner's *name* did not,
     * so a doctor reading a history saw "PARTNER" and no way to tell which lab.
     * Unlike a prescription referral this trail is complete in both directions,
     * because the return leg writes results into this hospital's own rows.
     */
    const labels = await partnerLabels(
      this.prisma,
      'LAB_ORDER',
      rows.map((r) => r.routedToTenantId),
    );

    return {
      data: rows.map((r) => ({
        ...this.toOrderResponse(r, user),
        routing: routingTrail(
          'LAB_ORDER',
          {
            destination: r.destination,
            routedToTenantId: r.routedToTenantId,
            sentAt: r.orderedAt,
            /*
             * Authorisation is when the report became readable — for a partner
             * order that is the moment their result arrived, because
             * `returnResult` authorises on arrival under the partner's named
             * pathologist. Values on a bench are not a report, so an unverified
             * order correctly reports nothing back yet.
             */
            reportedAt: r.verifiedAt,
            /*
             * A rejected specimen is the partner saying "send another" — the
             * ordering hospital's most useful negative outcome, and it lands
             * here rather than as a cancellation for exactly that reason.
             */
            declinedAt: r.rejectedAt,
            declineReason: r.rejectReason,
          },
          labels,
        ),
      })),
    };
  }

  async orderDetail(id: number, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, fullName: true, dob: true, gender: true } },
        doctor: { select: { fullName: true } },
        verifiedBy: { select: { fullName: true } },
        items: { include: { values: { orderBy: { position: 'asc' } } } },
      },
    });
    if (!order) throw new NotFoundException('No such order');

    return {
      ...this.toOrderResponse(order, user),
      patient: {
        id: order.patient.id,
        fullName: order.patient.fullName,
        dob: order.patient.dob,
        gender: order.patient.gender,
      },
      verifiedByName: order.verifiedBy?.fullName ?? order.externalVerifiedBy ?? null,
    };
  }

  // ── billing ──────────────────────────────────────────────────────────────

  /**
   * Raise the charge for an order, at the moment it is placed.
   *
   * Mirrors `chargeSale`, including the rule that a total appended to an
   * existing invoice is re-derived from its own lines rather than incremented
   * — `{ increment }` is one query shorter and is the version that drifts when
   * a request is retried.
   */
  /**
   * Charge a referred order to the hospital that sent it.
   *
   * Public because `LabReferralService.accept` calls it inside its own
   * transaction — the invoice and the order have to be one atomic act, or a
   * failure leaves work accepted and unbilled, which is the bug this closes.
   *
   * No patient on the invoice: the debtor is the referring institution. The
   * patient may never learn this laboratory was involved and is certainly not
   * going to walk in and settle it.
   */
  /**
   * Charge for work another hospital referred here — to whichever of them owes
   * it.
   *
   * `billing` is read from the **referral**, which captured it when the work
   * was sent, and never from a partnership row: `lab_partners` lives in the
   * sending hospital's scope and is not reachable from here at all, and even
   * if it were, a term renegotiated since must not restate who owed what for
   * work already accepted.
   *
   * Under ORIGIN_PAYS the invoice carries **no patient**. A reference
   * laboratory bills the institution that sent the work; the patient may never
   * learn this lab was involved and is certainly not walking in to settle it,
   * so the hospital is named in the notes instead — which is the only thing
   * making a patientless invoice attributable.
   *
   * Under PATIENT_PAYS it is an ordinary patient invoice, and the patient is
   * the one who will be standing at this counter. It stays out of any COMBINED
   * hospital invoice regardless, because `chargeOrder` only appends for a
   * patient of *this* hospital's own clinic — the referred patient has no
   * hospital invoice here and should not acquire one.
   */
  async chargeReferredOrder(
    tx: Prisma.TransactionClient,
    orderId: number,
    billing: ReferralBilling,
    payer: string,
    patientId: number,
  ) {
    const items = await tx.labOrderItem.findMany({
      where: { orderId },
      select: { id: true, testCode: true, testName: true, unitPrice: true, testId: true },
    });
    const tax = await this.tax.current();

    return billing === ReferralBilling.PATIENT_PAYS
      ? this.chargeOrder(tx, orderId, patientId, items, tax)
      : this.chargeOrder(tx, orderId, null, items, tax, `Referred by ${payer}`);
  }

  private async chargeOrder(
    tx: Prisma.TransactionClient,
    orderId: number,
    /**
     * Null for referred work.
     *
     * The debtor is the hospital that sent it, not the person whose blood it
     * is — a reference laboratory bills the referring institution, and the
     * patient may never even learn this lab was involved. `Invoice.patientId`
     * is already nullable for the pharmacy walk-in, and this is the second and
     * last reason it is.
     */
    patientId: number | null,
    items: { id: number; testCode: string; testName: string; unitPrice: Prisma.Decimal | null; testId: number | null }[],
    tax: { basis: 'EXCLUSIVE' | 'INCLUSIVE'; rateFor: (id: number | null) => { basisPoints: number; name: string | null; components: { name: string; rateBasisPoints: number }[] } },
    /** Who owes it, when that is not a patient. Printed on the invoice. */
    payerNote?: string,
  ): Promise<{ invoiceId: number | null; unpriced: string[]; total: string | null }> {
    const tenant = await tx.tenant.findUnique({
      where: { id: currentTenantId() },
      select: { labBilling: true },
    });
    const mode = tenant?.labBilling ?? LabBillingMode.SEPARATE;

    const testRows = items.length
      ? await tx.labTest.findMany({
          where: { id: { in: items.map((i) => i.testId).filter((v): v is number => v !== null) } },
          select: { id: true, taxRateId: true },
        })
      : [];
    const taxRateOf = new Map(testRows.map((t) => [t.id, t.taxRateId]));

    const chargeable: ChargeableTest[] = items.map((i) => {
      const rate = tax.rateFor(i.testId !== null ? taxRateOf.get(i.testId) ?? null : null);
      return {
        orderItemId: i.id,
        testCode: i.testCode,
        testName: i.testName,
        priceUnits: toPriceUnits(i.unitPrice === null ? null : toPriceString(i.unitPrice)),
        taxRateBasisPoints: rate.basisPoints,
        taxRateName: rate.name,
        taxComponents: rate.components,
      };
    });

    /*
     * The order's accession travels onto every line it raises, so a billing
     * query and a laboratory query are the same query.
     */
    const order = await tx.labOrder.findUnique({
      where: { id: orderId },
      select: { accession: true },
    });
    const priced: PricedLabCharge = priceTests(chargeable, tax.basis, order?.accession ?? null);
    if (priced.items.length === 0 || priced.totalMinor <= 0) {
      return { invoiceId: null, unpriced: priced.unpriced, total: null };
    }

    /*
     * COMBINED appends to an OPEN hospital invoice only. A settled one is never
     * reopened — appending to a paid invoice is the balance-reappears loop the
     * credit-note work was written to close, so a second invoice is raised.
     */
    /*
     * Referred work never joins a patient's hospital invoice, whatever the
     * billing mode. COMBINED means "one balance for this patient to settle",
     * and the patient is not the payer here — appending would put another
     * company's debt onto somebody's own bill.
     */
    const openHospital =
      mode === LabBillingMode.COMBINED && patientId !== null
        ? await tx.invoice.findFirst({
            where: {
              patientId,
              kind: InvoiceKind.HOSPITAL,
              status: { in: [InvoiceStatus.PENDING, InvoiceStatus.PARTIALLY_PAID] },
            },
            orderBy: { id: 'desc' },
            select: { id: true },
          })
        : null;

    const target = chooseLabInvoice(mode, openHospital?.id ?? null);
    const tenantId = currentTenantId();

    const itemData = priced.items.map((i) => ({
      tenantId,
      description: i.description,
      amount: i.amount,
      kind: LAB_ITEM_KIND,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      taxAmount: i.taxAmount,
      taxRateBasisPoints: i.taxRateBasisPoints,
      taxRateName: i.taxRateName,
      taxBreakdown: i.taxBreakdown ?? undefined,
    }));

    let invoiceId: number;
    if (target.appendToInvoiceId === null) {
      const invoice = await tx.invoice.create({
        data: {
          tenantId,
          patientId,
          kind: target.kind,
          totalAmount: fromMinor(priced.totalMinor),
          // Names the referring hospital where there is no patient to name.
          // Without it a lab invoice with a blank patient is a debt nobody can
          // attribute, which is how referred work goes uncollected.
          notes: payerNote ?? null,
          items: { create: itemData },
        },
        select: { id: true },
      });
      invoiceId = invoice.id;
    } else {
      await tx.invoiceItem.createMany({
        data: itemData.map((i) => ({ ...i, invoiceId: target.appendToInvoiceId as number })),
      });
      const lines = await tx.invoiceItem.findMany({
        where: { invoiceId: target.appendToInvoiceId },
        select: { amount: true, taxAmount: true },
      });
      await tx.invoice.update({
        where: { id: target.appendToInvoiceId },
        data: {
          totalAmount: sumAmounts(
            lines.flatMap((l) => [toMoneyString(l.amount), toMoneyString(l.taxAmount)]),
          ),
        },
      });
      invoiceId = target.appendToInvoiceId;
    }

    await tx.labOrder.update({ where: { id: orderId }, data: { invoiceId } });
    /*
     * `total` is what was actually charged, so the referring hospital's copy of
     * the debt is the same number as the invoice rather than one recomputed
     * from a catalogue at a later moment. Same rule as everything else here:
     * captured, never derived twice.
     */
    return { invoiceId, unpriced: priced.unpriced, total: fromMinor(priced.totalMinor) };
  }

  /**
   * Allocate the next accession number for this hospital, this year.
   *
   * Read-then-write inside the caller's transaction, and retried by the caller
   * on a unique violation rather than locked here. Two receptionists ordering
   * at the same second is the only contention this ever sees, and the unique
   * index is the real guarantee — a table lock to make the read-modify-write
   * atomic would serialise every order in the hospital to protect against
   * something that resolves on one retry.
   *
   * Sequence restarts each year, which is what laboratories do and what makes
   * the number short enough to read aloud. It is scoped by tenant, so two
   * hospitals both having a 26-000412 is expected rather than a collision.
   */
  async nextAccession(tx: Prisma.TransactionClient): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `${String(year % 100).padStart(2, '0')}-`;

    const latest = await tx.labOrder.findFirst({
      where: { tenantId: currentTenantId(), accession: { startsWith: prefix } },
      orderBy: { accession: 'desc' },
      select: { accession: true },
    });

    /*
     * Parsed out of the string rather than counted with `count()`. A count is
     * wrong the moment anything is ever deleted or an order is raised out of
     * order, and it would silently reissue a number that is already printed on
     * a tube somewhere.
     */
    const previous = latest?.accession ? Number(latest.accession.slice(3, 9)) : 0;
    return formatAccession(year, previous + 1);
  }

  /**
   * Raise the charge for an order that never got one.
   *
   * WHY THIS HAD TO EXIST
   * ---------------------
   * `chargeOrder` raises nothing when every line is unpriced, which is right —
   * a test with no price is performed and not billed, and blank is not zero.
   * Both order screens warn about it, and the notice said *"an administrator
   * sets a price under Lab Tests, and the charge can be raised afterwards"*.
   *
   * **There was no way to raise it afterwards.** The price is captured on the
   * order item at ordering, so pricing the catalogue later fixes the next order
   * and not this one, and nothing anywhere could re-read it. A message
   * promising a capability the product does not have is the sixth instance of
   * the shape this file keeps recording, and this time I wrote the message.
   *
   * Reported from use: a test sent to a partner under ORIGIN_PAYS, the
   * laboratory's bill arriving, and no invoice for the patient at this end.
   *
   * WHAT IT DOES
   * ------------
   * Re-reads today's catalogue price onto any item that has none, then charges
   * exactly as ordering would have. Only for an order that raised **no invoice
   * at all** — appending to one that exists, and may have been paid, is the
   * balance-reappears loop the credit-note work was written to close.
   */
  async raiseCharge(id: number, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id },
      select: {
        id: true,
        patientId: true,
        invoiceId: true,
        accession: true,
        items: {
          select: {
            id: true,
            testId: true,
            testCode: true,
            testName: true,
            unitPrice: true,
            payableExternally: true,
          },
        },
        referral: { select: { billing: true, sourceTenantName: true, sourceAccession: true } },
      },
    });
    if (!order) throw new NotFoundException('No such order');

    if (order.invoiceId) {
      throw new ConflictException(
        'That order already has an invoice. Add a line to it on the till rather than raising a second one.',
      );
    }

    /*
     * Never re-price something somebody else is charging for. Under
     * PATIENT_PAYS, and for a named external laboratory, this hospital
     * deliberately raised no line — "not ours to charge" is not "nobody
     * charged", and turning one into the other here would bill the patient
     * twice for one investigation.
     */
    const ours = order.items.filter((i) => !i.payableExternally);
    if (ours.length === 0) {
      throw new ConflictException(
        'Nothing on that order is ours to charge — the patient pays whoever runs the tests.',
      );
    }

    const missing = ours.filter((i) => i.unitPrice === null && i.testId !== null);
    const prices = missing.length
      ? await this.prisma.labTest.findMany({
          where: { id: { in: missing.map((i) => i.testId as number) } },
          select: { id: true, sellingPrice: true },
        })
      : [];
    const priceOf = new Map(prices.map((t) => [t.id, t.sellingPrice]));

    const tax = await this.tax.current();

    return this.prisma.$transaction(async (tx) => {
      /*
       * Captured onto the item, exactly as ordering does. The alternative —
       * reading the catalogue at invoice time — is the `medicineName`-as-FK
       * trap: repricing next year would restate what this patient was charged
       * today.
       */
      for (const item of missing) {
        const price = priceOf.get(item.testId as number) ?? null;
        if (price === null) continue;
        await tx.labOrderItem.update({ where: { id: item.id }, data: { unitPrice: price } });
      }

      const items = await tx.labOrderItem.findMany({
        where: { orderId: id, payableExternally: false },
        select: { id: true, testCode: true, testName: true, unitPrice: true, testId: true },
      });

      /*
       * The same payer the accession would have chosen. A referred order is
       * billed to the institution or to the patient exactly as
       * `chargeReferredOrder` decides; a local one is the patient's.
       */
      const referral = order.referral;
      const charge =
        referral && referral.billing === ReferralBilling.ORIGIN_PAYS
          ? await this.chargeOrder(
              tx,
              id,
              null,
              items,
              tax,
              referral.sourceAccession
                ? `${referral.sourceTenantName} · ${referral.sourceAccession}`
                : referral.sourceTenantName,
            )
          : await this.chargeOrder(tx, id, order.patientId, items, tax);

      if (charge.invoiceId === null) {
        /*
         * Still nothing priced. Named rather than reported as success — an
         * action that says it worked and raised no invoice is how the original
         * problem went unnoticed.
         */
        throw new ConflictException(
          `Still no price for ${charge.unpriced.join(', ') || 'these tests'}. Set one in the catalogue first.`,
        );
      }

      return { orderId: id, invoiceId: charge.invoiceId, unpriced: charge.unpriced };
    });
  }

  /**
   * Give an order a specimen number if it has not got one.
   *
   * WHY THIS EXISTS AS WELL AS ALLOCATION AT ORDERING
   * -------------------------------------------------
   * Orders raised before accessions existed have none, and the migration
   * deliberately does not backfill them — inventing a number for a record that
   * never had a label printed would put a number on a tube nobody can find.
   *
   * But *"no specimen no."* forever, with no way to obtain one, is the failure
   * this project has had to reopen six times: a refusal the system names and
   * nobody can satisfy. Reported straight away — every existing order showed
   * it and there was no route out of that state from anywhere in the product.
   *
   * So a number is allocated the first time anybody actually needs one: when
   * the specimen is taken, and when a label is printed. Both are the moment a
   * physical tube comes into existence, which is precisely when the number
   * starts to mean something.
   *
   * New orders still get one at ordering, because **the label has to be
   * printed before the draw** — you stick it on the tube at the bedside, so
   * the number cannot wait for collection to be recorded.
   */
  async ensureAccession(id: number): Promise<string> {
    const existing = await this.prisma.labOrder.findUnique({
      where: { id },
      select: { accession: true },
    });
    if (existing?.accession) return existing.accession;

    /*
     * Retried on the unique index rather than locked, exactly as allocation at
     * ordering is. Two technicians collecting at the same second is the only
     * contention this sees, and one retry resolves it.
     */
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const accession = await this.nextAccession(tx);
          await tx.labOrder.update({ where: { id }, data: { accession } });
          return accession;
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }

    throw new ConflictException('Could not allocate a specimen number — please try again');
  }

  /**
   * Find an order by the number on the tube.
   *
   * The check character is verified **before** the database is asked. A
   * mistyped number that happens to resolve to another specimen looks exactly
   * like a correct one, so the cheap refusal has to come first — that is the
   * whole reason the accession carries a check character at all.
   */
  async byAccession(raw: string, user: AuthUser) {
    const accession = normaliseAccession(raw);

    if (!isValidAccession(accession)) {
      /*
       * Shows the *normalised* value, not the raw one.
       *
       * "26-00003-G is not valid" sends a technician back to a label that says
       * something very close to it, hunting for a difference. Naming the shape
       * expected is what lets them see which character is wrong — and after the
       * padding fix above, anything still refused here is a real disagreement
       * rather than a typing convention.
       */
      throw new BadRequestException(
        `${accession} is not a valid specimen number. They look like 26-000412-K — check it against the label.`,
      );
    }

    const order = await this.prisma.labOrder.findFirst({
      where: { accession },
      select: { id: true },
    });
    if (!order) throw new NotFoundException(`No specimen here with the number ${accession}`);

    return this.orderDetail(order.id, user);
  }

  // ── statements ───────────────────────────────────────────────────────────

  /**
   * The most lines a statement will carry.
   *
   * Every query here had `take: 2000` and nothing said when it bit. A period
   * wide enough to exceed it produced a page that looked complete, with a total
   * short by however much was cut — a wrong number on a financial document that
   * a reader has no way to spot. Silent truncation was survivable while the
   * period was always a month; a range picker makes "the last two years" one
   * click away.
   *
   * So the rows are counted first and the request is refused with the figure,
   * which is a period somebody can narrow. Raising the cap instead moves the
   * cliff without removing it, and a statement of five thousand lines is not a
   * document anybody posts.
   */
  private static readonly MAX_STATEMENT_LINES = 2000;

  /**
   * Refuse rather than quietly drop the tail.
   *
   * Called with one row more than the cap fetched, so a full page is
   * distinguishable from an overflowing one — asking for exactly the cap and
   * getting it tells you nothing about what came after.
   */
  private refuseOversizedPeriod(fetched: number, label: string): void {
    if (fetched <= LabService.MAX_STATEMENT_LINES) return;
    throw new BadRequestException(
      `${label} holds more than ${LabService.MAX_STATEMENT_LINES} lines. Choose a shorter period — a statement longer than that is not one anybody can check.`,
    );
  }

  /**
   * Resolve a period into a hospital-local range, defaulting to this month.
   *
   * THREE WAYS TO ASK, AND THE MONTH IS THE SHORTHAND
   * -------------------------------------------------
   * `?from=&to=` is the general form: any span of hospital-local days, which is
   * what referral agreements actually use — weekly, ten-day and fortnightly
   * cycles are all ordinary, and none of them is expressible as a month.
   * Reported by the product owner exactly that way.
   *
   * `?month=` stays because a calendar month is the commonest arrangement and
   * one parameter is better than two for it. Nothing is lost: it expands to the
   * same range, and the label still reads *September 2026* rather than
   * *1–30 September 2026*, because the shortest true description of a period is
   * the one both parties quote back correctly.
   *
   * Neither: this month, resolved on the server. A client computing "now" a
   * second apart from the server across a month boundary asks for the wrong
   * period, which is why the screens send back what this returns.
   *
   * THE HOSPITAL'S DAYS, NEVER UTC'S
   * --------------------------------
   * A referral accessioned at 23:40 on the 30th in Asia/Kolkata is already the
   * 1st in UTC, and bucketing on the stored instant posts it onto the wrong
   * statement — the number somebody reconciles against a bank transfer. Both
   * boundaries go through `hospitalDayRange` for that reason, and the anchors
   * are noon rather than midnight so the day asked for is the day resolved.
   */
  private async statementPeriod(period?: { month?: string; from?: string; to?: string }) {
    const settings = await this.clinic.current();
    const tz = settings.timezone;

    if (period?.from || period?.to) {
      /*
       * Both or neither. One end of a range is not a range, and guessing the
       * other — "from there until today", "the start of that month" — is a
       * boundary the caller did not choose on a document about money.
       */
      if (!period.from || !period.to) {
        throw new BadRequestException('A period needs both a start and an end date');
      }

      const from = parseDateKey(period.from);
      const to = parseDateKey(period.to);
      if (!from || !to) {
        throw new BadRequestException(
          `${period.from} to ${period.to} is not a period. Dates look like 2026-09-01`,
        );
      }

      /*
       * Constructed, never anchored. `zonedTimeToUtc` turns a wall-clock date
       * in the hospital's zone into the instant that day began; the end is the
       * start of the day *after* the last one, so the range is [start, end)
       * like every other range in this system and a referral accessioned at
       * 23:59 on the final day is inside it.
       *
       * The mirror of `monthAnchor` — noon UTC on the day — is wrong here and
       * its own test caught it: at UTC+14 noon on the 15th is already the 16th.
       * A month has thirty days of slack; a single day has none.
       */
      const start = zonedTimeToUtc(from, tz);
      const end = zonedTimeToUtc(nextDay(to), tz);

      if (end <= start) {
        // Named rather than silently swapped: somebody who typed the dates the
        // wrong way round should see that, not a statement they did not ask for.
        throw new BadRequestException('The period ends before it starts');
      }

      /*
       * A whole calendar month asked for as a range still reads as a month.
       * Somebody picking 1–30 September from the date fields means September,
       * and a page headed *1–30 September 2026* invites the reader to wonder
       * what happened to the 31st.
       */
      const monthRange = hospitalMonthRange(start, tz);
      const wholeMonth =
        start.getTime() === monthRange.start.getTime() &&
        end.getTime() === monthRange.end.getTime();

      return {
        start,
        end,
        from: formatDateKey(from),
        to: formatDateKey(to),
        label: periodLabel(from, to, wholeMonth),
      };
    }

    const key = period?.month ? parseMonthKey(period.month) : null;
    if (period?.month && !key) {
      throw new BadRequestException(`${period.month} is not a month. They look like 2026-09`);
    }

    const anchor = key ? monthAnchor(key) : new Date();
    const { start, end } = hospitalMonthRange(anchor, tz);
    const resolved = key ?? parseMonthKey(hospitalMonthKey(anchor, tz))!;

    /*
     * The resolved boundaries travel back as dates even for a month, so a
     * client has one shape to hold and to send when it asks for the printed
     * page. `end` is exclusive here and the last *day* is what a person means,
     * so it steps back one millisecond before being named.
     */
    const lastDay = new Date(end.getTime() - 1);
    return {
      start,
      end,
      from: formatDateKey(hospitalDate(start, tz)),
      to: formatDateKey(hospitalDate(lastDay, tz)),
      label: monthLabel(resolved),
    };
  }

  /**
   * What this laboratory is billing each referring hospital for one month.
   *
   * WHY THIS IS NOT JUST THE INVOICE LIST FILTERED
   * ----------------------------------------------
   * `GET /lab/invoices?payer=institution` already answers "which institutional
   * invoices exist". It does not answer the question a laboratory actually has
   * at the end of a month, which is *what do we send Meridian Clinic* — and
   * making somebody read forty rows and add up the ones with the right name in
   * `notes` is how that gets answered wrongly.
   *
   * Grouped on `LabReferral.sourceTenantId` rather than on the hospital's name.
   * The name is denormalised onto the referral so a statement still reads
   * correctly after a rename, and grouping on it would split one hospital's
   * month in two the day they change it.
   *
   * NO TEST NAMES, ANYWHERE ON THIS. A count of tests and the specimen numbers,
   * and nothing that says what was investigated — the same rule the payable
   * notice and `labSummaryDescription` follow, and it matters more here because
   * a statement is a document that leaves the building and gets filed by
   * whoever opens the post.
   */
  async statements(period?: StatementPeriodQuery) {
    const resolved = await this.statementPeriod(period);

    const orders = await this.prisma.labOrder.findMany({
      where: {
        referralId: { not: null },
        /*
         * Institutional invoices only. Under PATIENT_PAYS the patient settles
         * at this counter and the referring hospital owes nothing, so putting
         * that work on their statement would invoice them for money somebody
         * else already handed over — `patientId: null` is the same test
         * `?payer=institution` uses, and it is the one that distinguishes the
         * two arrangements.
         */
        invoice: {
          is: { patientId: null, issuedAt: { gte: resolved.start, lt: resolved.end } },
        },
      },
      select: {
        accession: true,
        _count: { select: { items: true } },
        invoice: {
          select: {
            id: true,
            issuedAt: true,
            totalAmount: true,
            amountPaid: true,
            creditedAmount: true,
          },
        },
        referral: {
          select: {
            sourceTenantId: true,
            sourceTenantName: true,
            sourceAccession: true,
            reference: true,
          },
        },
      },
      orderBy: { orderedAt: 'asc' },
      take: LabService.MAX_STATEMENT_LINES + 1,
    });

    this.refuseOversizedPeriod(orders.length, resolved.label);

    const usable = orders.filter(
      (o): o is typeof o & { invoice: NonNullable<typeof o.invoice>; referral: NonNullable<typeof o.referral> } =>
        o.invoice !== null && o.referral !== null,
    );

    const data = [...groupBy(usable, (o) => o.referral.sourceTenantId).entries()]
      .map(([sourceTenantId, rows]) => {
        /*
         * Minor units throughout, and outstanding is charge minus credits minus
         * payments — never `total - paid`, which is the arithmetic that made a
         * refund reopen a balance nobody was chasing.
         */
        let totalMinor = 0;
        let paidMinor = 0;
        let creditedMinor = 0;

        for (const row of rows) {
          totalMinor += toMinor(toMoneyString(row.invoice.totalAmount));
          paidMinor += toMinor(toMoneyString(row.invoice.amountPaid));
          creditedMinor += toMinor(toMoneyString(row.invoice.creditedAmount));
        }

        return {
          sourceTenantId,
          /** Denormalised on the referral, so a rename cannot restate history. */
          hospital: rows[0].referral.sourceTenantName,
          referrals: rows.length,
          tests: rows.reduce((n, r) => n + r._count.items, 0),
          total: fromMinor(totalMinor),
          paid: fromMinor(paidMinor),
          credited: fromMinor(creditedMinor),
          outstanding: fromMinor(totalMinor - creditedMinor - paidMinor),
          settled: totalMinor - creditedMinor - paidMinor <= 0,
        };
      })
      /* Biggest first — the statement worth chasing is at the top. */
      .sort((a, b) => toMinor(b.outstanding) - toMinor(a.outstanding));

    return {
      from: resolved.from,
      to: resolved.to,
      label: resolved.label,
      data,
      total: sumAmounts(data.map((d) => d.total)),
      outstanding: sumAmounts(data.map((d) => d.outstanding)),
    };
  }

  /**
   * One hospital's statement, itemised by referral.
   *
   * The rows are what the printed page carries, and each one names **both**
   * accessions: ours, which is what our own records are keyed on, and theirs,
   * which is the only number the recipient can match against anything. A
   * statement quoting only the issuer's numbers is one the payer has to
   * telephone about, which defeats the point of sending it.
   */
  async statement(sourceTenantId: number, period?: StatementPeriodQuery) {
    const resolved = await this.statementPeriod(period);

    const orders = await this.prisma.labOrder.findMany({
      where: {
        referral: { is: { sourceTenantId } },
        invoice: {
          is: { patientId: null, issuedAt: { gte: resolved.start, lt: resolved.end } },
        },
      },
      select: {
        id: true,
        accession: true,
        orderedAt: true,
        _count: { select: { items: true } },
        invoice: {
          select: {
            id: true,
            issuedAt: true,
            totalAmount: true,
            amountPaid: true,
            creditedAmount: true,
          },
        },
        referral: {
          select: { sourceTenantName: true, sourceAccession: true, reference: true },
        },
      },
      orderBy: { orderedAt: 'asc' },
      take: LabService.MAX_STATEMENT_LINES + 1,
    });

    this.refuseOversizedPeriod(orders.length, resolved.label);

    if (orders.length === 0) {
      /*
       * Refused rather than returned empty, and it names the month. An empty
       * statement and a wrong month look identical on a page, and only one of
       * them means "we did no work for you" — which is a thing somebody might
       * post to a hospital that sent forty samples.
       */
      throw new NotFoundException(
        `Nothing was billed to that hospital in ${resolved.label}`,
      );
    }

    let totalMinor = 0;
    let paidMinor = 0;
    let creditedMinor = 0;

    const lines = orders.map((o) => {
      const total = toMinor(toMoneyString(o.invoice!.totalAmount));
      const paid = toMinor(toMoneyString(o.invoice!.amountPaid));
      const credited = toMinor(toMoneyString(o.invoice!.creditedAmount));
      totalMinor += total;
      paidMinor += paid;
      creditedMinor += credited;

      return {
        invoiceId: o.invoice!.id,
        issuedAt: o.invoice!.issuedAt,
        /** Our number for the specimen. */
        accession: o.accession,
        /** Theirs, so the recipient can match the line to their own order. */
        sourceAccession: o.referral!.sourceAccession,
        reference: o.referral!.reference,
        /* A count. Never a test name — this page leaves the building. */
        tests: o._count.items,
        amount: fromMinor(total),
        outstanding: fromMinor(total - credited - paid),
      };
    });

    return {
      from: resolved.from,
      to: resolved.to,
      label: resolved.label,
      sourceTenantId,
      hospital: orders[0].referral!.sourceTenantName,
      lines,
      referrals: lines.length,
      tests: lines.reduce((n, l) => n + l.tests, 0),
      total: fromMinor(totalMinor),
      paid: fromMinor(paidMinor),
      credited: fromMinor(creditedMinor),
      outstanding: fromMinor(totalMinor - creditedMinor - paidMinor),
    };
  }

  /**
   * The other side of the same page: what we owe each partner laboratory.
   *
   * Read from `PartnerLabCharge` — the notices they wrote into our scope on
   * accession — and grouped by partner and month so the statement that arrives
   * in the post can be checked against our own records line by line. That is
   * the whole point: two independently-kept sets of rows agreeing is worth far
   * more than one party's figure taken on trust.
   *
   * Nothing here moves money, and marking a month settled is exactly what
   * marking each of its rows settled has always been — reversible, writing no
   * `Payment`, because takings are counted from that table and this money never
   * passed through a till.
   */
  async partnerStatements(period?: StatementPeriodQuery) {
    const resolved = await this.statementPeriod(period);

    const rows = await this.prisma.partnerLabCharge.findMany({
      where: { incurredAt: { gte: resolved.start, lt: resolved.end } },
      orderBy: { incurredAt: 'asc' },
      take: LabService.MAX_STATEMENT_LINES + 1,
      include: { settledBy: { select: { fullName: true } } },
    });

    this.refuseOversizedPeriod(rows.length, resolved.label);

    const data = [...groupBy(rows, (r) => r.partnerTenantId).entries()].map(
      ([partnerTenantId, group]) => {
        const outstanding = group.filter((r) => r.settledAt === null);
        return {
          partnerTenantId,
          partnerName: group[0].partnerName,
          referrals: group.length,
          tests: group.reduce((n, r) => n + r.testCount, 0),
          total: sumAmounts(group.map((r) => r.amount)),
          outstandingCount: outstanding.length,
          outstanding: sumAmounts(outstanding.map((r) => r.amount)),
          settled: outstanding.length === 0,
          lines: group.map((r) => ({
            id: r.id,
            reference: r.reference,
            /** Our order number, so the line is auditable from our own records. */
            sourceAccession: r.sourceAccession,
            amount: r.amount.toFixed(2),
            testCount: r.testCount,
            incurredAt: r.incurredAt,
            settledAt: r.settledAt,
            settledBy: r.settledBy?.fullName ?? null,
            settledNote: r.settledNote,
          })),
        };
      },
    );

    return {
      from: resolved.from,
      to: resolved.to,
      label: resolved.label,
      data,
      total: sumAmounts(data.map((d) => d.total)),
      outstanding: sumAmounts(data.map((d) => d.outstanding)),
    };
  }

  /**
   * Mark one partner's month dealt with, in one act.
   *
   * The alternative is ticking forty rows, and the realistic outcome of that is
   * thirty-nine ticked — a month that reads as part-settled when the transfer
   * covered all of it. Every row is written individually underneath, so the
   * per-row Undo still works and nothing new has to be reconciled.
   *
   * Only rows already in that month are touched, and a row that is already
   * settled is left exactly as it was — including who settled it and when,
   * which is the fact a bulk update is most likely to quietly overwrite.
   */
  async settlePartnerMonth(
    partnerTenantId: number,
    period: StatementPeriodQuery | undefined,
    user: AuthUser,
    settled: boolean,
    note?: string,
  ) {
    const resolved = await this.statementPeriod(period);

    const rows = await this.prisma.partnerLabCharge.findMany({
      where: {
        partnerTenantId,
        incurredAt: { gte: resolved.start, lt: resolved.end },
        settledAt: settled ? null : { not: null },
      },
      select: { id: true },
    });

    if (rows.length === 0) {
      throw new ConflictException(
        settled
          ? `Nothing is outstanding for that laboratory in ${resolved.label}`
          : `Nothing is marked settled for that laboratory in ${resolved.label}`,
      );
    }

    await this.prisma.partnerLabCharge.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: settled
        ? { settledAt: new Date(), settledById: user.userId, settledNote: note?.trim() || null }
        : { settledAt: null, settledById: null, settledNote: null },
    });

    return { partnerTenantId, from: resolved.from,
      to: resolved.to, changed: rows.length, settled };
  }

  // ── shaping ──────────────────────────────────────────────────────────────

  /**
   * Derive the order's status from its items.
   *
   * Derived rather than set, for the same reason a prescription's is: a
   * requisition with one of three tests resulted is not RESULTED, and assuming
   * otherwise would take it out of the worklist with work still on the bench.
   */
  private async deriveStatus(
    tx: Prisma.TransactionClient,
    orderId: number,
  ): Promise<LabOrderStatus> {
    const items = await tx.labOrderItem.findMany({
      where: { orderId },
      select: { resultedAt: true },
    });
    if (items.length === 0) return LabOrderStatus.COLLECTED;
    if (items.every((i) => i.resultedAt !== null)) return LabOrderStatus.RESULTED;
    return LabOrderStatus.IN_PROGRESS;
  }

  private analyteData(a: {
    name: string;
    unit?: string | null;
    refLow?: string | null;
    refHigh?: string | null;
    refText?: string | null;
    criticalLow?: string | null;
    criticalHigh?: string | null;
    position?: number;
  }, index: number) {
    return {
      name: a.name.trim(),
      unit: a.unit?.trim() || null,
      refLow: a.refLow ? new Prisma.Decimal(a.refLow) : null,
      refHigh: a.refHigh ? new Prisma.Decimal(a.refHigh) : null,
      refText: a.refText?.trim() || null,
      criticalLow: a.criticalLow ? new Prisma.Decimal(a.criticalLow) : null,
      criticalHigh: a.criticalHigh ? new Prisma.Decimal(a.criticalHigh) : null,
      position: a.position ?? index,
    };
  }

  private toTestResponse(t: {
    id: number;
    code: string;
    name: string;
    category: string;
    specimenType: string;
    sellingPrice: Prisma.Decimal | null;
    taxRateId: number | null;
    turnaroundHours: number | null;
    preparation: string | null;
    isActive: boolean;
    analytes?: {
      id: number;
      name: string;
      unit: string | null;
      refLow: Prisma.Decimal | null;
      refHigh: Prisma.Decimal | null;
      refText: string | null;
      criticalLow: Prisma.Decimal | null;
      criticalHigh: Prisma.Decimal | null;
      position: number;
    }[];
  }) {
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      category: t.category,
      specimenType: t.specimenType,
      // Null, never "0.00". Blank means unpriced and the screens say so.
      sellingPrice: t.sellingPrice === null ? null : toPriceString(t.sellingPrice),
      taxRateId: t.taxRateId,
      turnaroundHours: t.turnaroundHours,
      preparation: t.preparation,
      isActive: t.isActive,
      analytes: (t.analytes ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        unit: a.unit,
        refLow: a.refLow === null ? null : toMoneyString(a.refLow),
        refHigh: a.refHigh === null ? null : toMoneyString(a.refHigh),
        refText: a.refText,
        criticalLow: a.criticalLow === null ? null : toMoneyString(a.criticalLow),
        criticalHigh: a.criticalHigh === null ? null : toMoneyString(a.criticalHigh),
        position: a.position,
        /** Pre-formatted so every client prints the range identically. */
        display: formatRange(
          {
            refLow: numberOrNull(a.refLow),
            refHigh: numberOrNull(a.refHigh),
            refText: a.refText,
            criticalLow: numberOrNull(a.criticalLow),
            criticalHigh: numberOrNull(a.criticalHigh),
          },
          a.unit,
        ),
      })),
    };
  }

  private toWorklistRow(r: {
    id: number;
    status: LabOrderStatus;
    priority: string;
    orderedAt: Date;
    collectedAt: Date | null;
    rejectReason: string | null;
    clinicalDetails: string | null;
    patient: { id: number; fullName: string; dob: Date; gender: string };
    doctor: { fullName: string } | null;
    referral?: {
      requestedByName: string;
      sourceTenantName?: string;
      resultedAt?: Date | null;
      declinedAt?: Date | null;
    } | null;
    items: {
      id: number;
      testCode: string;
      testName: string;
      category: string;
      specimenType: string;
      resultedAt: Date | null;
      criticalNotifiedAt: Date | null;
      values: { flag: LabResultFlag }[];
    }[];
    accession: string | null;
    invoiceId: number | null;
    invoice: {
      id: number;
      status: InvoiceStatus;
      totalAmount: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
      creditedAmount: Prisma.Decimal;
    } | null;
    destination: LabOrderDestination;
    dispatchedAt: Date | null;
  }) {
    return {
      id: r.id,
      /** The number on the tube. Null only for orders raised before it existed. */
      accession: r.accession,
      /**
       * The charge raised for it. Null means none was — every line unpriced —
       * and that is the one state the worklist offers an action for, because
       * the price is captured at ordering and nothing else can reach back.
       */
      invoiceId: r.invoiceId,
      /**
       * The charge, and whether it has actually been paid.
       *
       * `outstanding` is the charge minus credits minus payments — never
       * `total - paid`, which is the arithmetic that made a refund reopen a
       * balance nobody was chasing. `settled` is derived from it rather than
       * from `status`, because a part-paid invoice and a fully paid one carry
       * different statuses and the question here is only "is there anything
       * left to collect".
       *
       * **A link, never a gate.** Nothing in collection, dispatch or resulting
       * looks at this — the same rule `lab-billing.spec.ts` and
       * `consultation-billing.spec.ts` assert the absence of. It exists so the
       * person holding the tube can take the money if the patient is there,
       * and the tube is drawn either way.
       */
      invoice:
        r.invoice === null
          ? null
          : (() => {
              const outstandingMinor =
                toMinor(toMoneyString(r.invoice.totalAmount)) -
                toMinor(toMoneyString(r.invoice.creditedAmount)) -
                toMinor(toMoneyString(r.invoice.amountPaid));
              return {
                id: r.invoice.id,
                status: r.invoice.status,
                outstanding: fromMinor(outstandingMinor),
                settled: outstandingMinor <= 0,
              };
            })(),
      /** Where it is going, so the send-out list can say so on the row. */
      destination: r.destination,
      /** When the tube left for the partner. Null while it is still here. */
      dispatchedAt: r.dispatchedAt,
      status: r.status,
      priority: r.priority,
      orderedAt: r.orderedAt,
      collectedAt: r.collectedAt,
      rejectReason: r.rejectReason,
      clinicalDetails: r.clinicalDetails,
      /*
       * The lab sees who and how old, and nothing else clinical. Age and sex
       * are not decoration here — reference ranges are banded by both, so a
       * result cannot be interpreted without them.
       */
      patient: {
        id: r.patient.id,
        fullName: r.patient.fullName,
        dob: r.patient.dob,
        gender: r.patient.gender,
      },
      /*
       * Null for referred work — see `LabOrder.doctorId`. The requester is a
       * clinician at another company, whose name travels on the referral.
       */
      requestedBy: r.doctor?.fullName ?? r.referral?.requestedByName ?? 'Referring hospital',
      /**
       * Work another hospital sent us, and whether they have the answer yet.
       *
       * `referredFrom` is null for this hospital's own orders, which is what
       * makes the pair readable: null means the question does not apply, false
       * means it applies and the answer is no. Collapsing them into a boolean
       * would make every local order look like a failed transmission.
       *
       * `reportedBack` is read from `LabReferral.resultedAt`, which is written
       * only after the cross-tenant write commits — so it cannot say yes about
       * something that did not arrive.
       */
      referredFrom: r.referral?.sourceTenantName ?? null,
      reportedBack: r.referral ? r.referral.resultedAt !== null : null,
      items: r.items.map((i) => ({
        id: i.id,
        testCode: i.testCode,
        testName: i.testName,
        category: i.category,
        specimenType: i.specimenType,
        resultedAt: i.resultedAt,
        criticalNotifiedAt: i.criticalNotifiedAt,
        hasCritical: i.values.some((v) => isCritical(v.flag)),
      })),
    };
  }

  /**
   * An order as a clinician sees it.
   *
   * **Values are withheld until the report is authorised**, and the response
   * says which it is rather than returning an empty list. An unverified result
   * that renders as "no values" is indistinguishable from a test that found
   * nothing, and that is the most dangerous available misreading — the same
   * argument as `allergyChecked` on a referral.
   */
  private toOrderResponse(
    r: {
      id: number;
      status: LabOrderStatus;
      priority: string;
      destination: LabOrderDestination;
      orderedAt: Date;
      collectedAt: Date | null;
      verifiedAt: Date | null;
      externalVerifiedBy: string | null;
      cancelledAt: Date | null;
      cancelReason: string | null;
      rejectedAt: Date | null;
      accession: string | null;
      rejectReason: string | null;
      clinicalDetails: string | null;
      doctor: { fullName: string } | null;
    referral?: { requestedByName: string } | null;
      items: {
        id: number;
        testCode: string;
        testName: string;
        category: string;
        specimenType: string;
        payableExternally: boolean;
        findings: string | null;
        impression: string | null;
        methodology: string | null;
        resultedAt: Date | null;
        performedByName: string | null;
        criticalNotifiedAt: Date | null;
        criticalNotifiedTo: string | null;
        values: {
          id: number;
          analyteName: string;
          unit: string | null;
          value: string;
          referenceRange: string | null;
          flag: LabResultFlag;
          position: number;
        }[];
      }[];
    },
    user: AuthUser,
  ) {
    const authorised = r.status === LabOrderStatus.VERIFIED;
    /*
     * The lab sees its own work in progress, because it is the lab's work.
     * Everybody else waits for authorisation.
     */
    const mayReadUnverified = user.role === 'LAB_TECHNICIAN';
    const showValues = authorised || mayReadUnverified;

    return {
      id: r.id,
      /**
       * The number on the tube, and the one thing on this response a scanner
       * produces. Null only for orders raised before accessions existed —
       * stated as absent rather than filled in with the row id, which would
       * print a label nobody can find a specimen for.
       */
      accession: r.accession,
      status: r.status,
      priority: r.priority,
      destination: r.destination,
      orderedAt: r.orderedAt,
      collectedAt: r.collectedAt,
      verifiedAt: r.verifiedAt,
      cancelledAt: r.cancelledAt,
      cancelReason: r.cancelReason,
      rejectedAt: r.rejectedAt,
      rejectReason: r.rejectReason,
      clinicalDetails: r.clinicalDetails,
      /*
       * Null for referred work — see `LabOrder.doctorId`. The requester is a
       * clinician at another company, whose name travels on the referral.
       */
      requestedBy: r.doctor?.fullName ?? r.referral?.requestedByName ?? 'Referring hospital',
      /** Explicit, so a screen never has to infer it from an empty array. */
      resultsAuthorised: authorised,
      items: r.items.map((i) => ({
        id: i.id,
        testCode: i.testCode,
        testName: i.testName,
        category: i.category,
        specimenType: i.specimenType,
        /*
         * This hospital deliberately raised no charge, because whoever runs
         * the test is billing the patient directly.
         *
         * Sent as its own field rather than inferred from a missing invoice
         * line, and both clients say *payable at the laboratory* rather than
         * leaving a blank. A blank and a considered decision render identically
         * — which is the reasoning behind `unpricedTests`, `allergyChecked` and
         * *quantity not calculated*, and it is the same mistake every time.
         */
        payableExternally: i.payableExternally,
        resultedAt: i.resultedAt,
        performedByName: i.performedByName,
        criticalNotifiedAt: i.criticalNotifiedAt,
        criticalNotifiedTo: i.criticalNotifiedTo,
        findings: showValues ? i.findings : null,
        impression: showValues ? i.impression : null,
        methodology: showValues ? i.methodology : null,
        values: showValues
          ? i.values.map((v) => ({
              id: v.id,
              analyteName: v.analyteName,
              unit: v.unit,
              value: v.value,
              referenceRange: v.referenceRange,
              flag: v.flag,
              abnormal: isAbnormal(v.flag),
              critical: isCritical(v.flag),
            }))
          : [],
      })),
    };
  }
}

function numberOrNull(d: Prisma.Decimal | null): number | null {
  return d === null ? null : Number(d);
}

function decimalOrNull(n: number | null): Prisma.Decimal | null {
  return n === null ? null : new Prisma.Decimal(n);
}
