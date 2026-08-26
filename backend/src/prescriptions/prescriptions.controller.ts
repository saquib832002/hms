import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { UserRole } from '@prisma/client';
import { PrescriptionsService } from './prescriptions.service';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

@Controller('prescriptions')
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

  /** Reception may print, but never read the prescription as data. */
  @Get(':id/print')
  @Roles(UserRole.DOCTOR, UserRole.RECEPTIONIST, UserRole.PHARMACIST)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @AuditAction('PRESCRIPTION_PRINT')
  async print(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    res.send(await this.prescriptions.renderPrintable(id));
  }

  @Patch(':id/cancel')
  @Roles(UserRole.DOCTOR)
  @AuditAction('PRESCRIPTION_CANCEL')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.prescriptions.cancel(id, user);
  }
}
