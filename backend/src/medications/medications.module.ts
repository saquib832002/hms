import { Module } from '@nestjs/common';
import {
  MedicationChartController,
  MedicationScheduleController,
  MedicationsController,
} from './medications.controller';
import { MedicationsService } from './medications.service';

@Module({
  controllers: [MedicationsController, MedicationScheduleController, MedicationChartController],
  providers: [MedicationsService],
})
export class MedicationsModule {}
