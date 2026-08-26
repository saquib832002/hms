import { Module } from '@nestjs/common';
import { AdmissionsController } from './admissions.controller';
import { PatientAdmissionsController } from './patient-admissions.controller';
import { AdmissionsService } from './admissions.service';

@Module({
  controllers: [AdmissionsController, PatientAdmissionsController],
  providers: [AdmissionsService],
})
export class AdmissionsModule {}
