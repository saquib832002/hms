import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBooleanString, IsEnum, IsIn, IsInt, IsOptional } from 'class-validator';
import { InvoiceStatus, UserRole, TenantModule } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { LabService } from './lab.service';
import { RecordPaymentDto } from '../billing/dto/record-payment.dto';
import { RefundDto } from '../billing/dto/refund.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class LabInvoiceQueryDto {
  @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @IsOptional() @Type(() => Number) @IsInt() patientId?: number;
  @IsOptional() @IsBooleanString() overdueOnly?: string;
  /**
   * Who owes it: a patient at the counter, or a hospital that referred work.
   *
   * A laboratory doing send-out work keeps two ledgers with different shapes —
   * patients paying today, institutions invoiced monthly. Mixed into one list
   * the second is a handful of "no patient" rows scattered through the first,
   * and "what do referring hospitals owe us" cannot be answered.
   */
  @IsOptional() @IsIn(['patient', 'institution']) payer?: 'patient' | 'institution';
}

/**
 * The lab's own till.
 *
 * WHY THESE ROUTES AND NOT A WIDER `BillingController`
 * ---------------------------------------------------
 * The same argument that gave the pharmacy its own till, and it has now been
 * made twice, which is the point at which it is worth stating as a rule:
 * `access-matrix.spec.ts` asserts every `/billing` route is exactly
 * `[ADMIN, BILLING_STAFF]`, and that is the cleanest role boundary in the
 * system. Adding LAB_TECHNICIAN there would be three characters and would cost
 * it. In SEPARATE mode the lab is a different business taking money at a
 * different counter.
 *
 * `BillingService` underneath is shared, deliberately. The payment arithmetic,
 * the refund-versus-credit distinction and the overpayment refusal were hard to
 * get right once; `visibleInvoiceKinds` keeps the three sets of books apart at
 * the resource layer, where a guard structurally cannot reach.
 *
 * WHAT IS ABSENT
 * --------------
 * No ad-hoc invoice creation. A lab invoice is raised by an order — it is a
 * charge for work somebody requested, and one typed by hand would be a charge
 * with no requisition behind it.
 *
 * No void. Voiding a lab invoice belongs with cancelling the order, because
 * that is where the question "was any of this actually done" is answerable —
 * `LabService.cancelOrder` voids the charge only while nothing has been
 * collected, and refuses once a payment has been taken.
 */
@Controller('lab')
@Roles(UserRole.LAB_TECHNICIAN, UserRole.ADMIN)
@RequiresModule(TenantModule.LABORATORY)
export class LabTillController {
  constructor(
    private readonly billing: BillingService,
    private readonly lab: LabService,
  ) {}

  /**
   * What we are billing each referring hospital this month.
   *
   * Declared before `invoices/:id` and before any other `:param` route on this
   * controller — Nest matches in declaration order, and `statements` arriving at
   * a `ParseIntPipe` produces a 400 that reads as the feature being broken. The
   * same ordering trap `/lab-partners/charges` had to be moved for.
   *
   * A statement is derived from the invoices, never stored. See
   * `lab-statement.ts` for why, and for why it deliberately carries no
   * statement number.
   */
  @Get('statements')
  @AuditAction('LAB_STATEMENT_LIST')
  statements(
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.lab.statements({ month, from, to });
  }

  /**
   * One hospital's statement, itemised.
   *
   * `:sourceTenantId` is the referring hospital's tenant id, which this
   * laboratory already holds on every referral they sent — so this enumerates
   * nothing: the query is scoped to our own referrals, and an id we have never
   * had work from produces "nothing was billed" rather than a hospital's name.
   */
  @Get('statements/:sourceTenantId')
  @AuditAction('LAB_STATEMENT_VIEW')
  statement(
    @Param('sourceTenantId', ParseIntPipe) sourceTenantId: number,
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.lab.statement(sourceTenantId, { month, from, to });
  }

  /** Lab invoices only — `visibleInvoiceKinds` scopes the query by role. */
  @Get('invoices')
  @AuditAction('LAB_INVOICE_LIST')
  invoices(@Query() query: LabInvoiceQueryDto, @CurrentUser() user: AuthUser) {
    return this.billing.findAll(
      {
        status: query.status,
        patientId: query.patientId,
        overdueOnly: query.overdueOnly === 'true',
        payer: query.payer,
      },
      user.role,
    );
  }

  @Get('invoices/:id')
  @AuditAction('LAB_INVOICE_VIEW')
  invoice(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.billing.findOne(id, user.role);
  }

  @Post('invoices/:id/payments')
  @AuditAction('LAB_PAYMENT_RECORD')
  pay(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.billing.recordPayment(id, dto, user);
  }

  /**
   * Its own audit action, for the same reason `PHARMACY_REFUND_ISSUE` is
   * separate: money leaving a till is the direction somebody is eventually
   * asked to account for, and "who refunded, from which till" should not need
   * unpicking from a generic action.
   */
  @Post('invoices/:id/refunds')
  @AuditAction('LAB_REFUND_ISSUE')
  refund(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RefundDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.billing.refund(id, dto, user);
  }
}
