import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBooleanString, IsEnum, IsInt, IsOptional } from 'class-validator';
import { InvoiceStatus, UserRole, TenantModule } from '@prisma/client';
import { BillingService } from './billing.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';
import { RefundDto } from './dto/refund.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class InvoiceQueryDto {
  @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @IsOptional() @Type(() => Number) @IsInt() patientId?: number;
  @IsOptional() @IsBooleanString() overdueOnly?: string;
}

/**
 * Billing.
 *
 * BILLING_STAFF and ADMIN only. No clinical role is here — a doctor has no
 * business voiding an invoice, and billing has no business anywhere near a
 * diagnosis. This is the cleanest role boundary in the system in both
 * directions.
 */
@Controller('billing')
@Roles(UserRole.BILLING_STAFF, UserRole.ADMIN)
@RequiresModule(TenantModule.BILLING)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('invoices')
  @AuditAction('INVOICE_LIST')
  findAll(@Query() query: InvoiceQueryDto, @CurrentUser() user: AuthUser) {
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
  @AuditAction('INVOICE_VIEW')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.billing.findOne(id, user.role);
  }

  @Post('invoices')
  @AuditAction('INVOICE_CREATE')
  create(@Body() dto: CreateInvoiceDto) {
    return this.billing.createInvoice(dto);
  }

  @Patch('invoices/:id/void')
  @AuditAction('INVOICE_VOID')
  voidInvoice(@Param('id', ParseIntPipe) id: number, @Body() dto: VoidInvoiceDto) {
    return this.billing.voidInvoice(id, dto);
  }

  @Post('invoices/:id/payments')
  @AuditAction('PAYMENT_RECORD')
  recordPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.billing.recordPayment(id, dto, user);
  }

  /**
   * Give money back.
   *
   * Its own audit action rather than a variant of PAYMENT_RECORD: money leaving
   * the clinic is the direction somebody will eventually be asked to account
   * for, and "who issued refunds, and why" must be answerable without unpicking
   * a generic payment action.
   */
  @Post('invoices/:id/refunds')
  @AuditAction('REFUND_ISSUE')
  refund(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RefundDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.billing.refund(id, dto, user);
  }

  @Get('payments')
  @AuditAction('PAYMENT_LIST')
  payments() {
    return this.billing.payments();
  }

  @Get('aging')
  @AuditAction('AGING_REPORT')
  aging() {
    return this.billing.aging();
  }
}
