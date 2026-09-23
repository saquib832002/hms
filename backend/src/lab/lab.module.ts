import { Module } from '@nestjs/common';
import {
  LabOrdersController,
  LabPartnersController,
  LabTestsController,
  LabWorklistController,
} from './lab.controller';
import { LabTillController } from './lab-till.controller';
import { LabAttachmentsController } from './lab-attachments.controller';
import { PatientLabOrdersController } from './patient-lab-orders.controller';
import { LabService } from './lab.service';
import { LabReferralService } from './lab-referral.service';
import { LabAttachmentsService } from './lab-attachments.service';
import { BillingModule } from '../billing/billing.module';

/**
 * `BillingModule` is imported for its services, not its controller.
 *
 * `BillingService` for the till, and `TaxContextService` so the lab and the
 * pharmacy resolve a hospital's tax rates identically — two copies of those
 * rules would not throw, they would quietly disagree on two kinds of invoice
 * and be found when somebody reconciled a return.
 *
 * Importing the module exposes `/billing` to nobody new: `@Roles` on that
 * controller is unchanged and `access-matrix.spec.ts` still asserts it is
 * exactly [ADMIN, BILLING_STAFF].
 */
@Module({
  imports: [BillingModule],
  controllers: [
    LabTestsController,
    LabOrdersController,
    LabWorklistController,
    LabAttachmentsController,
    LabTillController,
    LabPartnersController,
    PatientLabOrdersController,
  ],
  providers: [LabService, LabReferralService, LabAttachmentsService],
  exports: [LabService],
})
export class LabModule {}
