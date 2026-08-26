import { Module } from '@nestjs/common';
import { PrescriptionsController } from './prescriptions.controller';
import { PatientPrescriptionsController } from './patient-prescriptions.controller';
import { PrescriptionsService } from './prescriptions.service';

@Module({
  controllers: [PrescriptionsController, PatientPrescriptionsController],
  providers: [PrescriptionsService],
})
export class PrescriptionsModule {}
