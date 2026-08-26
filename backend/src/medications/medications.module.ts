import { Module } from '@nestjs/common';
import { MedicationScheduleController, MedicationsController } from './medications.controller';
import { MedicationsService } from './medications.service';

@Module({
  controllers: [MedicationsController, MedicationScheduleController],
  providers: [MedicationsService],
})
export class MedicationsModule {}
