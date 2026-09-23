import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBooleanString, IsEnum, IsInt, IsOptional } from 'class-validator';
import { InvoiceStatus, UserRole, TenantModule } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { RecordPaymentDto } from '../billing/dto/record-payment.dto';
import { RefundDto } from '../billing/dto/refund.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class PharmacyInvoiceQueryDto {
  @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @IsOptional() @Type(() => Number) @IsInt() patientId?: number;
  @IsOptional() @IsBooleanString() overdueOnly?: string;
}

/**
 * The pharmacy's own till.
 *
 * WHY THESE ROUTES EXIST RATHER THAN WIDENING `BillingController`
 * ---------------------------------------------------------------
 * Adding PHARMACIST to `@Roles(BILLING_STAFF, ADMIN)` would have been three
 * characters and would have cost the cleanest role boundary in the system.
 * `access-matrix.spec.ts` asserts that every `/billing` route is exactly
 * `[ADMIN, BILLING_STAFF]` and calls that out by name; the same argument that
 * put `POST /appointments/:id/invoice` on the appointments controller rather
 * than the billing one applies here, and more strongly. A pharmacist taking
 * money for medicine is not "billing staff with extra steps" — in SEPARATE mode
 * they are a different business.
 *
 * The service underneath is shared, deliberately. Payment arithmetic, the
 * refund-versus-credit distinction and the overpayment refusal were hard to get
 * right once and must not be got right twice; `visibleInvoiceKinds` inside
 * `BillingService` is what keeps the two sets of books apart, at the resource
 * layer where a guard structurally cannot reach.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No ad-hoc invoice creation and no void. A pharmacy invoice is raised by a
 * sale — it is a receipt for goods that left a shelf, and one typed by hand
 * would be a charge with no stock movement behind it. Voiding has the same
 * problem in reverse: the medicine has gone, so the correction is a refund and
 * a credit, which is what those routes are for.
 *
 * A REFUND HERE DOES NOT PUT STOCK BACK
 * -------------------------------------
 * Money returns; the medicine does not go back on the shelf. Dispensed medicine
 * has left the pharmacy's control and in most jurisdictions cannot lawfully be
 * resold, so an automatic re-increment would be a regulatory problem wearing
 * the shape of a convenience — and it would silently overstate stock, which is
 * the number the whole dispensing flow trusts. Putting a returned box back into
 * saleable stock is a deliberate act by a pharmacist; it is `POST
 * /pharmacy/stock`, and it leaves its own trail.
 */
@Controller('pharmacy')
@Roles(UserRole.PHARMACIST, UserRole.ADMIN)
@RequiresModule(TenantModule.PHARMACY)
export class PharmacyTillController {
  constructor(private readonly billing: BillingService) {}

  /** Pharmacy invoices only — `visibleInvoiceKinds` scopes the query. */
  @Get('invoices')
  @AuditAction('PHARMACY_INVOICE_LIST')
  invoices(@Query() query: PharmacyInvoiceQueryDto, @CurrentUser() user: AuthUser) {
    return this.billing.findAll(
      {
        status: query.status,
        patientId: query.patientId,
        overdueOnly: query.overdueOnly === 'true',
      },
      user.role,
    );
  }

  @Get('invoices/:id')
  @AuditAction('PHARMACY_INVOICE_VIEW')
  invoice(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.billing.findOne(id, user.role);
  }

  @Post('invoices/:id/payments')
  @AuditAction('PHARMACY_PAYMENT_RECORD')
  pay(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.billing.recordPayment(id, dto, user);
  }

  /**
   * Its own audit action, for the same reason `REFUND_ISSUE` is separate from
   * `PAYMENT_RECORD`: money leaving a till is the direction somebody is
   * eventually asked to account for, and "who refunded, from which till" should
   * not need unpicking from a generic action.
   */
  @Post('invoices/:id/refunds')
  @AuditAction('PHARMACY_REFUND_ISSUE')
  refund(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RefundDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.billing.refund(id, dto, user);
  }
}
