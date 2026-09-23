import { Module } from '@nestjs/common';
import { EscalationsController, ObservationsController } from './observations.controller';
import { ObservationsService } from './observations.service';

@Module({
  controllers: [ObservationsController, EscalationsController],
  providers: [ObservationsService],
})
export class ObservationsModule {}
