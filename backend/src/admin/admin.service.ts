import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdmissionStatus,
  AppointmentStatus,
  AuditOutcome,
  InvoiceStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hospitalDayRange } from '../common/utils/hospital-time';
import { fromMinor, sumMinor, toMinor, toMoneyString } from '../billing/money';
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

  async dashboard() {
    const now = new Date();
    const { start: todayStart, end: todayEnd } = hospitalDayRange(now, await this.tz());
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);

    const [
      appointmentsToday,
      appointmentsWeek,
      completedToday,
      noShowsWeek,
      beds,
      occupied,
      activeStaff,
      lockedAccounts,
      pendingPasswordChanges,
      auditFailures,
      invoices,
      lowStockCount,
    ] = await Promise.all([
      this.prisma.appointment.count({ where: { scheduledAt: { gte: todayStart, lt: todayEnd } } }),
      this.prisma.appointment.count({ where: { scheduledAt: { gte: weekAgo } } }),
      this.prisma.appointment.count({
        where: {
          scheduledAt: { gte: todayStart, lt: todayEnd },
          status: AppointmentStatus.COMPLETED,
        },
      }),
      this.prisma.appointment.count({
        where: { scheduledAt: { gte: weekAgo }, status: AppointmentStatus.NO_SHOW },
      }),
      this.prisma.bed.count({ where: { isActive: true } }),
      this.prisma.admission.count({ where: { status: AdmissionStatus.ADMITTED } }),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { lockedUntil: { gt: now } } }),
      this.prisma.user.count({ where: { mustChangePassword: true, isActive: true } }),
      // The security signal worth surfacing daily: denied requests. A spike is
      // either a misconfigured client or someone probing.
      this.prisma.auditLog.count({
        where: { outcome: AuditOutcome.FAILURE, createdAt: { gte: dayAgo } },
      }),
      this.prisma.invoice.findMany({
        where: { voidedAt: null, status: { notIn: [InvoiceStatus.CANCELLED] } },
        select: { totalAmount: true, amountPaid: true, status: true, issuedAt: true },
      }),
      this.prisma.medicine.count({ where: { isActive: true } }),
    ]);

    const outstandingMinor = sumMinor(
      invoices
        .filter((i) => i.status !== InvoiceStatus.PAID)
        .map((i) => toMinor(toMoneyString(i.totalAmount)) - toMinor(toMoneyString(i.amountPaid))),
    );
    const collectedWeekMinor = sumMinor(
      invoices.filter((i) => i.issuedAt >= weekAgo).map((i) => toMinor(toMoneyString(i.amountPaid))),
    );

    return {
      generatedAt: now,
      timezone: await this.tz(),
      appointments: {
        today: appointmentsToday,
        completedToday,
        lastSevenDays: appointmentsWeek,
        noShowsLastSevenDays: noShowsWeek,
        // A blunt but useful operational number: how much clinic time is wasted.
        noShowRate: appointmentsWeek > 0 ? Math.round((noShowsWeek / appointmentsWeek) * 100) : 0,
      },
      occupancy: {
        beds,
        occupied,
        available: beds - occupied,
        percent: beds > 0 ? Math.round((occupied / beds) * 100) : 0,
      },
      finance: {
        outstanding: fromMinor(outstandingMinor),
        collectedLastSevenDays: fromMinor(collectedWeekMinor),
        openInvoices: invoices.filter((i) => i.status !== InvoiceStatus.PAID).length,
      },
      staff: {
        active: activeStaff,
        lockedOut: lockedAccounts,
        awaitingPasswordChange: pendingPasswordChanges,
      },
      security: {
        deniedRequestsLastDay: auditFailures,
      },
      catalogue: {
        medicines: lowStockCount,
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
