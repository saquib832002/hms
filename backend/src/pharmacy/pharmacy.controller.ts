import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { PharmacyService } from './pharmacy.service';
import { DispenseDto } from './dto/dispense.dto';
import { ReceiveStockDto } from './dto/receive-stock.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class InventoryQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

@Controller('pharmacy')
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

  @Get('history')
  @Roles(UserRole.PHARMACIST)
  @AuditAction('DISPENSE_HISTORY')
  history() {
    return this.pharmacy.history();
  }

  @Get('inventory')
  @Roles(UserRole.PHARMACIST, UserRole.ADMIN)
  inventory(@Query() query: InventoryQueryDto) {
    return this.pharmacy.inventory(query.q);
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
    );
  }
}
