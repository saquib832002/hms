import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdmissionStatus,
  AppointmentStatus,
  AuditOutcome,
  InvoiceKind,
  InvoiceStatus,
  LabOrderStatus,
  PaymentMethod,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  hospitalDayRange,
  hospitalMonthKey,
  hospitalMonthRange,
  parseDateParam,
  recentMonths,
} from '../common/utils/hospital-time';
import { fromMinor, sumMinor, toMinor, toMoneyString } from '../billing/money';
import { buildAgingReport } from '../billing/aging';
import { AGEABLE_INVOICE_KINDS } from '../billing/invoice-response';
import {
  ACTIVITY_ACTIONS,
  collectedSince,
  collectionsByStaff,
  countActions,
  countWorkload,
  methodSplit,
  minorOf,
  monthlyTotals,
  revenueByDoctor,
  toLedgerRow,
  type ReportablePayment,
} from './reports';
import { decimalToMinor, revenueByStream, streamNamed } from './revenue-streams';
import { resolvePeriod, type PeriodQuery } from '../common/utils/resolve-period';
import { patientActivity } from './patient-activity';
import {
  breakdownByDestination,
  owedToPartners,
  referredBilling,
} from './referrals-out';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';
import {
  ALLOWED_SLOT_MINUTES,
  describeClinic,
  slotsPerDay,
  validateClinicSettings,
} from '../common/tenancy/clinic-settings';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { UpdateClinicSettingsDto } from './dto/clinic-settings.dto';

/**
 * Operational reporting for administrators.
 *
 * WHAT AN ADMIN DELIBERATELY CANNOT SEE HERE
 * ------------------------------------------
 * Aggregates only. Counts, sums, percentages — never a patient row, never a
 * diagnosis, never a medicine name, and no breakdown fine enough to pick an
 * individual out of.
 *
 * That is a real constraint, not a stylistic one. `CLAUDE.md` puts ADMIN
 * outside clinical access, and a "report" is the obvious back door: nobody
 * questions a management dashboard, and "occupancy by diagnosis" sounds like
 * operations while being a list of who has what. So the aggregates below are
 * restricted to things that carry no clinical meaning — how many appointments,
 * how many beds, how much money, how many failed logins.
 *
 * Small-cell disclosure is worth naming too: "1 patient in Ward B" identifies
 * someone if the ward has one patient. Nothing here breaks down by ward *and*
 * anything clinical, which keeps that from arising — but it is the trap to
 * watch if this is ever extended.
 */
@Injectable()
export class AdminService {
  constructor(
    private clinic: ClinicSettingsService,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /** The caller's own clinic day, plus what the UI needs to render a form. */
  async clinicSettings() {
    const settings = await this.clinic.current();
    return {
      ...settings,
      // Derived, so the screen can warn before saving rather than after: going
      // from 30- to 5-minute slots multiplies a doctor's bookable day by six.
      slotsPerDoctorPerDay: slotsPerDay(settings),
      summary: describeClinic(settings),
      allowedSlotMinutes: [...ALLOWED_SLOT_MINUTES],
    };
  }

  /**
   * Change this hospital's clinic day.
   *
   * Scoped by construction: the tenant id comes from the authenticated user,
   * so an admin can only ever edit their own hospital however the request is
   * shaped.
   *
   * Existing appointments are NOT rewritten. Shortening slots from 30 to 10
   * minutes leaves yesterday's 09:30 appointments exactly where they were —
   * moving booked appointments because a setting changed would be a far worse
   * surprise than a few historical times sitting off the new grid.
   */
  async updateClinicSettings(dto: UpdateClinicSettingsDto) {
    const current = await this.clinic.current();
    // Uppercased here rather than trusting the client's casing — "inr" and
    // "INR" are the same currency and should not produce two different rows.
    const next = { ...current, ...dto, ...(dto.currency ? { currency: dto.currency.toUpperCase() } : {}) };

    // Validated as a whole, not field by field: "end after start" is only
    // answerable once both values are known, and a PATCH may supply either.
    validateClinicSettings(next);

    await this.prisma.tenant.update({
      where: { id: currentTenantId() },
      data: {
        timezone: next.timezone,
        slotMinutes: next.slotMinutes,
        clinicStartHour: next.clinicStartHour,
        clinicEndHour: next.clinicEndHour,
        currency: next.currency,
        pharmacyBilling: next.pharmacyBilling,
        hasPharmacy: next.hasPharmacy,
        acceptsExternalPrescriptions: next.acceptsExternalPrescriptions,
        labBilling: next.labBilling,
        hasLab: next.hasLab,
        acceptsExternalLabOrders: next.acceptsExternalLabOrders,
        acceptedReferralBilling: next.acceptedReferralBilling,
        taxEnabled: next.taxEnabled,
        pricesIncludeTax: next.pricesIncludeTax,
        consultationTaxRateId: next.consultationTaxRateId,
      },
    });

    return this.clinicSettings();
  }

  /**
   * The caller's hospital timezone.
   *
   * Async because it is a per-tenant lookup now, not a process-wide
   * constant — two hospitals on one deployment keep different clocks, and
   * the clock decides what "today" contains.
   */
  private async tz(): Promise<string> {
    return (await this.clinic.current()).timezone;
  }

  /**
   * Per-stream money over one period, from rows fetched once.
   *
   * ONE FETCH, TWO CALLERS, AND THE `OR` IS DOING REAL WORK
   * ------------------------------------------------------
   * `billed`, `tax`, `collected` and `refunded` are about the period.
   * `outstandingAllTime` is not — an unpaid sale from last week is still money
   * owed today — so every open invoice has to be in hand whenever it was
   * raised. Fetching only the period would silently drop old debt from the owed
   * figure; fetching every invoice ever would pull years of settled rows and
   * their items to add nothing.
   *
   * `items.taxAmount` because there is no tax column on the invoice. Taking a
   * percentage of the total here instead would produce a number that disagrees
   * with the one printed on the bill.
   */
  private async revenueFor(period: { start: Date; end: Date }) {
    const [invoices, payments, refunds] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          voidedAt: null,
          status: { notIn: [InvoiceStatus.CANCELLED] },
          OR: [{ issuedAt: { gte: period.start, lt: period.end } }, { status: { not: InvoiceStatus.PAID } }],
        },
        select: {
          kind: true,
          totalAmount: true,
          amountPaid: true,
          creditedAmount: true,
          status: true,
          issuedAt: true,
          items: { select: { taxAmount: true } },
        },
      }),
      this.prisma.payment.findMany({
        where: { receivedAt: { gte: period.start, lt: period.end } },
        select: { amount: true, receivedAt: true, invoice: { select: { kind: true } } },
      }),
      /*
       * Refunds, because money given back is not money taken. This figure once
       * summed payments alone, so a 500 payment refunded in full still read as
       * 500 collected while the billing screen's signed ledger showed nothing.
       * Two screens disagreeing about the same day destroys trust in both.
       */
      this.prisma.refund.findMany({
        where: { refundedAt: { gte: period.start, lt: period.end } },
        select: { amount: true, refundedAt: true, invoice: { select: { kind: true } } },
      }),
    ]);

    return revenueByStream(
      invoices.map((i) => ({
        kind: i.kind,
        issuedAt: i.issuedAt,
        totalMinor: decimalToMinor(i.totalAmount),
        paidMinor: decimalToMinor(i.amountPaid),
        creditedMinor: decimalToMinor(i.creditedAmount),
        taxMinor: sumMinor(i.items.map((it) => decimalToMinor(it.taxAmount))),
        isSettled: i.status === InvoiceStatus.PAID,
      })),
      payments.map((p) => ({
        kind: p.invoice?.kind ?? InvoiceKind.HOSPITAL,
        amountMinor: minorOf(p.amount),
        at: p.receivedAt,
      })),
      refunds.map((r) => ({
        kind: r.invoice?.kind ?? InvoiceKind.HOSPITAL,
        amountMinor: minorOf(r.amount),
        at: r.refundedAt,
      })),
      period,
    );
  }

  /**
   * What each business billed and collected over a period the reader chose.
   *
   * Asked for by the product owner, in two parts. First: the unpaid figure was
   * showing a months-old balance with *Today* selected, and *"the customer may
   * get confused, where is it coming from"* — so `outstandingInPeriod` is of
   * what was billed in the period, and the all-time figure is beside it and
   * labelled. Second: *"instead of this month, could the customer select a date
   * range, or a month and year"* — so the period is a parameter rather than
   * three fixed windows, and August is reachable in October.
   *
   * Its own endpoint rather than parameters on `/admin/dashboard`, because
   * changing a date must not refetch appointments, occupancy, bed counts, staff
   * and audit figures. A period control that re-renders the whole screen is one
   * people learn not to touch.
   *
   * The resolved boundaries and label travel back, so the screen prints what
   * the server actually used rather than what the device's clock thinks it
   * asked for — those differ by a day for anybody not sitting in their own
   * clinic.
   */
  async revenueReport(period?: PeriodQuery) {
    const timezone = await this.tz();
    const resolved = resolvePeriod(timezone, period);

    return {
      generatedAt: new Date(),
      timezone,
      period: {
        from: resolved.from,
        to: resolved.to,
        label: resolved.label,
        wholeMonth: resolved.wholeMonth,
      },
      streams: await this.revenueFor(resolved),
    };
  }

  /**
   * The whole dashboard, over a period the reader chose.
   *
   * ONE PERIOD, AND IT DRIVES EVERYTHING THAT CAN MOVE
   * --------------------------------------------------
   * Reported by the product owner: the period control was applied to the
   * revenue streams only, so *"zero tests ordered today"* and *"kept today"*
   * sat above a card showing August, each answering a different question with
   * nothing saying so. *"It should be showing data for all the sections, even
   * top sections."* Correct, and the same fault as the unpaid column one
   * change earlier — a figure that does not move with the period, next to ones
   * that do, with nothing naming the exception.
   *
   * THE RESPONSE IS SPLIT, BECAUSE NOT EVERY FIGURE HAS A PERIOD VERSION
   * -------------------------------------------------------------------
   * `overPeriod` moves with the dates. `rightNow` cannot: bed occupancy is how
   * many beds are full *at this moment*, and "occupancy for last month" would
   * have to mean an average or a peak, which is a different figure wearing the
   * same label. Same for staff counts, the lab queue depths and unpriced
   * medicines — a backlog has no historical version, it is a backlog or it is
   * not.
   *
   * Making those silently ignore the period is the reported bug. Making them
   * *appear* to honour it by substituting an average would be worse: a
   * plausible number answering a question nobody asked, which is the error the
   * finance report was rewritten to fix. So they are separated, named, and both
   * clients head that section with the fact that the period does not apply.
   *
   * EVERY KEY THAT SAID `Today` WAS RENAMED
   * ---------------------------------------
   * `dispensesToday`, `ordersToday`, `unpricedSalesToday`,
   * `collectedLastSevenDays` — a key named for a window it no longer covers is
   * a false name, and this project has recorded four of those as the cause of a
   * real incident. They are now `dispenses`, `ordersPlaced` and so on, inside
   * `overPeriod`, where the period is stated once.
   */
  async dashboard(period?: PeriodQuery) {
    const now = new Date();
    const timezone = await this.tz();
    const resolved = resolvePeriod(timezone, period);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const window = { start: resolved.start, end: resolved.end };

    const [
      appointments,
      registered,
      doctors,
      beds,
      occupied,
      activeStaff,
      lockedAccounts,
      pendingPasswordChanges,
      auditFailures,
      medicineCount,
      doctorsWithoutFee,
      medicinesWithoutPrice,
    ] = await Promise.all([
      /*
       * Appointments falling inside the period, with just enough of the
       * invoice to answer "did it turn into money".
       *
       * `select` rather than `include`, and the selection is deliberately
       * narrow: `appointment: true` on a finance report is how a `patientId`
       * becomes valid, unremarkable data in a place it has no business being.
       * `reason` is the field one careless line away — typed by reception and
       * routinely "chest pain" — and `patient-activity.spec.ts` asserts the
       * word never appears in the module that consumes this.
       */
      this.prisma.appointment.findMany({
        where: { scheduledAt: { gte: window.start, lt: window.end } },
        select: {
          doctorId: true,
          patientId: true,
          status: true,
          invoice: { select: { totalAmount: true, amountPaid: true } },
        },
      }),
      /*
       * Registrations in the period, excluding referral-origin records. Those
       * are patients a partner laboratory sent work for — `Patient.isReferralOrigin`
       * marks them and patient search already excludes them, so counting them
       * as this clinic's new patients would inflate the one figure an owner
       * reads as growth.
       */
      this.prisma.patient.count({
        where: { createdAt: { gte: window.start, lt: window.end }, isReferralOrigin: false },
      }),
      this.prisma.doctor.findMany({ select: { id: true, fullName: true } }),
      this.prisma.bed.count({ where: { isActive: true } }),
      this.prisma.admission.count({ where: { status: AdmissionStatus.ADMITTED } }),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { lockedUntil: { gt: now } } }),
      this.prisma.user.count({ where: { mustChangePassword: true, isActive: true } }),
      /*
       * Denied requests, over a fixed 24 hours and deliberately **not** the
       * chosen period. It is a "is something probing us right now" signal, and
       * a spike is only a spike against a recent baseline — "412 denials in
       * August" tells an administrator nothing they can act on today.
       */
      this.prisma.auditLog.count({
        where: { outcome: AuditOutcome.FAILURE, createdAt: { gte: dayAgo } },
      }),
      this.prisma.medicine.count({ where: { isActive: true } }),
      // Surfaced because it breaks reception's checkout, not because it is
      // untidy: a doctor with no fee cannot be billed for, and the first
      // symptom is a receptionist stuck in front of a patient.
      this.prisma.doctor.count({ where: { consultationFee: null } }),
      // The same failure one shelf over: an unpriced medicine is dispensed,
      // leaves stock, and is charged nothing.
      this.prisma.medicine.count({ where: { isActive: true, sellingPrice: null } }),
    ]);

    const [
      dispenses,
      reversals,
      unpricedSales,
      labOrdersPlaced,
      labAwaitingCollection,
      labOnTheBench,
      labAwaitingAuthorisation,
      prescriptionsOut,
      labOrdersOut,
      pharmacyPartners,
      labPartners,
      partnerCharges,
      referredLines,
    ] = await Promise.all([
      this.prisma.dispenseEvent.count({
        where: { dispensedAt: { gte: window.start, lt: window.end }, reversedAt: null },
      }),
      this.prisma.dispenseEvent.count({
        where: { reversedAt: { gte: window.start, lt: window.end } },
      }),
      /*
       * A handover with no price still leaves the shelf. This is the number
       * nothing else surfaces, and it is how a month of unbilled stock happens.
       */
      this.prisma.dispenseEvent.count({
        where: {
          dispensedAt: { gte: window.start, lt: window.end },
          reversedAt: null,
          invoiceId: null,
        },
      }),
      this.prisma.labOrder.count({
        where: { orderedAt: { gte: window.start, lt: window.end } },
      }),
      /*
       * The three queue depths below are `rightNow` figures and take no period.
       * "Awaiting collection in August" is not a thing: a queue is a queue or it
       * has been cleared.
       */
      this.prisma.labOrder.count({ where: { status: LabOrderStatus.ORDERED } }),
      this.prisma.labOrder.count({
        where: { status: { in: [LabOrderStatus.COLLECTED, LabOrderStatus.IN_PROGRESS] } },
      }),
      this.prisma.labOrder.count({ where: { status: LabOrderStatus.RESULTED } }),
      /*
       * Where the work went. Both models have carried `destination` and
       * `routedToTenantId` since routing shipped and nothing ever reported
       * them — asked for by the product owner: *"what different pharmacies
       * outside my hospital has that prescription gone to. Same for the
       * tests."*
       *
       * Two columns each and nothing else. No `medicineName`, no `testName`,
       * no patient — `referrals-out.spec.ts` asserts on the absence, because a
       * test that only checked the counts were right would still pass if a
       * drug name arrived beside them.
       */
      this.prisma.prescription.findMany({
        where: { issuedAt: { gte: window.start, lt: window.end } },
        select: { destination: true, routedToTenantId: true },
      }),
      this.prisma.labOrder.findMany({
        where: { orderedAt: { gte: window.start, lt: window.end } },
        select: { destination: true, routedToTenantId: true },
      }),
      /*
       * The partner labels, from *this* hospital's own partnership rows — so
       * naming a partner needs no cross-tenant read and no policy exception.
       * Not filtered on `isActive`: removal is a soft delete precisely so
       * "where did this go" stays answerable, and a removed partner still has
       * the prescriptions already routed to it.
       */
      this.prisma.pharmacyPartner.findMany({
        select: { partnerTenantId: true, label: true },
      }),
      this.prisma.labPartner.findMany({
        select: { partnerTenantId: true, label: true },
      }),
      /*
       * What the partner laboratories charged us. A notice rather than accounts
       * payable — no part-payments, no credit notes, no aging — so this totals
       * notices and says which are still open.
       */
      this.prisma.partnerLabCharge.findMany({
        where: { incurredAt: { gte: window.start, lt: window.end } },
        select: {
          partnerTenantId: true,
          partnerName: true,
          amount: true,
          settledAt: true,
        },
      }),
      /*
       * Referred test lines, to answer what we billed the patient for work we
       * sent elsewhere. `payableExternally` is why this is not just "unpriced":
       * under PATIENT_PAYS no line is raised on purpose, and merging the two
       * would make every "went out uncharged" figure report it forever.
       */
      this.prisma.labOrderItem.findMany({
        where: {
          order: {
            orderedAt: { gte: window.start, lt: window.end },
            destination: { not: 'IN_HOUSE' },
          },
        },
        select: { unitPrice: true, payableExternally: true },
      }),
    ]);

    /*
     * Both the money block here and `GET /admin/reports/revenue` go through
     * `revenueFor`, so the dashboard and the card below it cannot disagree —
     * they are read by the same person in the same minute and they already did
     * disagree once, when this method summed every payment with no `kind`
     * filter while the finance report split them correctly.
     */
    const revenue = await this.revenueFor(window);
    const hospitalRevenue = streamNamed(revenue, 'HOSPITAL');

    const activity = patientActivity(
      appointments.map((a) => ({
        doctorId: a.doctorId,
        patientId: a.patientId,
        status: a.status,
        billedMinor: a.invoice ? decimalToMinor(a.invoice.totalAmount) : 0,
        collectedMinor: a.invoice ? decimalToMinor(a.invoice.amountPaid) : 0,
      })),
      doctors.map((d) => ({ id: d.id, name: d.fullName })),
      registered,
    );

    return {
      generatedAt: now,
      timezone,
      /** What the server actually resolved. Print this, never the local guess. */
      period: {
        from: resolved.from,
        to: resolved.to,
        label: resolved.label,
        wholeMonth: resolved.wholeMonth,
      },

      /*
       * ── EVERYTHING BELOW MOVES WITH THE PERIOD ────────────────────────────
       */
      overPeriod: {
        /**
         * Patients, appointments, and a row per doctor.
         *
         * `patientsSeen` is a distinct count and deliberately not the sum of
         * the doctor rows: one patient seen by two doctors is one patient here
         * and one in each row, and a hospital total larger than its own patient
         * list is a figure nobody can explain. The named drill-down is
         * `GET /admin/reports/consultations`, which both clients link the counts
         * to — it carries `ADMIN_CONSULTATION_LEDGER` as its own audit action so
         * "who looked up our patient list, and when" stays answerable.
         */
        activity,
        /** The clinic's own books only. The pharmacy's and lab's are in `/reports/revenue`. */
        /*
         * The clinic's own books over the period. Read straight off the stream
         * rather than through a helper: the helper existed to build four keys
         * named for a rolling week, and those names went when the period became
         * the reader's choice.
         */
        finance: hospitalRevenue.period,
        pharmacy: {
          dispenses,
          reversals,
          /** Went out of the shop with nothing to charge for it. */
          unpricedSales,
        },
        laboratory: { ordersPlaced: labOrdersPlaced },
        /**
         * Where prescriptions and test requests went.
         *
         * `external` is its own row rather than an unnamed partner: it means
         * the patient took it away to fill wherever they chose, there is
         * nobody to name, and it is usually the figure an owner has never seen.
         */
        referralsOut: {
          prescriptions: breakdownByDestination(prescriptionsOut, pharmacyPartners),
          labOrders: breakdownByDestination(labOrdersOut, labPartners),
          /** What the partner laboratories invoiced us for, per partner. */
          owedToPartners: owedToPartners(
            partnerCharges.map((c) => ({
              partnerTenantId: c.partnerTenantId,
              partnerName: c.partnerName,
              amountMinor: decimalToMinor(c.amount),
              settled: c.settledAt !== null,
            })),
          ),
          /** What we charged the patient for referred work, and what we did not. */
          referredBilling: referredBilling(
            referredLines.map((l) => ({
              unitPriceMinor: l.unitPrice === null ? null : decimalToMinor(l.unitPrice),
              payableExternally: l.payableExternally,
            })),
          ),
        },
      },

      /*
       * ── AND EVERYTHING BELOW IGNORES IT ───────────────────────────────────
       *
       * Point-in-time figures. Not an oversight and not a period version
       * waiting to be written: occupancy is how many beds are full now, and a
       * queue depth is a backlog or it is not. Both clients head this section
       * with the fact that the dates above do not apply to it.
       */
      rightNow: {
        occupancy: {
          beds,
          occupied,
          available: beds - occupied,
          percent: beds > 0 ? Math.round((occupied / beds) * 100) : 0,
        },
        /**
         * Everything owed, whenever it was billed — the figure a clinic decides
         * whether to chase on. The period's own unpaid total is in
         * `/reports/revenue`, per stream.
         */
        finance: {
          outstanding: hospitalRevenue.outstandingAllTime,
          openInvoices: hospitalRevenue.openInvoicesAllTime,
        },
        staff: {
          active: activeStaff,
          lockedOut: lockedAccounts,
          awaitingPasswordChange: pendingPasswordChanges,
          doctors: doctors.length,
          doctorsWithoutFee,
        },
        /** A fixed 24 hours, because a spike only means anything against now. */
        security: { deniedRequestsLastDay: auditFailures },
        catalogue: {
          medicines: medicineCount,
          /** Active medicines nobody has priced. Blank is not zero. */
          withoutPrice: medicinesWithoutPrice,
        },
        laboratory: {
          awaitingCollection: labAwaitingCollection,
          onTheBench: labOnTheBench,
          /** Resulted, not authorised — invisible to the doctor who asked. */
          awaitingAuthorisation: labAwaitingAuthorisation,
        },
      },
    };
  }

  /**
   * Activity by role over a window.
   *
   * Derived from the audit log, which is the only place that records who did
   * what. Counts of actions per role — never the targets of those actions, so
   * "which patients did Dr Rao look at" is not answerable from here.
   */
  async activityReport(days = 7) {
    const since = new Date(Date.now() - Math.min(days, 90) * 86_400_000);

    const rows = await this.prisma.auditLog.findMany({
      where: { createdAt: { gte: since } },
      select: { actorRole: true, outcome: true, action: true },
    });

    const byRole = new Map<string, { total: number; denied: number }>();
    const byAction = new Map<string, number>();

    for (const row of rows) {
      const role = row.actorRole ?? 'UNAUTHENTICATED';
      const entry = byRole.get(role) ?? { total: 0, denied: 0 };
      entry.total++;
      if (row.outcome === AuditOutcome.FAILURE) entry.denied++;
      byRole.set(role, entry);

      byAction.set(row.action, (byAction.get(row.action) ?? 0) + 1);
    }

    return {
      windowDays: Math.min(days, 90),
      since,
      totalActions: rows.length,
      byRole: [...byRole.entries()]
        .map(([role, v]) => ({ role, ...v }))
        .sort((a, b) => b.total - a.total),
      topActions: [...byAction.entries()]
        .map(([action, count]) => ({ action, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15),
    };
  }

  /**
   * Money in, and money still owed.
   *
   * COUNTED FROM PAYMENTS, NOT INVOICES
   * -----------------------------------
   * "How much did we take today" is a question about payment rows. An invoice
   * raised today and settled next week is not today's takings, and one raised
   * last month and paid this morning is. Every figure under `collected` comes
   * from `Payment.receivedAt`; `aging` is the only part that looks at invoices,
   * because what is *owed* genuinely is an invoice-shaped question.
   *
   * MONTHS ARE THE HOSPITAL'S, NOT THE SERVER'S
   * -------------------------------------------
   * A payment taken at 23:30 on the 31st in Asia/Kolkata is already the 1st in
   * UTC. Bucketing on the stored instant moves that clinic's takings into the
   * next month — and this is the number someone reconciles against a bank
   * statement, so being a day out at the boundary is not cosmetic.
   *
   * Still aggregates: no payer, no patient, no invoice line. A total and a
   * method, which is what reconciling needs and no more.
   */
  async financeReport(months = 12) {
    const now = new Date();
    const tz = await this.tz();
    const { start: todayStart } = hospitalDayRange(now, tz);
    const { start: monthStart } = hospitalMonthRange(now, tz);
    const window = recentMonths(now, tz, Math.min(Math.max(months, 1), 24));

    /*
     * The invoice each payment settled comes back with it, because the kind of
     * invoice decides whose takings it is.
     *
     * WHY THIS MATTERS MORE THAN IT LOOKS
     * -----------------------------------
     * In SEPARATE mode the pharmacy is a different business, and a "collected
     * today" that silently adds a shop's counter takings to the hospital's is
     * the same class of error as the one this report was rewritten to fix:
     * summing invoices issued instead of payments received. Both produce a
     * plausible number that moves when takings move and answers a question
     * nobody asked.
     *
     * `invoice: { select: { kind: true } }` rather than `invoice: true`, for
     * the reason `reports.spec.ts` pins elsewhere — the wide include pulls a
     * `patientId` into a finance report as valid, unremarkable data.
     */
    const [rows, refundRows, invoices] = await Promise.all([
      this.prisma.payment.findMany({
        where: { receivedAt: { gte: window.start } },
        select: {
          amount: true,
          method: true,
          receivedAt: true,
          invoice: { select: { kind: true } },
        },
      }),
      this.prisma.refund.findMany({
        where: { refundedAt: { gte: window.start } },
        select: {
          amount: true,
          method: true,
          refundedAt: true,
          invoice: { select: { kind: true } },
        },
      }),
      this.prisma.invoice.findMany({
        where: { voidedAt: null, status: { notIn: [InvoiceStatus.CANCELLED] } },
        select: {
          id: true,
          kind: true,
          dueDate: true,
          totalAmount: true,
          amountPaid: true,
          creditedAmount: true,
        },
      }),
    ]);

    const payments: ReportablePayment[] = rows.map((p) => ({
      amountMinor: minorOf(p.amount),
      monthKey: hospitalMonthKey(p.receivedAt, tz),
      method: p.method,
      receivedAt: p.receivedAt,
      kind: p.invoice?.kind ?? InvoiceKind.HOSPITAL,
    }));

    /*
     * Refunds are carried alongside, never subtracted into `collected`.
     *
     * A month showing £4,000 could be £4,000 taken, or £5,000 taken with
     * £1,000 given back — and those are different months. Netting them into one
     * figure makes the second invisible, and it is the one somebody has to
     * explain. Gross in, gross out, net stated separately.
     */
    const refunds: ReportablePayment[] = refundRows.map((r) => ({
      amountMinor: minorOf(r.amount),
      monthKey: hospitalMonthKey(r.refundedAt, tz),
      method: r.method,
      receivedAt: r.refundedAt,
      kind: r.invoice?.kind ?? InvoiceKind.HOSPITAL,
    }));

    /*
     * Split by whose books the money is on.
     *
     * `hospitalPayments` is what the headline figures report, so a hospital
     * running a separately-billed pharmacy sees its own takings and not a
     * flattering total that includes a shop. The pharmacy's own figures are
     * reported beside them, never inside them.
     */
    const hospitalPayments = payments.filter((p) => p.kind === InvoiceKind.HOSPITAL);
    const hospitalRefunds = refunds.filter((r) => r.kind === InvoiceKind.HOSPITAL);
    const pharmacyPayments = payments.filter((p) => p.kind === InvoiceKind.PHARMACY);
    const pharmacyRefunds = refunds.filter((r) => r.kind === InvoiceKind.PHARMACY);
    const labPayments = payments.filter((p) => p.kind === InvoiceKind.LAB);
    const labRefunds = refunds.filter((r) => r.kind === InvoiceKind.LAB);

    // Every method the schema knows, so a method that took nothing today shows
    // a zero rather than being absent from the table.
    const methods = Object.values(PaymentMethod) as string[];

    return {
      generatedAt: now,
      timezone: tz,
      collected: {
        today: collectedSince(hospitalPayments, todayStart),
        thisMonth: collectedSince(hospitalPayments, monthStart),
        paymentsToday: hospitalPayments.filter((p) => p.receivedAt >= todayStart).length,
        paymentsThisMonth: hospitalPayments.filter((p) => p.receivedAt >= monthStart).length,
      },
      refunded: {
        today: collectedSince(hospitalRefunds, todayStart),
        thisMonth: collectedSince(hospitalRefunds, monthStart),
        refundsToday: hospitalRefunds.filter((r) => r.receivedAt >= todayStart).length,
        refundsThisMonth: hospitalRefunds.filter((r) => r.receivedAt >= monthStart).length,
      },
      /*
       * Net is computed here rather than in each client, so two screens cannot
       * disagree about what the day is worth — and in minor units, because
       * subtracting two money strings in a browser is how a penny goes missing.
       */
      net: {
        today: fromMinor(
          toMinor(collectedSince(hospitalPayments, todayStart)) -
            toMinor(collectedSince(hospitalRefunds, todayStart)),
        ),
        thisMonth: fromMinor(
          toMinor(collectedSince(hospitalPayments, monthStart)) -
            toMinor(collectedSince(hospitalRefunds, monthStart)),
        ),
      },
      monthly: monthlyTotals(hospitalPayments, window.keys),
      monthlyRefunds: monthlyTotals(hospitalRefunds, window.keys),
      methods: methodSplit(hospitalPayments, todayStart, monthStart, methods),
      /*
       * Aging is the hospital's debtors only.
       *
       * A pharmacy sale is paid at the counter or it does not happen; an
       * unsettled one is a till that has not been reconciled, not an account
       * receivable to chase at 30, 60 and 90 days. Mixing them makes the aging
       * report read as though the clinic is owed money it never expected.
       */
      /*
       * Built from `AGEABLE_INVOICE_KINDS`, not a hand-rolled HOSPITAL filter.
       *
       * This filtered to HOSPITAL alone while `/billing` aging used that shared
       * list — HOSPITAL **and** LAB — so the owner's screen and the billing
       * clerk's screen disagreed about which debts exist, and the ones missing
       * here were laboratory charges raised against named patients exactly as a
       * consultation is. Two screens disagreeing about money is worse than
       * either being wrong alone.
       *
       * The pharmacy stays out, which is what that list already decides: a
       * counter sale is paid at the counter or it does not happen, and an
       * unsettled one is an unreconciled till rather than somebody to chase at
       * 30, 60 and 90 days.
       *
       * Credits are subtracted, so a credit note does not leave a phantom
       * bucket — the same arithmetic `revenueByStream` uses for outstanding.
       */
      aging: buildAgingReport(
        invoices
          .filter((i) => (AGEABLE_INVOICE_KINDS as readonly string[]).includes(i.kind))
          .map((i) => ({
            id: i.id,
            dueDate: i.dueDate,
            outstandingMinor: Math.max(
              0,
              minorOf(i.totalAmount) - minorOf(i.creditedAmount) - minorOf(i.amountPaid),
            ),
          })),
        now,
      ),

      /*
       * The pharmacy, counted on its own.
       *
       * Reported beside the hospital's figures rather than folded into them,
       * whichever mode the tenant is in. In SEPARATE mode they are two
       * businesses and an owner needs both; in COMBINED mode the medicines are
       * on hospital invoices and this reads as zero, which is the honest answer
       * rather than a missing section.
       */
      pharmacy: {
        collectedToday: collectedSince(pharmacyPayments, todayStart),
        collectedThisMonth: collectedSince(pharmacyPayments, monthStart),
        refundedToday: collectedSince(pharmacyRefunds, todayStart),
        refundedThisMonth: collectedSince(pharmacyRefunds, monthStart),
        netToday: fromMinor(
          toMinor(collectedSince(pharmacyPayments, todayStart)) -
            toMinor(collectedSince(pharmacyRefunds, todayStart)),
        ),
        netThisMonth: fromMinor(
          toMinor(collectedSince(pharmacyPayments, monthStart)) -
            toMinor(collectedSince(pharmacyRefunds, monthStart)),
        ),
        monthly: monthlyTotals(pharmacyPayments, window.keys),
      },

      /*
       * The lab, counted on its own, on exactly the same terms.
       *
       * A separate section rather than a second "ancillary" total added to the
       * pharmacy's, because a hospital may run one, both or neither and an
       * owner reconciling a till needs to know which counter a number came
       * from. In COMBINED mode this reads as zero, which is the honest answer
       * rather than a missing section — the same argument as the pharmacy's.
       */
      lab: {
        collectedToday: collectedSince(labPayments, todayStart),
        collectedThisMonth: collectedSince(labPayments, monthStart),
        refundedToday: collectedSince(labRefunds, todayStart),
        refundedThisMonth: collectedSince(labRefunds, monthStart),
        netToday: fromMinor(
          toMinor(collectedSince(labPayments, todayStart)) -
            toMinor(collectedSince(labRefunds, todayStart)),
        ),
        netThisMonth: fromMinor(
          toMinor(collectedSince(labPayments, monthStart)) -
            toMinor(collectedSince(labRefunds, monthStart)),
        ),
        monthly: monthlyTotals(labPayments, window.keys),
      },
    };
  }

  /**
   * Who is working, how hard, and what it earned.
   *
   * WHY A PER-DOCTOR BREAKDOWN IS ALLOWED HERE
   * ------------------------------------------
   * The rule above is that admin reports carry no clinical meaning and no
   * breakdown fine enough to identify a patient. A doctor is staff, not a
   * patient, and a count of their appointments says nothing about who those
   * appointments were with or what happened in them. No diagnosis, no medicine,
   * no patient name or id crosses this boundary — only counts and money.
   *
   * The line to hold: never break this down by anything clinical. "Appointments
   * per doctor per department" would start naming what a patient attended for,
   * which is the same leak `consultation-billing.spec.ts` refuses in an invoice
   * description.
   *
   * BILLED AND COLLECTED ARE BOTH REPORTED
   * --------------------------------------
   * Reporting only what was charged is how a clinic mistakes invoices raised
   * for money in the bank. Payment is deliberately not required before a
   * consultation, so the gap between the two is real and worth seeing.
   */
  async doctorsReport() {
    const now = new Date();
    const tz = await this.tz();
    const { start: todayStart, end: todayEnd } = hospitalDayRange(now, tz);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const { start: monthStart } = hospitalMonthRange(now, tz);

    const [doctors, appointments, invoices] = await Promise.all([
      this.prisma.doctor.findMany({
        select: {
          id: true,
          fullName: true,
          specialization: true,
          consultationFee: true,
          department: { select: { name: true } },
        },
        orderBy: { fullName: 'asc' },
      }),
      this.prisma.appointment.findMany({
        where: { scheduledAt: { gte: weekAgo } },
        select: { doctorId: true, status: true, scheduledAt: true },
      }),
      this.prisma.invoice.findMany({
        where: {
          voidedAt: null,
          status: { notIn: [InvoiceStatus.CANCELLED] },
          issuedAt: { gte: monthStart },
          appointmentId: { not: null },
        },
        // Only the doctor id crosses over. Selecting the appointment wholesale
        // would pull a patient id into a report that must not have one.
        select: {
          totalAmount: true,
          amountPaid: true,
          appointment: { select: { doctorId: true } },
        },
      }),
    ]);

    const revenue = revenueByDoctor(
      invoices.map((i) => ({
        doctorId: i.appointment?.doctorId ?? null,
        totalMinor: minorOf(i.totalAmount),
        paidMinor: minorOf(i.amountPaid),
      })),
    );

    const rows = doctors.map((doctor) => {
      const mine = appointments.filter((a) => a.doctorId === doctor.id);
      const money = revenue.get(doctor.id) ?? { billed: '0.00', collected: '0.00' };
      return {
        id: doctor.id,
        fullName: doctor.fullName,
        specialization: doctor.specialization,
        department: doctor.department?.name ?? null,
        // Null, not zero. A doctor who has not been priced and one who sees
        // patients for nothing are different facts, and collapsing them is what
        // makes a forgotten fee look like a decision.
        consultationFee: doctor.consultationFee === null ? null : toMoneyString(doctor.consultationFee),
        today: countWorkload(
          mine.filter((a) => a.scheduledAt >= todayStart && a.scheduledAt < todayEnd),
        ),
        lastSevenDays: countWorkload(mine),
        revenueThisMonth: money,
      };
    });

    return {
      generatedAt: now,
      timezone: tz,
      total: doctors.length,
      withoutFee: rows.filter((r) => r.consultationFee === null).length,
      doctors: rows,
    };
  }

  /**
   * One day, one hospital, every member of staff and what they did.
   *
   * The owner's question: "who worked, how much did they do, and how much money
   * came in through them." In a small clinic that is not surveillance, it is
   * how the person carrying the risk reconciles the day.
   *
   * WHAT THIS DELIBERATELY DOES NOT ANSWER
   * --------------------------------------
   * *Which* patients. Not one name, date of birth or clinical fact crosses this
   * boundary — only counts and money. An administrator who needs to see named
   * patients switches to a clinical role they hold and looks as that role,
   * which is exactly what multi-role is for: the audit log then records that
   * they viewed patient data while acting as a doctor, rather than letting an
   * administrative screen quietly become a patient browser.
   *
   * That is a real constraint and not a stylistic one. A management report is
   * the least-questioned route into clinical data — nobody challenges an
   * owner's dashboard — and `access-matrix.spec.ts` fails the build on any
   * clinical GET reachable by ADMIN.
   *
   * The drill-down is the audit log, which admin already has: it records who
   * touched which record, when, and whether they were refused. It shows a
   * patient *id*, never a name, and no admin endpoint resolves one into the
   * other.
   *
   * WHY READS ARE NOT COUNTED
   * -------------------------
   * `PATIENT_SEARCH` and `QUEUE_VIEW` measure how long a screen was open, not
   * what was done. A productivity figure built on them rewards leaving a list
   * up, and would be the first number someone argued with.
   */
  async staffActivityReport(dateParam?: string) {
    const now = new Date();
    const tz = await this.tz();
    const { start, end } = parseDateParam(dateParam, tz);

    const [appointments, invoices, auditRows, payments, refunds, staff] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { scheduledAt: { gte: start, lt: end } },
        select: { doctorId: true, status: true, scheduledAt: true },
      }),
      this.prisma.invoice.findMany({
        where: {
          voidedAt: null,
          status: { notIn: [InvoiceStatus.CANCELLED] },
          issuedAt: { gte: start, lt: end },
          appointmentId: { not: null },
        },
        // Only the doctor id. `appointment: true` would pull a patientId into
        // a report that must not have one.
        select: {
          totalAmount: true,
          amountPaid: true,
          appointment: { select: { doctorId: true } },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { createdAt: { gte: start, lt: end } },
        select: { userId: true, action: true, outcome: true },
      }),
      this.prisma.payment.findMany({
        where: { receivedAt: { gte: start, lt: end } },
        select: { receivedById: true, amount: true, method: true },
      }),
      /*
       * Attributed to whoever *issued* the refund, not whoever took the
       * original payment.
       *
       * Both attributions are defensible and they answer different questions.
       * This report is "what did each member of staff do today", so the person
       * who handed money back is the person whose day it belongs to — and it is
       * also the only attribution that keeps the column footing to the
       * hospital's own net for the day.
       */
      this.prisma.refund.findMany({
        where: { refundedAt: { gte: start, lt: end } },
        select: { refundedById: true, amount: true },
      }),
      this.prisma.user.findMany({
        select: {
          id: true,
          fullName: true,
          role: true,
          roleAssignments: { select: { role: true } },
          doctorProfile: { select: { id: true, specialization: true } },
        },
        orderBy: { fullName: 'asc' },
      }),
    ]);

    const revenue = revenueByDoctor(
      invoices.map((i) => ({
        doctorId: i.appointment?.doctorId ?? null,
        totalMinor: minorOf(i.totalAmount),
        paidMinor: minorOf(i.amountPaid),
      })),
    );
    const collections = collectionsByStaff(
      payments.map((p) => ({
        receivedById: p.receivedById,
        amountMinor: minorOf(p.amount),
        method: p.method,
      })),
      refunds.map((r) => ({ refundedById: r.refundedById, amountMinor: minorOf(r.amount) })),
    );
    const reception = countActions(auditRows, ACTIVITY_ACTIONS.RECEPTIONIST);
    const pharmacy = countActions(auditRows, ACTIVITY_ACTIONS.PHARMACIST);
    const nursing = countActions(auditRows, ACTIVITY_ACTIONS.NURSE);

    /**
     * A person appears under every role they *hold*, not just their default.
     *
     * The owner-doctor is the reason: counting them only as an administrator
     * would leave their consultations attributed to nobody, and a day's
     * takings that do not add up is worse than a name appearing twice.
     */
    const holds = (u: (typeof staff)[number], role: UserRole) =>
      u.role === role || u.roleAssignments.some((a) => a.role === role);

    const zero = { billed: '0.00', collected: '0.00' };

    return {
      date: start,
      timezone: tz,
      generatedAt: now,
      doctors: staff
        .filter((u) => holds(u, UserRole.DOCTOR) && u.doctorProfile)
        .map((u) => {
          const mine = appointments.filter((a) => a.doctorId === u.doctorProfile!.id);
          return {
            userId: u.id,
            /*
             * The *doctor profile* id, which is not the user id.
             *
             * Sent because the ledger drill-down filters appointments by it,
             * and a client that had to guess would guess wrong — quietly
             * returning another doctor's day, or an empty one, with no error
             * to notice. Two id spaces meeting in a URL is worth being
             * explicit about.
             */
            doctorId: u.doctorProfile!.id,
            fullName: u.fullName,
            specialization: u.doctorProfile!.specialization,
            consultations: countWorkload(mine),
            revenue: revenue.get(u.doctorProfile!.id) ?? zero,
          };
        }),
      reception: staff
        .filter((u) => holds(u, UserRole.RECEPTIONIST))
        .map((u) => ({
          userId: u.id,
          fullName: u.fullName,
          ...(reception.get(u.id) ?? {
            registrations: 0,
            bookings: 0,
            updates: 0,
            invoicesRaised: 0,
          }),
        })),
      billing: staff
        .filter((u) => holds(u, UserRole.BILLING_STAFF))
        .map((u) => ({
          userId: u.id,
          fullName: u.fullName,
          ...(collections.get(u.id) ?? {
            total: '0.00',
            refunded: '0.00',
            net: '0.00',
            count: 0,
            refunds: 0,
            methods: [],
          }),
        })),
      pharmacy: staff
        .filter((u) => holds(u, UserRole.PHARMACIST))
        .map((u) => ({
          userId: u.id,
          fullName: u.fullName,
          ...(pharmacy.get(u.id) ?? { dispensed: 0, prepared: 0, stockReceived: 0 }),
        })),
      nursing: staff
        .filter((u) => holds(u, UserRole.NURSE))
        .map((u) => ({
          userId: u.id,
          fullName: u.fullName,
          ...(nursing.get(u.id) ?? { vitals: 0, doses: 0, admissions: 0 }),
        })),
    };
  }

  /**
   * The patients behind a number on the daily activity screen.
   *
   * The owner clicks "3 seen" and gets the three. This is the point at which
   * ADMIN gains patient identity, and it is a deliberate, documented widening
   * rather than a side effect — see `CLAUDE.md`, "Admin sees attendance and
   * money, never clinical content".
   *
   * WHAT CROSSES AND WHAT DOES NOT
   * ------------------------------
   * Crosses: name, appointment time, whether they turned up, what they were
   * charged, whether they paid. Every one of those is already visible to
   * reception at the desk and to billing on an invoice, and every one is
   * needed to answer "did this doctor see three patients and did we get paid".
   *
   * Does not cross: `Appointment.reason` — typed by reception at booking and
   * routinely "chest pain" — prescription contents, diagnoses, notes,
   * allergies, admissions. The select below is the boundary; a field that is
   * not fetched cannot be leaked by a later change to a response shape.
   *
   * `prescriptionIssued` is a boolean on purpose. That a prescription exists is
   * operational; what is in it names a condition.
   *
   * An owner who needs the clinical detail switches to a role that holds it,
   * and the audit log records they read it as a doctor.
   */
  async consultationLedger(params: { date?: string; doctorId?: number; status?: AppointmentStatus }) {
    const tz = await this.tz();
    const { start, end } = parseDateParam(params.date, tz);

    const rows = await this.prisma.appointment.findMany({
      where: {
        scheduledAt: { gte: start, lt: end },
        ...(params.doctorId ? { doctorId: params.doctorId } : {}),
        ...(params.status ? { status: params.status } : {}),
      },
      // An explicit allowlist. `include` or a bare relation would pull the
      // whole patient row — dob, phone, address, insurer — into a management
      // screen, and none of it is needed to answer the question.
      select: {
        id: true,
        scheduledAt: true,
        status: true,
        patient: { select: { id: true, fullName: true } },
        doctor: { select: { id: true, fullName: true } },
        invoice: { select: { id: true, totalAmount: true, amountPaid: true } },
        prescription: { select: { id: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    return {
      date: start,
      timezone: tz,
      total: rows.length,
      appointments: rows.map(toLedgerRow),
    };
  }

  /** Staff headcount by role, for capacity planning. */
  async staffReport() {
    const users = await this.prisma.user.findMany({
      select: { role: true, isActive: true, lastLoginAt: true },
    });

    const roles = Object.values(UserRole).map((role) => {
      const forRole = users.filter((u) => u.role === role);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
      return {
        role,
        total: forRole.length,
        active: forRole.filter((u) => u.isActive).length,
        // Dormant accounts are an access-control problem, not an HR one — an
        // account nobody uses is an account nobody notices being used.
        dormant: forRole.filter(
          (u) => u.isActive && (!u.lastLoginAt || u.lastLoginAt < thirtyDaysAgo),
        ).length,
      };
    });

    return { roles, totalActive: users.filter((u) => u.isActive).length };
  }
}
