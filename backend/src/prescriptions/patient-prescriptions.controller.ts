import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrescriptionsService } from './prescriptions.service';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';

@Controller('patients/:patientId/prescriptions')
export class PatientPrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @Get()
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST)
  @AuditAction('PRESCRIPTION_LIST')
  findForPatient(@Param('patientId', ParseIntPipe) patientId: number) {
    return this.prescriptions.findForPatient(patientId);
  }
}
