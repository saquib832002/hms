import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBooleanString, IsEnum, IsInt, IsOptional } from 'class-validator';
import { InvoiceStatus, UserRole } from '@prisma/client';
import { BillingService } from './billing.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';
import { Roles } from '../common/decorators/roles.decorator';
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
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('invoices')
  @AuditAction('INVOICE_LIST')
  findAll(@Query() query: InvoiceQueryDto) {
    return this.billing.findAll({
      status: query.status,
      patientId: query.patientId,
      overdueOnly: query.overdueOnly === 'true',
    });
  }

  @Get('invoices/:id')
  @AuditAction('INVOICE_VIEW')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.billing.findOne(id);
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
