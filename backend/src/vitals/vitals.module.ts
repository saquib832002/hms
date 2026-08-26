import { Module } from '@nestjs/common';
import { PatientVitalsController, VitalsController } from './vitals.controller';
import { VitalsService } from './vitals.service';

@Module({
  controllers: [VitalsController, PatientVitalsController],
  providers: [VitalsService],
})
export class VitalsModule {}
