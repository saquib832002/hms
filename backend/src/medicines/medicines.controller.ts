import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole, TenantModule } from '@prisma/client';
import { MedicinesService } from './medicines.service';
import { CreateMedicineDto } from './dto/create-medicine.dto';
import { UpdateMedicineDto } from './dto/update-medicine.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';

class MedicineQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

class LinkItemDto {
  @IsOptional() medicineId: number;
}

@Controller('medicines')
@RequiresModule(TenantModule.PHARMACY)
export class MedicinesController {
  constructor(private readonly medicines: MedicinesService) {}

  /**
   * The catalogue is not PHI — doctors need it to prescribe, nurses to check
   * a chart. Writing to it is pharmacy and admin only.
   */
  @Get()
  @Roles(UserRole.PHARMACIST, UserRole.DOCTOR, UserRole.NURSE, UserRole.ADMIN)
  findAll(@Query() query: MedicineQueryDto) {
    return this.medicines.findAll(query.q);
  }

  @Post()
  @Roles(UserRole.PHARMACIST, UserRole.ADMIN)
  @AuditAction('MEDICINE_CREATE')
  create(@Body() dto: CreateMedicineDto) {
    return this.medicines.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.PHARMACIST, UserRole.ADMIN)
  @AuditAction('MEDICINE_UPDATE')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMedicineDto) {
    return this.medicines.update(id, dto);
  }

  /** Prescription items the name backfill could not match. */
  @Get('unmapped')
  @Roles(UserRole.PHARMACIST, UserRole.ADMIN)
  unmapped() {
    return this.medicines.unmappedItems();
  }

  @Patch('items/:itemId/link')
  @Roles(UserRole.PHARMACIST, UserRole.ADMIN)
  @AuditAction('PRESCRIPTION_ITEM_LINK')
  link(@Param('itemId', ParseIntPipe) itemId: number, @Body() dto: LinkItemDto) {
    return this.medicines.linkPrescriptionItem(itemId, dto.medicineId);
  }
}
