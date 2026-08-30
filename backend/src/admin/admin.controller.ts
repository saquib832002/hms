import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AppointmentStatus, UserRole } from '@prisma/client';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { UpdateClinicSettingsDto } from './dto/clinic-settings.dto';

class WindowDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}

class MonthsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) months?: number;
}

class LedgerDto {
  @IsOptional() @IsString() date?: string;
  @IsOptional() @Type(() => Number) @IsInt() doctorId?: number;
  @IsOptional() @IsEnum(AppointmentStatus) status?: AppointmentStatus;
}

/**
 * Aggregates only. Nothing here returns a patient row, a diagnosis or a
 * medicine name — see admin.service.ts on why a management dashboard is the
 * obvious back door into clinical data.
 */
@Controller('admin')
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('dashboard')
  @AuditAction('ADMIN_DASHBOARD')
  dashboard() {
    return this.admin.dashboard();
  }

  @Get('reports/activity')
  @AuditAction('ADMIN_ACTIVITY_REPORT')
  activity(@Query() query: WindowDto) {
    return this.admin.activityReport(query.days ?? 7);
  }

  /**
   * The hospital's own clinic day.
   *
   * Readable and writable only for the caller's hospital — the tenant comes
   * from the authenticated user, never from the request, so there is no route
   * here to another hospital's configuration.
   *
   * These are aggregates about the *hospital*, not clinical data, so they sit
   * comfortably inside the "admin is operational, not clinical" rule.
   */
  @Get('clinic-settings')
  @AuditAction('ADMIN_CLINIC_SETTINGS_VIEW')
  clinicSettings() {
    return this.admin.clinicSettings();
  }

  @Patch('clinic-settings')
  @AuditAction('ADMIN_CLINIC_SETTINGS_UPDATE')
  updateClinicSettings(@Body() dto: UpdateClinicSettingsDto) {
    return this.admin.updateClinicSettings(dto);
  }

  @Get('reports/staff')
  @AuditAction('ADMIN_STAFF_REPORT')
  staff() {
    return this.admin.staffReport();
  }

  /**
   * Takings and debts.
   *
   * Audited under its own action rather than folded into ADMIN_DASHBOARD:
   * "who looked at the hospital's revenue, and when" is a question an owner may
   * well want answered, and it is unanswerable once every admin read shares one
   * action name.
   */
  @Get('reports/finance')
  @AuditAction('ADMIN_FINANCE_REPORT')
  finance(@Query() query: MonthsDto) {
    return this.admin.financeReport(query.months ?? 12);
  }

  @Get('reports/doctors')
  @AuditAction('ADMIN_DOCTOR_REPORT')
  doctors() {
    return this.admin.doctorsReport();
  }

  /**
   * One day's work, per member of staff.
   *
   * Counts and money only — never which patients. An admin who needs named
   * patients switches to a clinical role they hold, and the audit log then
   * records that they looked as a doctor rather than as an administrator.
   *
   * Audited under its own action: an owner reviewing their staff's day is a
   * legitimate thing to do and a reasonable thing for staff to be able to see
   * happened.
   */
  @Get('reports/staff-activity')
  @AuditAction('ADMIN_STAFF_ACTIVITY_REPORT')
  staffActivity(@Query('date') date?: string) {
    return this.admin.staffActivityReport(date);
  }

  /**
   * The patients behind a count on the daily activity screen.
   *
   * The one admin endpoint that returns patient identity — names, attendance,
   * and what was charged. No clinical content: not the appointment reason, not
   * what was prescribed. See `admin.service.ts` for where that line sits and
   * why.
   *
   * Its own audit action, deliberately. This is the route by which an
   * administrator reads who attended the clinic, and "who looked up our
   * patient list, and when" must be answerable without unpicking a generic
   * report action.
   */
  @Get('reports/consultations')
  @AuditAction('ADMIN_CONSULTATION_LEDGER')
  consultations(@Query() query: LedgerDto) {
    return this.admin.consultationLedger(query);
  }
}
