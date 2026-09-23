import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { UserRole, TenantModule } from '@prisma/client';
import { AdmissionsService } from './admissions.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';

@Controller('patients/:patientId/admissions')
@RequiresModule(TenantModule.WARDS)
export class PatientAdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}

  @Get()
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('ADMISSION_HISTORY')
  findForPatient(@Param('patientId', ParseIntPipe) patientId: number) {
    return this.admissions.findForPatient(patientId);
  }
}
