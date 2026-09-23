import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole, TenantModule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { currentTenantId } from '../common/tenancy/tenant-context';

class AddPartnerDto {
  /**
   * The slug the other pharmacy gives you, offline.
   *
   * Not a picker over a list of hospitals: that list is the vendor's customer
   * base, and making it browsable by every doctor on the platform is the same
   * enumeration problem the public signup form refuses. Two businesses agree to
   * work together and one of them passes over a short code.
   */
  @IsString() @MinLength(2) @MaxLength(60) slug: string;

  /** What this hospital wants to call them in the doctor's dropdown. */
  @IsString() @MinLength(2) @MaxLength(120) label: string;
}

/**
 * The pharmacies this hospital may send prescriptions to.
 *
 * TWO-SIDED, AND BOTH SIDES MATTER
 * --------------------------------
 * The receiving pharmacy sets `acceptsExternalPrescriptions`; the sending
 * hospital adds them here. Neither alone is enough. Without the first, a
 * hospital could push work onto a pharmacy that never agreed to handle it.
 * Without the second, a doctor would be choosing from a global list — which is
 * both a customer-list disclosure and a way to send a patient's data to an
 * organisation nobody at this hospital has ever dealt with.
 *
 * ADMIN, NOT DOCTOR
 * -----------------
 * Who this hospital does business with is an administrative decision. A doctor
 * chooses among the partners; they do not add them.
 */
@Controller('pharmacy-partners')
@RequiresModule(TenantModule.PHARMACY)
export class PharmacyPartnersController {
  constructor(private prisma: PrismaService) {}

  /**
   * Readable by any clinician, because the prescribing screen needs it.
   *
   * It carries nothing sensitive: the names this hospital chose for pharmacies
   * it has already agreed to work with.
   */
  @Get()
  @Roles(UserRole.ADMIN, UserRole.DOCTOR, UserRole.PHARMACIST)
  async findAll() {
    const rows = await this.prisma.pharmacyPartner.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
      select: { id: true, label: true, partnerTenantId: true, createdAt: true },
    });
    return { data: rows };
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @AuditAction('PHARMACY_PARTNER_ADD')
  async add(@Body() dto: AddPartnerDto) {
    const slug = dto.slug.trim().toLowerCase();

    /*
     * The hospital being looked up is by definition not this one, and that is
     * fine: `tenants` is a global model with no RLS policy, so this is a
     * lookup rather than a hole — and it deliberately answers on one condition
     * only.
     *
     * The scoped client, not `unscoped`.
     *
     * This is still a cross-tenant lookup and still works: `tenants` carries no
     * RLS policy, so the request's `app.tenant_id` does not narrow it. What
     * changes is that it no longer asks the pool for a second connection while
     * the request's transaction holds the first — the deadlock described in
     * `prisma.service.ts`.
     */
    const target = await this.prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, isActive: true, hasPharmacy: true, acceptsExternalPrescriptions: true },
    });

    /*
     * One answer for every failure, and that is the point.
     *
     * "No such hospital", "they have no pharmacy" and "they do not accept
     * external prescriptions" are all reported identically. Distinguishing them
     * would turn this endpoint into an oracle: an administrator could walk
     * plausible slugs and learn which hospitals exist on the platform and what
     * they have configured. The same reasoning as the login form refusing to
     * separate "no such account" from "wrong password".
     */
    if (!target || !target.isActive || !target.hasPharmacy || !target.acceptsExternalPrescriptions) {
      throw new NotFoundException(
        'No pharmacy is accepting prescriptions under that code. Check it with them — they have to switch it on at their end first.',
      );
    }

    if (target.id === currentTenantId()) {
      throw new BadRequestException('That is this hospital. Prescriptions stay in-house by default.');
    }

    /*
     * A removed partner is re-added, not refused.
     *
     * Remove is a soft delete — it has to be, because prescriptions already
     * sent there carry `routedToTenantId` and a vanished row leaves those
     * pointing at nothing. But the list shows only active rows and the unique
     * index covers every row, active or not. So a hospital that removed a
     * partner and later wanted them back was told "already one of your
     * partners" about something it could not see, with nothing in the UI able
     * to resolve it. Reported from use, and it was a dead end: the only exit
     * was a database console.
     *
     * Ending a partnership and never speaking to them again are different
     * things, and the second is not what "Remove" promised.
     */
    const existing = await this.prisma.pharmacyPartner.findFirst({
      where: { tenantId: currentTenantId(), partnerTenantId: target.id },
      select: { id: true, isActive: true },
    });

    if (existing?.isActive) {
      throw new ConflictException('That pharmacy is already one of your partners');
    }

    if (existing) {
      // The label is taken from this attempt rather than the old row: the
      // hospital is typing it now, and may well be correcting what it says.
      return this.prisma.pharmacyPartner.update({
        where: { id: existing.id },
        data: { isActive: true, label: dto.label.trim() },
        select: { id: true, label: true, partnerTenantId: true, createdAt: true },
      });
    }

    try {
      return await this.prisma.pharmacyPartner.create({
        data: {
          tenantId: currentTenantId(),
          partnerTenantId: target.id,
          label: dto.label.trim(),
        },
        select: { id: true, label: true, partnerTenantId: true, createdAt: true },
      });
    } catch (err) {
      /*
       * Only the unique violation, and only after the check above has already
       * ruled out the ordinary case — this is now the two-administrators-at-
       * once race and nothing else.
       *
       * The bare `catch` this replaces reported *every* failure as "already a
       * partner", so a database outage during an add would have sent somebody
       * looking for a partner row that was never written.
       */
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('That pharmacy is already one of your partners');
      }
      throw err;
    }
  }

  /**
   * Deactivated, not deleted.
   *
   * Prescriptions already sent there carry `routedToTenantId`, and a partner
   * row that vanished would leave those pointing at nothing — "where did this
   * go" is a question somebody asks precisely when a partnership has ended.
   */
  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('PHARMACY_PARTNER_REMOVE')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const existing = await this.prisma.pharmacyPartner.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Partner ${id} not found`);

    await this.prisma.pharmacyPartner.update({ where: { id }, data: { isActive: false } });
    return { id, removed: true };
  }
}
