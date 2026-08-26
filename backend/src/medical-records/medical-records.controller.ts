import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MedicalRecordsService } from './medical-records.service';
import { CreateMedicalRecordDto } from './dto/create-medical-record.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

@Controller('patients/:patientId/records')
export class MedicalRecordsController {
  constructor(private readonly records: MedicalRecordsService) {}

  @Get()
  @Roles(UserRole.DOCTOR, UserRole.NURSE)
  @AuditAction('RECORD_LIST')
  findForPatient(
    @Param('patientId', ParseIntPipe) patientId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.records.findForPatient(patientId, user);
  }

  @Post()
  @Roles(UserRole.DOCTOR)
  @AuditAction('RECORD_CREATE')
  create(
    @Param('patientId', ParseIntPipe) patientId: number,
    @Body() dto: CreateMedicalRecordDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.records.create(patientId, dto, user);
  }

  // No PATCH and no DELETE.
  //
  // A clinical note is a contemporaneous account of what a clinician observed.
  // Editing it after the fact destroys that. Real systems handle corrections
  // with an addendum — a new record that references the original — which is a
  // deliberate feature rather than an UPDATE.
}
