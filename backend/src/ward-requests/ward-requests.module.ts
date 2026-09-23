import { Module } from '@nestjs/common';
import {
  MedicationRequestsController,
  SupplyRequestsController,
  WardRequestsController,
} from './ward-requests.controller';
import { WardRequestsService } from './ward-requests.service';

@Module({
  controllers: [SupplyRequestsController, MedicationRequestsController, WardRequestsController],
  providers: [WardRequestsService],
})
export class WardRequestsModule {}
