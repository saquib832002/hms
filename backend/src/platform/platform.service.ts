import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditOutcome } from '@prisma/client';
import { verify } from '@node-rs/argon2';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
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
