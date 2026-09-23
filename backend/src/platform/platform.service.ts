import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  AuditOutcome,
  SubscriptionStatus,
  TenantApplicationStatus,
  TenantModule,
  UserRole,
} from '@prisma/client';
import { hash, verify } from '@node-rs/argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { planProvision } from './provisioning';
import { generateTemporaryPassword } from '../users/account-rules';

import { randomBytes } from 'crypto';
import { canWrite, daysRemaining } from '../common/subscription/subscription';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';
import { PLATFORM_AUDIENCE, PlatformPrincipal } from './platform-auth';
import {
  expiryFrom,
  grantState,
  isGrantActive,
  minutesRemaining,
  validateGrantRequest,
} from './break-glass';

/**
 * Vendor-side operations. Deliberately narrow.
 *
 * WHAT PLATFORM STAFF CAN SEE, AND WHAT THEY CANNOT
 * -------------------------------------------------
 * Aggregates and configuration. Never a patient row, a diagnosis, a medicine
 * name or a staff member's clinical activity.
 *
 * That is a decision, not an oversight. Almost all support work is "why is this
 * hospital's booking grid empty" or "did the migration apply", and both are
 * answerable from counts and settings. Reading actual patient data would need a
 * BAA conversation, a stated clinical justification and probably the hospital's
 * consent per incident — so it is left out entirely rather than half-built.
 *
 * If it is ever added, it belongs behind its own grant type, and this comment
 * is the argument for why it should be hard to get.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly clinic: ClinicSettingsService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.unscoped.platformUser.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    const invalid = () => new UnauthorizedException('Invalid email or password');

    if (!user || !user.isActive) {
      // Same constant-time-ish shape as the hospital login: spend the cost of a
      // verification so a missing account is not detectable by response time.
      await verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$1FDJLLhTZaXLcHnDLZOnJDBFH0eB4h5tDbTNXvXhWLg',
        password,
      ).catch(() => false);
      throw invalid();
    }

    const ok = await verify(user.passwordHash, password).catch(() => false);
    if (!ok) throw invalid();

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email },
      {
        secret: this.config.get<string>('jwt.accessSecret'),
        audience: PLATFORM_AUDIENCE,
        expiresIn: '30m' as unknown as number,
      },
    );

    return {
      accessToken,
      user: { id: user.id, email: user.email, fullName: user.fullName },
    };
  }

  /**
   * The hospitals on this deployment, with operational counts only.
   *
   * Row counts are not PHI: "this hospital has 412 patients" reveals nothing
   * about any of them. A breakdown by diagnosis would, which is why there
   * isn't one.
   */
  // ── applications ──────────────────────────────────────────────────────────

  /**
   * People who asked to become customers.
   *
   * `unscoped` because `tenant_applications` carries the inverted RLS policy:
   * visible only when no hospital is in scope, which is exactly the condition a
   * platform request satisfies (`PlatformGuard` deliberately sets no `req.user`
   * and `TenantInterceptor` therefore opens no tenant transaction).
   */
  async applications(status?: TenantApplicationStatus) {
    const rows = await this.prisma.unscoped.tenantApplication.findMany({
      where: status ? { status } : {},
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      include: { reviewedBy: { select: { email: true } } },
    });

    /*
     * A repeat applicant is flagged here rather than refused at the form.
     *
     * The public endpoint deliberately gives the same answer whether or not an
     * email has applied before, so it cannot be used to enumerate customers.
     * That means duplicates reach this queue, and the reviewer is the one who
     * should see them — otherwise the same hospital gets provisioned twice.
     */
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.contactEmail, (counts.get(r.contactEmail) ?? 0) + 1);

    return {
      data: rows.map((r) => ({
        id: r.id,
        hospitalName: r.hospitalName,
        requestedSlug: r.requestedSlug,
        contactName: r.contactName,
        contactEmail: r.contactEmail,
        contactPhone: r.contactPhone,
        timezone: r.timezone,
        currency: r.currency,
        notes: r.notes,
        status: r.status,
        tenantId: r.tenantId,
        reviewedBy: r.reviewedBy?.email ?? null,
        reviewedAt: r.reviewedAt,
        reviewNote: r.reviewNote,
        createdAt: r.createdAt,
        submittedFromIp: r.submittedFromIp,
        /** More than one application from this address. */
        duplicateOfEmail: (counts.get(r.contactEmail) ?? 0) > 1,
      })),
    };
  }

  /** Turn an application into a hospital. */
  async approveApplication(
    actor: PlatformPrincipal,
    id: number,
    overrides: {
      slug?: string;
      timezone?: string;
      currency?: string;
      adminName?: string;
      modules?: TenantModule[];
    } = {},
  ) {
    const application = await this.prisma.unscoped.tenantApplication.findUnique({ where: { id } });
    if (!application) throw new NotFoundException(`Application ${id} not found`);
    if (application.status !== TenantApplicationStatus.PENDING) {
      throw new ConflictException(
        `That application is already ${application.status.toLowerCase()}. Approving it again would create a second hospital for the same customer.`,
      );
    }

    const created = await this.provision(actor, {
      hospitalName: application.hospitalName,
      slug: overrides.slug ?? application.requestedSlug,
      adminEmail: application.contactEmail,
      adminName: overrides.adminName ?? application.contactName,
      timezone: overrides.timezone ?? application.timezone,
      currency: overrides.currency ?? application.currency,
      /*
       * Decided at approval, by the human reading the application. A form on
       * the internet must not choose what it is sold — the signup endpoint
       * creates no tenant at all, and this is the same argument one field
       * further on.
       */
      modules: overrides.modules,
    });

    await this.prisma.unscoped.tenantApplication.update({
      where: { id },
      data: {
        status: TenantApplicationStatus.APPROVED,
        tenantId: created.tenant.id,
        reviewedById: actor.platformUserId,
        reviewedAt: new Date(),
      },
    });

    return created;
  }

  async rejectApplication(actor: PlatformPrincipal, id: number, reason: string) {
    const application = await this.prisma.unscoped.tenantApplication.findUnique({ where: { id } });
    if (!application) throw new NotFoundException(`Application ${id} not found`);
    if (application.status !== TenantApplicationStatus.PENDING) {
      throw new ConflictException(`That application is already ${application.status.toLowerCase()}`);
    }

    // Required, and kept. "Why did we turn them down" is a question somebody
    // asks months later, usually when the same hospital applies again.
    await this.prisma.unscoped.tenantApplication.update({
      where: { id },
      data: {
        status: TenantApplicationStatus.REJECTED,
        reviewedById: actor.platformUserId,
        reviewedAt: new Date(),
        reviewNote: reason.trim(),
      },
    });

    return { id, status: TenantApplicationStatus.REJECTED };
  }

  // ── provisioning ──────────────────────────────────────────────────────────

  /**
   * Create a hospital and its first administrator.
   *
   * ONE TRANSACTION, AND WHY IT HAS TO BE
   * -------------------------------------
   * A tenant with no admin is a hospital nobody can sign into, and it holds the
   * slug — so the retry collides with the wreckage of the first attempt. An
   * admin with no tenant is worse: a `User` row whose `tenantId` points nowhere.
   * Either half alone is unusable and neither is obviously broken from outside.
   *
   * THE TEMPORARY PASSWORD IS RETURNED EXACTLY ONCE
   * -----------------------------------------------
   * It is hashed on the way in and never readable again, so this response is
   * the only chance to see it. That is the same shape as `POST /users`, and it
   * is why the console shows it on a screen the reviewer has to acknowledge
   * rather than in a toast that disappears.
   *
   * `mustChangePassword` is set, so the first thing the administrator does is
   * replace it — which is also why `SubscriptionGuard` exempts the password
   * change route.
   */
  async provision(
    actor: PlatformPrincipal,
    input: {
      hospitalName: string;
      slug?: string | null;
      adminEmail: string;
      adminName: string;
      timezone?: string | null;
      currency?: string | null;
      /** Days of trial. Null or absent means open-ended. */
      trialDays?: number | null;
      /**
       * What they are being sold.
       *
       * Absent means the schema default — every module — deliberately. A
       * standalone laboratory is a narrowing somebody chooses on the approval
       * screen; defaulting a new hospital to nothing would make a forgotten
       * field look like a decision, and the customer's first hour would be a
       * product that refuses to book an appointment.
       */
      modules?: TenantModule[] | null;
    },
  ) {
    const existing = await this.prisma.unscoped.tenant.findMany({ select: { slug: true } });
    const plan = planProvision(input, new Set(existing.map((t) => t.slug)));

    const temporaryPassword = generateTemporaryPassword((n) => randomBytes(n));
    const passwordHash = await hash(temporaryPassword);

    const endsAt =
      input.trialDays && input.trialDays > 0
        ? new Date(Date.now() + input.trialDays * 86_400_000)
        : null;

    const tenant = await this.prisma.unscoped.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          slug: plan.slug,
          name: plan.name,
          timezone: plan.timezone,
          currency: plan.currency,
          subscriptionStatus: SubscriptionStatus.TRIAL,
          subscriptionEndsAt: endsAt,
          // Omitted rather than defaulted here, so the default lives in exactly
          // one place — the schema — and cannot drift from the migration that
          // backfilled every hospital that predates modules.
          ...(input.modules ? { modules: [...new Set(input.modules)] } : {}),
        },
      });

      /*
       * Enter the new hospital's scope before writing anything belonging to it.
       *
       * THE BUG THIS FIXES, FOUND ON THE FIRST LIVE RUN
       * -----------------------------------------------
       * `unscoped` connects as `hms_app`, which is a non-superuser and is
       * therefore subject to RLS. `tenants` has no policy — it is a global
       * model, which is why the create above succeeded — but `users` does, and
       * its WITH CHECK is `tenantId = app_current_tenant()`. With no tenant set
       * on the transaction, `app_current_tenant()` is NULL, the check fails,
       * and provisioning died between creating the hospital and creating the
       * only account that can sign into it.
       *
       * `set_config(..., true)` is transaction-local, exactly as
       * `PrismaService.forTenant` does it — a plain `SET` would persist on the
       * pooled connection and leak this tenant into whichever request picked it
       * up next.
       *
       * Setting the scope here is honest rather than a workaround: the vendor
       * is legitimately writing a row that belongs to this new hospital, and
       * the policy should hold for that write like any other.
       */
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t.id)}, true)`;

      await tx.user.create({
        data: {
          tenantId: t.id,
          email: plan.adminEmail,
          fullName: plan.adminName,
          role: UserRole.ADMIN,
          passwordHash,
          mustChangePassword: true,
          // The assignment, not just the default column. `User.role` is where
          // they land; `UserRoleAssignment` is what they may act as, and the
          // last-admin check counts holders rather than defaults.
          roleAssignments: { create: [{ tenantId: t.id, role: UserRole.ADMIN }] },
        },
      });

      return t;
    });

    /*
     * Written to the new hospital's own audit log.
     *
     * Its first entry is "the vendor created this hospital and this account",
     * which is exactly what an auditor asking how the administrator came to
     * exist needs to see. `actorRole` stays null for the usual reason.
     */
    this.audit.record({
      tenantId: tenant.id,
      userId: null,
      actorEmail: actor.email,
      actorRole: null,
      action: 'PLATFORM_TENANT_PROVISIONED',
      method: 'POST',
      path: '/api/v1/platform/tenants',
      targetType: 'Tenant',
      targetId: tenant.id,
      outcome: AuditOutcome.SUCCESS,
      statusCode: 201,
    });

    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        timezone: tenant.timezone,
        currency: tenant.currency,
        subscriptionStatus: tenant.subscriptionStatus,
        subscriptionEndsAt: tenant.subscriptionEndsAt,
      },
      administrator: {
        email: plan.adminEmail,
        fullName: plan.adminName,
        /** Shown once. Never retrievable again — it is stored only as a hash. */
        temporaryPassword,
      },
    };
  }

  // ── subscription ──────────────────────────────────────────────────────────

  /**
   * Set where a hospital stands commercially.
   *
   * The only lever the vendor has over a running hospital, and it is
   * deliberately a blunt one: writes stop, reads never do. See
   * `common/subscription/subscription.ts` for why that line is where it is.
   */
  /**
   * What a hospital has been sold.
   *
   * Separate from the subscription and deliberately so: one is what they bought
   * and the other is whether they have paid. Collapsing them would mean an
   * overdue invoice silently taking away a module, and restoring the payment
   * silently giving one back — two different decisions taken by two different
   * people at two different times.
   *
   * REMOVING ONE IS NOT A DELETION, AND THE RESPONSE SAYS SO
   * -------------------------------------------------------
   * `ModuleGuard` refuses writes and never a read, so the hospital keeps every
   * record it already has and simply cannot create more. That is the same line
   * the subscription holds, for the same reason: a clinician cannot un-know
   * that a test was run, and the person harmed by hiding it is not the person
   * who took the commercial decision.
   *
   * The count of what already exists comes back with the change so the console
   * can say it plainly. "Removing the laboratory" and "removing the laboratory
   * from a hospital with 4,200 results in it" are different acts, and only one
   * of them should be done without a conversation.
   */
  async setModules(actor: PlatformPrincipal, tenantId: number, modules: TenantModule[]) {
    const tenant = await this.prisma.unscoped.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const unique = [...new Set(modules)];
    const removed = tenant.modules.filter((m) => !unique.includes(m));

    const updated = await this.prisma.unscoped.tenant.update({
      where: { id: tenantId },
      data: { modules: unique },
    });

    /*
     * Written into the hospital's own log, not a vendor-side one.
     *
     * The morning their staff find a menu item gone, somebody there will ask
     * what changed. That answer belongs in their records rather than in a
     * system they have to ask us to search.
     */
    this.audit.record({
      tenantId,
      userId: null,
      actorEmail: actor.email,
      actorRole: null,
      action: 'PLATFORM_MODULES_CHANGED',
      method: 'PATCH',
      path: `/api/v1/platform/tenants/${tenantId}/modules`,
      targetType: 'Tenant',
      targetId: tenantId,
      outcome: AuditOutcome.SUCCESS,
      statusCode: 200,
    });

    return {
      id: updated.id,
      name: updated.name,
      modules: updated.modules,
      removed,
      /*
       * What the hospital still holds in a module just taken away. Reported so
       * the console can warn rather than leaving the vendor to find out from
       * the customer.
       */
      strandedRecords: await this.countFor(tenantId, removed),
    };
  }

  /** How much data sits behind each removed module. Counts only, never rows. */
  private async countFor(tenantId: number, removed: TenantModule[]) {
    const counts: { module: TenantModule; records: number }[] = [];
    for (const module of removed) {
      const records = await this.recordCount(tenantId, module);
      if (records > 0) counts.push({ module, records });
    }
    return counts;
  }

  private async recordCount(tenantId: number, module: TenantModule): Promise<number> {
    const db = this.prisma.unscoped;
    switch (module) {
      case 'LABORATORY':
        return db.labOrder.count({ where: { tenantId } });
      case 'PHARMACY':
        return db.dispenseEvent.count({ where: { tenantId } });
      case 'WARDS':
        return db.admission.count({ where: { tenantId } });
      case 'CLINIC':
        return db.appointment.count({ where: { tenantId } });
      case 'BILLING':
        return db.invoice.count({ where: { tenantId } });
      default:
        return 0;
    }
  }

  async setSubscription(
    actor: PlatformPrincipal,
    tenantId: number,
    input: { status: SubscriptionStatus; endsAt?: string | null; note?: string | null },
  ) {
    const tenant = await this.prisma.unscoped.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const endsAt =
      input.endsAt === undefined ? tenant.subscriptionEndsAt : input.endsAt ? new Date(input.endsAt) : null;

    if (endsAt !== null && Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('endsAt must be a date');
    }

    const updated = await this.prisma.unscoped.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionStatus: input.status,
        subscriptionEndsAt: endsAt,
        ...(input.note !== undefined ? { subscriptionNote: input.note?.trim() || null } : {}),
      },
    });

    /*
     * Audited into the hospital's own log, and this one matters more than most:
     * the moment their staff stop being able to save anything, somebody there
     * will ask what changed, and the answer should be in their records rather
     * than in the vendor's.
     */
    this.audit.record({
      tenantId,
      userId: null,
      actorEmail: actor.email,
      actorRole: null,
      action: 'PLATFORM_SUBSCRIPTION_CHANGED',
      method: 'PATCH',
      path: `/api/v1/platform/tenants/${tenantId}/subscription`,
      targetType: 'Tenant',
      targetId: tenantId,
      outcome: AuditOutcome.SUCCESS,
      statusCode: 200,
    });

    return {
      id: updated.id,
      name: updated.name,
      subscriptionStatus: updated.subscriptionStatus,
      subscriptionEndsAt: updated.subscriptionEndsAt,
      subscriptionNote: updated.subscriptionNote,
      canWrite: canWrite({ status: updated.subscriptionStatus, endsAt: updated.subscriptionEndsAt }),
      daysRemaining: daysRemaining({
        status: updated.subscriptionStatus,
        endsAt: updated.subscriptionEndsAt,
      }),
    };
  }

  async tenants() {
    const rows = await this.prisma.unscoped.tenant.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        slug: true,
        name: true,
        isActive: true,
        timezone: true,
        currency: true,
        subscriptionStatus: true,
        subscriptionEndsAt: true,
        subscriptionNote: true,
        modules: true,
        createdAt: true,
        _count: { select: { users: true, patients: true } },
      },
    });

    return {
      data: rows.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        isActive: t.isActive,
        timezone: t.timezone,
        currency: t.currency,
        createdAt: t.createdAt,
        users: t._count.users,
        patients: t._count.patients,
        subscriptionStatus: t.subscriptionStatus,
        subscriptionEndsAt: t.subscriptionEndsAt,
        subscriptionNote: t.subscriptionNote,
        /*
         * What they were sold, beside whether they have paid for it. The two
         * are separate decisions and the console shows them together because
         * "why can this hospital not book an appointment" has two possible
         * answers and only one screen to answer it from.
         */
        modules: t.modules,
        /*
         * Derived here rather than in the console, so the vendor's screen and
         * the guard that actually refuses writes cannot disagree about who is
         * currently restricted. Two implementations of the same rule is how a
         * dashboard ends up showing "active" for a hospital that has been
         * unable to save anything since Tuesday.
         */
        canWrite: canWrite({
          status: t.subscriptionStatus,
          endsAt: t.subscriptionEndsAt,
        }),
        daysRemaining: daysRemaining({
          status: t.subscriptionStatus,
          endsAt: t.subscriptionEndsAt,
        }),
      })),
    };
  }

  /** Open a time-boxed grant against one hospital. */
  async openGrant(
    actor: PlatformPrincipal,
    input: { tenantId: number; reason?: string; minutes?: number; ticketRef?: string },
  ) {
    const { reason, minutes } = validateGrantRequest(input);

    const tenant = await this.prisma.unscoped.tenant.findUnique({
      where: { id: input.tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) throw new NotFoundException('Hospital not found');

    const grant = await this.prisma.unscoped.breakGlassGrant.create({
      data: {
        tenantId: tenant.id,
        platformUserId: actor.platformUserId,
        createdById: actor.platformUserId,
        reason,
        ticketRef: input.ticketRef?.trim() || null,
        expiresAt: expiryFrom(minutes),
      },
    });

    /*
     * Written to the HOSPITAL's audit log, not a vendor-side one.
     *
     * The hospital has to be able to answer "who from the vendor had access to
     * our data, when, and why" from its own records. A log the vendor keeps and
     * the hospital must request is not the same assurance.
     */
    this.audit.record({
      tenantId: tenant.id,
      userId: null,
      actorEmail: actor.email,
      // actorRole stays null: this principal holds no UserRole, and inventing
      // one would make a platform action look like a staff action in reports.
      actorRole: null,
      action: 'PLATFORM_BREAK_GLASS_OPENED',
      method: 'POST',
      path: '/api/v1/platform/break-glass',
      targetType: 'Tenant',
      targetId: tenant.id,
      outcome: AuditOutcome.SUCCESS,
      statusCode: 201,
    });

    return this.describeGrant(grant, tenant.name);
  }

  async listGrants(actor: PlatformPrincipal) {
    const grants = await this.prisma.unscoped.breakGlassGrant.findMany({
      where: { platformUserId: actor.platformUserId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { tenant: { select: { name: true } } },
    });

    return { data: grants.map((g) => this.describeGrant(g, g.tenant.name)) };
  }

  async revokeGrant(actor: PlatformPrincipal, id: number) {
    const grant = await this.prisma.unscoped.breakGlassGrant.findUnique({
      where: { id },
      include: { tenant: { select: { id: true, name: true } } },
    });
    if (!grant) throw new NotFoundException('Grant not found');
    if (grant.platformUserId !== actor.platformUserId) {
      throw new ForbiddenException('That grant belongs to someone else');
    }

    const revoked = grant.revokedAt
      ? grant
      : await this.prisma.unscoped.breakGlassGrant.update({
          where: { id },
          data: { revokedAt: new Date() },
        });

    this.audit.record({
      tenantId: grant.tenant.id,
      userId: null,
      actorEmail: actor.email,
      actorRole: null,
      action: 'PLATFORM_BREAK_GLASS_REVOKED',
      method: 'DELETE',
      path: '/api/v1/platform/break-glass/:id',
      targetType: 'Tenant',
      targetId: grant.tenant.id,
      outcome: AuditOutcome.SUCCESS,
      statusCode: 200,
    });

    return this.describeGrant(revoked, grant.tenant.name);
  }

  /**
   * Operational facts about one hospital, behind an active grant.
   *
   * Everything here answers a support question without naming a person:
   * whether the migration applied, whether RLS is on, what the clinic day is,
   * how many denials there have been. The counts are read inside the hospital's
   * own tenant transaction, so even this path goes through RLS rather than
   * around it.
   */
  async diagnostics(actor: PlatformPrincipal, tenantId: number) {
    const grant = await this.requireActiveGrant(actor, tenantId);

    const tenant = await this.prisma.unscoped.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, isActive: true },
    });
    if (!tenant) throw new NotFoundException('Hospital not found');

    const settings = await this.clinic.forTenant(tenantId);

    const counts = await this.prisma.forTenant(tenantId, async () => ({
      patients: await this.prisma.patient.count(),
      users: await this.prisma.user.count(),
      appointments: await this.prisma.appointment.count(),
      auditFailuresLastDay: await this.prisma.auditLog.count({
        where: {
          outcome: AuditOutcome.FAILURE,
          createdAt: { gte: new Date(Date.now() - 86_400_000) },
        },
      }),
    }));

    this.audit.record({
      tenantId,
      userId: null,
      actorEmail: actor.email,
      actorRole: null,
      action: 'PLATFORM_DIAGNOSTICS_VIEWED',
      method: 'GET',
      path: '/api/v1/platform/tenants/:id/diagnostics',
      targetType: 'Tenant',
      targetId: tenantId,
      outcome: AuditOutcome.SUCCESS,
      statusCode: 200,
    });

    return {
      tenant,
      clinic: settings,
      counts,
      /*
       * Process-wide, not this hospital's — labelled as such because a number
       * that looks tenant-scoped and is not would be read wrong at 3am.
       *
       * `spilled > 0` means audit rows are sitting in a file rather than the
       * table, which is the single most useful thing support can know here:
       * the trail is incomplete until `npm run audit:replay` has run.
       */
      process: { audit: this.audit.stats() },
      grant: { id: grant.id, minutesRemaining: minutesRemaining(grant), reason: grant.reason },
      /** Stated on the response so it is obvious in a support transcript. */
      note: 'Aggregates and configuration only. No patient records are accessible through the platform API.',
    };
  }

  /**
   * Every request under break-glass re-checks the grant.
   *
   * Not once at grant time: a revoked grant must stop working immediately, and
   * an expired one must stop working without anyone having to act. A refusal is
   * audited too — an attempt to use a dead grant is exactly the row a hospital
   * would want to see.
   */
  private async requireActiveGrant(actor: PlatformPrincipal, tenantId: number) {
    const grant = await this.prisma.unscoped.breakGlassGrant.findFirst({
      where: { platformUserId: actor.platformUserId, tenantId },
      orderBy: { createdAt: 'desc' },
    });

    if (!grant || !isGrantActive(grant)) {
      this.audit.record({
        tenantId,
        userId: null,
        actorEmail: actor.email,
        actorRole: null,
        action: 'PLATFORM_ACCESS_DENIED_NO_GRANT',
        method: 'GET',
        path: '/api/v1/platform/tenants/:id/diagnostics',
        targetType: 'Tenant',
        targetId: tenantId,
        outcome: AuditOutcome.FAILURE,
        statusCode: 403,
      });

      throw new ForbiddenException(
        grant
          ? `Your break-glass grant for this hospital is ${grantState(grant)}. Open a new one.`
          : 'No break-glass grant for this hospital.',
      );
    }

    return grant;
  }

  private describeGrant(
    grant: {
      id: number;
      tenantId: number;
      reason: string;
      ticketRef: string | null;
      expiresAt: Date;
      revokedAt: Date | null;
      createdAt: Date;
    },
    hospitalName: string,
  ) {
    return {
      id: grant.id,
      tenantId: grant.tenantId,
      hospital: hospitalName,
      reason: grant.reason,
      ticketRef: grant.ticketRef,
      state: grantState(grant),
      minutesRemaining: minutesRemaining(grant),
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      createdAt: grant.createdAt,
    };
  }
}
