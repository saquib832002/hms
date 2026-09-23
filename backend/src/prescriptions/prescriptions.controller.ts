import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole, TenantModule } from '@prisma/client';
import { PrescriptionsService } from './prescriptions.service';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

@Controller('prescriptions')
@RequiresModule(TenantModule.CLINIC)
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @Post()
  @Roles(UserRole.DOCTOR)
  @AuditAction('PRESCRIPTION_CREATE')
  create(@Body() dto: CreatePrescriptionDto, @CurrentUser() user: AuthUser) {
    return this.prescriptions.create(dto, user);
  }

  @Get(':id')
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST)
  @AuditAction('PRESCRIPTION_VIEW')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.prescriptions.findOne(id, user);
  }

  /*
   * `GET :id/print` used to live here and returned hand-built HTML with
   * `<h1>Meridian Hospital</h1>` — the demo seed's name — on every tenant's
   * prescriptions. It is replaced by `GET /documents/prescriptions/:id/pdf`,
   * which draws the calling hospital's own letterhead and returns a real PDF.
   *
   * Removed rather than kept alongside: two renderers of the same document
   * drift, and the one that drifts is the one nobody is looking at.
   */

  @Patch(':id/cancel')
  @Roles(UserRole.DOCTOR)
  @AuditAction('PRESCRIPTION_CANCEL')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.prescriptions.cancel(id, user);
  }
}
