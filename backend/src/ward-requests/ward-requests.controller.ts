import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { UserRole, TenantModule } from '@prisma/client';
import { WardRequestsService } from './ward-requests.service';
import {
  CreateMedicationRequestDto,
  CreateSupplyRequestDto,
  DeclineRequestDto,
  FulfilMedicationRequestDto,
  SupplyDto,
} from './dto/ward-requests.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

/** `?status=` on both queues. An unknown value falls back to the open items. */
function queueStatus<T extends string>(allowed: readonly T[], raw: string | undefined, fallback: T): T {
  /*
   * Falls back rather than erroring, and never returns an empty result for a
   * bad value. A 400 on a stale bookmark helps nobody, and an empty list would
   * read as "no requests" — which sends a pharmacist away from a queue that
   * actually has work in it.
   */
  return allowed.find((s) => s === raw) ?? fallback;
}

/**
 * What a ward asked the pharmacy for.
 *
 * NURSE raises, PHARMACIST answers. Admin is excluded from all of it: these
 * rows name a patient, a bed and a medicine, which is clinical by the same
 * reading that keeps admin off the ward board and the dispensing queue.
 */
@Controller('supply-requests')
@RequiresModule(TenantModule.WARDS)
export class SupplyRequestsController {
  constructor(private readonly requests: WardRequestsService) {}

  @Get()
  @Roles(UserRole.PHARMACIST)
  @AuditAction('SUPPLY_QUEUE_VIEW')
  queue(@Query('status') status?: string) {
    const chosen = queueStatus(['waiting', 'supplied', 'declined', 'all'] as const, status, 'waiting');
    return this.requests.supplyQueue(chosen);
  }

  /**
   * Supplied — and this moves no stock.
   *
   * Decrementing here would give the hospital a second stock ledger beside
   * `DispenseEvent`, and skip batch selection, expiry, allergy checks and
   * pricing. The medicine leaves the shelf through dispensing, counted and
   * charged once; this records that the ward's request was answered.
   */
  @Post(':id/supply')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('SUPPLY_REQUEST_FULFIL')
  supply(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SupplyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requests.supply(id, dto.note, user);
  }

  @Post(':id/decline')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('SUPPLY_REQUEST_DECLINE')
  decline(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeclineRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requests.declineSupply(id, dto.reason, user);
  }
}

/**
 * What a nurse asked a doctor to prescribe.
 *
 * NURSE raises, DOCTOR answers, and there is no third option. The only ways a
 * request closes are a real `Prescription` written by a doctor through the
 * ordinary prescribing route, or a decline carrying a reason. Nothing here
 * writes a prescription, which is what keeps "a nurse asks, a nurse never
 * prescribes" true rather than merely stated.
 */
@Controller('medication-requests')
@RequiresModule(TenantModule.WARDS)
export class MedicationRequestsController {
  constructor(private readonly requests: WardRequestsService) {}

  @Get()
  @Roles(UserRole.DOCTOR)
  @AuditAction('MEDICATION_REQUEST_QUEUE_VIEW')
  queue(@Query('status') status?: string) {
    const chosen = queueStatus(
      ['waiting', 'prescribed', 'declined', 'all'] as const,
      status,
      'waiting',
    );
    return this.requests.medicationQueue(chosen);
  }

  @Post(':id/fulfil')
  @Roles(UserRole.DOCTOR)
  @AuditAction('MEDICATION_REQUEST_FULFIL')
  fulfil(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FulfilMedicationRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requests.fulfilMedicationRequest(id, dto, user);
  }

  @Post(':id/decline')
  @Roles(UserRole.DOCTOR)
  @AuditAction('MEDICATION_REQUEST_DECLINE')
  decline(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeclineRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requests.declineMedicationRequest(id, dto.reason, user);
  }
}

/**
 * Raising either kind, and reading back what happened to it.
 *
 * The ward reads its own requests as well as raising them: a request whose
 * answer is invisible from the bed it was raised at is one the nurse has to
 * chase by phone, which is what the queue was supposed to replace. DOCTOR can
 * read too — a ward round asks what has been asked for.
 */
@Controller('admissions/:admissionId')
@RequiresModule(TenantModule.WARDS)
export class WardRequestsController {
  constructor(private readonly requests: WardRequestsService) {}

  @Post('supply-requests')
  @Roles(UserRole.NURSE)
  @AuditAction('SUPPLY_REQUEST_CREATE')
  createSupply(
    @Param('admissionId', ParseIntPipe) admissionId: number,
    @Body() dto: CreateSupplyRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requests.createSupplyRequest(admissionId, dto, user);
  }

  @Get('supply-requests')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('SUPPLY_REQUEST_LIST')
  listSupply(@Param('admissionId', ParseIntPipe) admissionId: number) {
    return this.requests.supplyRequestsFor(admissionId);
  }

  @Post('medication-requests')
  @Roles(UserRole.NURSE)
  @AuditAction('MEDICATION_REQUEST_CREATE')
  createMedication(
    @Param('admissionId', ParseIntPipe) admissionId: number,
    @Body() dto: CreateMedicationRequestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.requests.createMedicationRequest(admissionId, dto, user);
  }

  @Get('medication-requests')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('MEDICATION_REQUEST_LIST')
  listMedication(@Param('admissionId', ParseIntPipe) admissionId: number) {
    return this.requests.medicationRequestsFor(admissionId);
  }
}
