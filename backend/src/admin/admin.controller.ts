import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { UserRole } from '@prisma/client';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { UpdateClinicSettingsDto } from './dto/clinic-settings.dto';

class WindowDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
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
}
