import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { UserRole, TenantModule } from '@prisma/client';
import { AppointmentsService } from './appointments.service';
import { BillingService } from '../billing/billing.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { QueryAppointmentsDto } from './dto/query-appointments.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

@Controller('appointments')
@RequiresModule(TenantModule.CLINIC)
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly billing: BillingService,
  ) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.DOCTOR, UserRole.NURSE)
  @AuditAction('APPOINTMENT_LIST')
  findAll(@Query() query: QueryAppointmentsDto, @CurrentUser() user: AuthUser) {
    return this.appointments.findAll(query, user);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.DOCTOR, UserRole.NURSE)
  @AuditAction('APPOINTMENT_VIEW')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.appointments.findOne(id, user);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  @AuditAction('APPOINTMENT_CREATE')
  create(@Body() dto: CreateAppointmentDto) {
    return this.appointments.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  @AuditAction('APPOINTMENT_UPDATE')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAppointmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.appointments.update(id, dto, user);
  }

  /**
   * Reception and doctors both hit this route, but the status machine decides
   * which transitions each may actually perform — reception checks patients
   * in, doctors declare consultations complete.
   */
  @Patch(':id/status')
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.DOCTOR)
  @AuditAction('APPOINTMENT_STATUS_CHANGE')
  changeStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.appointments.changeStatus(id, dto.status, user);
  }

  /**
   * Raise the invoice for this consultation. Reception's checkout action.
   *
   * WHY IT IS HERE AND NOT ON BillingController
   * -------------------------------------------
   * `access-matrix.spec.ts` asserts every billing route is exactly
   * [ADMIN, BILLING_STAFF] and calls that "the cleanest role boundary in the
   * system". Adding reception there to make one screen convenient would trade a
   * real guarantee for a route location, and the test would have been right to
   * fail.
   *
   * Checkout is an *appointment* action anyway: it is the last step of the
   * visit, taken by the person the patient is standing in front of. Reception
   * can raise the charge and read back the amount to the patient; whether they
   * may then *collect* it is a separate question answered by whether that
   * clinic also gives them BILLING_STAFF.
   */
  @Post(':id/invoice')
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  @AuditAction('APPOINTMENT_INVOICE_RAISED')
  raiseInvoice(@Param('id', ParseIntPipe) id: number) {
    return this.billing.invoiceForAppointment(id);
  }
}
