import { Module } from '@nestjs/common';
import { PharmacyController } from './pharmacy.controller';
import { PharmacyTillController } from './pharmacy-till.controller';
import { PharmacyPartnersController } from './partners.controller';
import { PharmacyService } from './pharmacy.service';
import { BillingModule } from '../billing/billing.module';

/**
 * `BillingModule` is imported for its service, not its controller.
 *
 * The pharmacy's till reuses the payment and refund arithmetic — see
 * `pharmacy-till.controller.ts` for why it does not simply reuse the billing
 * *routes*. Importing the module does not expose `/billing` to anybody new;
 * `@Roles` on that controller is unchanged and `access-matrix.spec.ts` still
 * asserts it is exactly [ADMIN, BILLING_STAFF].
 */
@Module({
  imports: [BillingModule],
  controllers: [PharmacyController, PharmacyTillController, PharmacyPartnersController],
  providers: [PharmacyService],
})
export class PharmacyModule {}
