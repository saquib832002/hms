import { Module } from '@nestjs/common';
import { TaxRatesController } from './tax-rates.controller';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { TaxContextService } from './tax-context.service';

// TaxContextService is exported for the same reason, and a sharper one: the
// pharmacy and the lab must charge tax identically, and two copies of those
// rules would not throw — they would quietly disagree on two kinds of invoice.
//
// BillingService is exported so the appointments controller can raise an
// invoice at checkout. The *route* stays off BillingController on purpose —
// access-matrix asserts every billing route is billing-and-admin only, and
// reception raising a consultation charge must not weaken that.
@Module({
  controllers: [BillingController, TaxRatesController],
  providers: [BillingService, TaxContextService],
  exports: [BillingService, TaxContextService],
})
export class BillingModule {}
