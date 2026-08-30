import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

// BillingService is exported so the appointments controller can raise an
// invoice at checkout. The *route* stays off BillingController on purpose —
// access-matrix asserts every billing route is billing-and-admin only, and
// reception raising a consultation charge must not weaken that.
@Module({
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
