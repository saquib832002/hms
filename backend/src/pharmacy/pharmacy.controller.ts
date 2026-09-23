import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole, TenantModule } from '@prisma/client';
import { PharmacyService, ReferralStatus } from './pharmacy.service';
import { DispenseDto } from './dto/dispense.dto';
import { CounterSaleDto } from './dto/counter-sale.dto';
import { DeclineReferralDto } from './dto/decline-referral.dto';
import { ReceiveStockDto } from './dto/receive-stock.dto';
import { ReverseDispenseDto } from './dto/reverse-dispense.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class InventoryQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;

  /**
   * `expiry` (default) or `name`.
   *
   * Defaulting to expiry rather than alphabetical: the list's job is "what
   * should leave the shelf next", and alphabetical order answers a different
   * question. Name order stays available because checking a count against a
   * physical shelf runs alphabetically.
   */
  @IsOptional() @IsIn(['expiry', 'name']) sort?: 'expiry' | 'name';
}

@Controller('pharmacy')
@RequiresModule(TenantModule.PHARMACY)
export class PharmacyController {
  constructor(private readonly pharmacy: PharmacyService) {}

  /**
   * ADMIN is excluded from everything on this controller that carries patient
   * rows — the queue, the prescription detail and the dispensing history all
   * name patients and their medicines. Stock and the catalogue are operational
   * and stay open to admin.
   */
  @Get('queue')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('DISPENSE_QUEUE_VIEW')
  queue() {
    return this.pharmacy.queue();
  }

  /** The prescription plus stock, suggested quantities and the allergy check. */
  @Get('prescriptions/:id')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('DISPENSE_PREPARE')
  prepare(@Param('id', ParseIntPipe) id: number) {
    return this.pharmacy.prepareDispense(id);
  }

  /**
   * Dispensing is a pharmacist's signature. Admin is deliberately excluded —
   * an operational role must not be able to sign for handing over medicine.
   */
  @Post('prescriptions/:id/dispense')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('PRESCRIPTION_DISPENSE')
  dispense(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DispenseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pharmacy.dispense(id, dto, user);
  }

  /**
   * Mark a prescription fully dispensed when no total can be computed.
   *
   * PHARMACIST only, like dispensing itself — it is the same signature, one
   * step later: saying the course is finished is a claim about what the patient
   * received, and only the person who handed it over can make it.
   *
   * The service refuses if any line is still known to be outstanding, and
   * refuses if nothing has been dispensed at all.
   */
  @Post('prescriptions/:id/complete')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('PRESCRIPTION_MARK_DISPENSED')
  markFullyDispensed(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.pharmacy.markFullyDispensed(id, user);
  }

  /**
   * Sell medicine with no prescription behind it.
   *
   * PHARMACIST only, like dispensing. Admin is excluded for the same reason:
   * handing medicine to a member of the public is a pharmacist's signature, and
   * an operational role must not be able to sign for it.
   */
  @Post('sales')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('COUNTER_SALE')
  counterSale(@Body() dto: CounterSaleDto, @CurrentUser() user: AuthUser) {
    return this.pharmacy.counterSale(dto, user);
  }

  /**
   * Prescriptions written at another hospital and sent here.
   *
   * PHARMACIST only, like the rest of this counter. Admin is excluded for the
   * same reason it is excluded from the dispensing queue: these name patients.
   */
  @Get('referrals')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('REFERRAL_QUEUE_VIEW')
  referrals(@Query('status') status?: string) {
    /*
     * Validated against the union rather than passed through.
     *
     * An unrecognised value falls back to the waiting queue instead of
     * erroring — this is a list filter reached from a tab, and a 400 on a
     * stale bookmark helps nobody. An empty result would be worse: it would
     * read as "no referrals" and send a pharmacist looking for a lost
     * prescription.
     */
    const allowed: ReferralStatus[] = ['waiting', 'dispensed', 'declined', 'all'];
    const chosen = allowed.find((s) => s === status) ?? 'waiting';
    return this.pharmacy.referrals(chosen);
  }

  @Post('referrals/:id/decline')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('REFERRAL_DECLINE')
  declineReferral(@Param('id', ParseIntPipe) id: number, @Body() dto: DeclineReferralDto) {
    return this.pharmacy.declineReferral(id, dto.reason);
  }

  /**
   * Undo a dispense while the medicine is still on this side of the counter.
   *
   * PHARMACIST only, like dispensing itself. Reversing a handover moves stock
   * and voids a bill; if signing for medicine going out is a pharmacist's
   * decision, so is signing for it not having gone.
   */
  @Post('dispense-events/:id/reverse')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('DISPENSE_REVERSE')
  reverseDispense(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReverseDispenseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pharmacy.reverseDispense(id, dto.reason.trim(), dto.notLeftPremises, user);
  }

  /**
   * The pharmacy's own numbers: sold, taken, given back.
   *
   * PHARMACIST and ADMIN. It carries no patient rows and no medicine names —
   * counts and money only — so it is operational rather than clinical, and an
   * owner reconciling the shop is exactly who else needs it.
   */
  @Get('dashboard')
  @Roles(UserRole.PHARMACIST, UserRole.ADMIN)
  @AuditAction('PHARMACY_DASHBOARD')
  dashboard() {
    return this.pharmacy.dashboard();
  }

  @Get('history')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('DISPENSE_HISTORY')
  history() {
    return this.pharmacy.history();
  }

  @Get('inventory')
  @Roles(UserRole.PHARMACIST, UserRole.ADMIN)
  inventory(@Query() query: InventoryQueryDto) {
    return this.pharmacy.inventory(query.q, query.sort ?? 'expiry');
  }

  @Post('stock')
  @Roles(UserRole.PHARMACIST, UserRole.ADMIN)
  @AuditAction('STOCK_RECEIVE')
  receive(@Body() dto: ReceiveStockDto, @CurrentUser() user: AuthUser) {
    return this.pharmacy.receiveStock(
      dto.medicineId,
      dto.batchNumber,
      new Date(dto.expiresAt),
      dto.quantity,
      user,
      dto.costPrice,
    );
  }
}
