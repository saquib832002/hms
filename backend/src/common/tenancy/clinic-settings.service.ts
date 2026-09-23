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
 * but this reads it through the request's own transaction rather than
 * `unscoped`. Same rows either way; the difference is that `unscoped` asked the
 * pool for a second connection while the request still held its first, which
 * deadlocked the pool. See `forTenant` below and the proxy in
 * `prisma.service.ts`.
 *
 * The tenant id still comes from the authenticated user's row, never from the
 * client.
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
    /*
     * NOT `unscoped`.
     *
     * `tenants` carries no RLS policy, so reading it inside the request's
     * transaction returns exactly the same row — and does not take a second
     * pool connection while the first is still held. That second connection
     * was the deadlock: see the proxy in `prisma.service.ts`.
     */
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        timezone: true,
        slotMinutes: true,
        clinicStartHour: true,
        clinicEndHour: true,
        pharmacyBilling: true,
        hasPharmacy: true,
        acceptsExternalPrescriptions: true,
        labBilling: true,
        hasLab: true,
        acceptsExternalLabOrders: true,
        acceptedReferralBilling: true,
        currency: true,
        taxEnabled: true,
        pricesIncludeTax: true,
        consultationTaxRateId: true,
      },
    });

    if (!t) throw new NotFoundException('Hospital not found');

    // Column defaults cover a row written before these fields existed.
    return {
      timezone: t.timezone ?? DEFAULT_CLINIC.timezone,
      slotMinutes: t.slotMinutes ?? DEFAULT_CLINIC.slotMinutes,
      clinicStartHour: t.clinicStartHour ?? DEFAULT_CLINIC.clinicStartHour,
      clinicEndHour: t.clinicEndHour ?? DEFAULT_CLINIC.clinicEndHour,
      pharmacyBilling: t.pharmacyBilling ?? DEFAULT_CLINIC.pharmacyBilling,
      hasPharmacy: t.hasPharmacy ?? DEFAULT_CLINIC.hasPharmacy,
      acceptsExternalPrescriptions:
        t.acceptsExternalPrescriptions ?? DEFAULT_CLINIC.acceptsExternalPrescriptions,
      labBilling: t.labBilling ?? DEFAULT_CLINIC.labBilling,
      hasLab: t.hasLab ?? DEFAULT_CLINIC.hasLab,
      acceptsExternalLabOrders:
        t.acceptsExternalLabOrders ?? DEFAULT_CLINIC.acceptsExternalLabOrders,
      /*
       * An empty array is a real answer and must survive. `??` and not `||`,
       * because `[] || fallback` yields the fallback — silently re-granting an
       * arrangement a lab deliberately turned off, which is the one direction
       * this must never fail.
       */
      acceptedReferralBilling:
        t.acceptedReferralBilling ?? DEFAULT_CLINIC.acceptedReferralBilling,
      currency: t.currency ?? DEFAULT_CLINIC.currency,
      /*
       * Tax, off by default.
       *
       * An explicit switch rather than "are any rates defined": a hospital
       * sets its table up, checks it, and turns it on when ready. The
       * consultation rate is separate from the medicine default on purpose —
       * Indian healthcare services are exempt while the medicines dispensed at
       * the same visit are not, and one rate covering both would be wrong for
       * whichever was configured second.
       */
      taxEnabled: t.taxEnabled ?? false,
      pricesIncludeTax: t.pricesIncludeTax ?? false,
      consultationTaxRateId: t.consultationTaxRateId ?? null,
    };
  }
}
