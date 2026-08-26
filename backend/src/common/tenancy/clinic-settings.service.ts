import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClinicSettings, DEFAULT_CLINIC } from './clinic-settings';
import { currentScope } from './tenant-context';

/**
 * Reads the calling hospital's clinic day.
 *
 * One indexed primary-key lookup per call, which is the same cost JwtStrategy
 * already pays to re-read the user. Deliberately not cached in memory: an admin
 * changing the clinic hours expects the next booking screen to reflect it, and
 * a cache invalidated across processes is a much larger problem than one small
 * query.
 *
 * `tenants` carries no RLS policy — it is the directory the policies key on —
 * so this reads through `unscoped`. The tenant id still comes from the
 * authenticated user's row, never from the client.
 */
@Injectable()
export class ClinicSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The current request's hospital. */
  async current(): Promise<ClinicSettings> {
    const scope = currentScope();
    if (!scope) {
      // No tenant in scope means this ran outside a request — a scheduled job
      // or a script. Those must name the hospital they mean.
      throw new Error(
        'No tenant in scope: clinic settings were requested outside a tenant-scoped request.',
      );
    }
    return this.forTenant(scope.tenantId);
  }

  async forTenant(tenantId: number): Promise<ClinicSettings> {
    const t = await this.prisma.unscoped.tenant.findUnique({
      where: { id: tenantId },
      select: {
        timezone: true,
        slotMinutes: true,
        clinicStartHour: true,
        clinicEndHour: true,
        currency: true,
      },
    });

    if (!t) throw new NotFoundException('Hospital not found');

    // Column defaults cover a row written before these fields existed.
    return {
      timezone: t.timezone ?? DEFAULT_CLINIC.timezone,
      slotMinutes: t.slotMinutes ?? DEFAULT_CLINIC.slotMinutes,
      clinicStartHour: t.clinicStartHour ?? DEFAULT_CLINIC.clinicStartHour,
      clinicEndHour: t.clinicEndHour ?? DEFAULT_CLINIC.clinicEndHour,
      currency: t.currency ?? DEFAULT_CLINIC.currency,
    };
  }
}
