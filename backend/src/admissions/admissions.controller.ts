import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AdmissionsService } from './admissions.service';
import { AdmitDto } from './dto/admit.dto';
import { TransferDto } from './dto/transfer.dto';
import { DischargeDto } from './dto/discharge.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';

/**
 * Admitting, moving and discharging inpatients.
 *
 * Nurses run bed management in practice, so they hold these — a doctor
 * deciding to admit still needs the ward to find a bed. Admin is included for
 * operational correction.
 */
/**
 * ADMIN keeps the *write* operations here and only those.
 *
 * Bed management is how a mis-admission gets corrected, and an administrator
 * locked out of it has no route but a database console. Every one of these is
 * loudly audited. The clinical *reads* — the ward board, observations, the drug
 * chart — are not available to admin; see wards.controller.ts.
 */
@Controller('admissions')
@Roles(UserRole.ADMIN, UserRole.NURSE, UserRole.DOCTOR)
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}

  @Post()
  @AuditAction('PATIENT_ADMIT')
  admit(@Body() dto: AdmitDto) {
    return this.admissions.admit(dto);
  }

  /** Names the patient, so clinical staff only — unlike the writes below. */
  @Get(':id')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('ADMISSION_VIEW')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.admissions.findActive(id);
  }

  @Patch(':id/transfer')
  @AuditAction('PATIENT_TRANSFER')
  transfer(@Param('id', ParseIntPipe) id: number, @Body() dto: TransferDto) {
    return this.admissions.transfer(id, dto);
  }

  @Patch(':id/discharge')
  @AuditAction('PATIENT_DISCHARGE')
  discharge(@Param('id', ParseIntPipe) id: number, @Body() dto: DischargeDto) {
    return this.admissions.discharge(id, dto);
  }
}
