import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Matches, IsOptional } from 'class-validator';
import { UserRole, TenantModule } from '@prisma/client';
import { MedicationsService } from './medications.service';
import { ScheduleDosesDto } from './dto/schedule-doses.dto';
import { RecordDoseDto } from './dto/record-dose.dto';
import { ManualScheduleDto, OneOffDoseDto } from './dto/manual-schedule.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class RoundQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

@Controller('medications')
@RequiresModule(TenantModule.WARDS)
export class MedicationsController {
  constructor(private readonly medications: MedicationsService) {}

  /** The ward's medication round, grouped overdue / due now / upcoming. */
  @Get('round/:wardId')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('MEDICATION_ROUND_VIEW')
  round(@Param('wardId', ParseIntPipe) wardId: number, @Query() query: RoundQueryDto) {
    return this.medications.round(wardId, query.date);
  }

  /**
   * Recording an administration is a nurse's act. A doctor prescribes; the
   * nurse gives it and signs for it, and conflating the two loses who was
   * actually at the bedside.
   */
  @Patch('doses/:id')
  @Roles(UserRole.NURSE)
  @AuditAction('MEDICATION_ADMINISTER')
  record(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordDoseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.medications.record(id, dto, user);
  }
}

@Controller('admissions/:admissionId/medication-schedule')
@RequiresModule(TenantModule.WARDS)
export class MedicationScheduleController {
  constructor(private readonly medications: MedicationsService) {}

  @Post()
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('MEDICATION_SCHEDULE_CREATE')
  schedule(
    @Param('admissionId', ParseIntPipe) admissionId: number,
    @Body() dto: ScheduleDosesDto,
  ) {
    return this.medications.schedule(admissionId, dto);
  }

  /**
   * Times a nurse set by hand, for a frequency the parser refused to guess at.
   *
   * The automatic scheduler has always returned those items as `unscheduled`
   * with a reason, and the reason said *"set the dose times manually"* — with
   * nothing anywhere in either client able to do it. This is that missing half.
   */
  @Post('manual')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('MEDICATION_SCHEDULE_MANUAL')
  manual(
    @Param('admissionId', ParseIntPipe) admissionId: number,
    @Body() dto: ManualScheduleDto,
  ) {
    return this.medications.scheduleManually(admissionId, dto);
  }
}

/**
 * The drug chart for one stay, and the two things a recurring schedule cannot
 * express.
 *
 * NURSE and DOCTOR, never ADMIN. This names the patient, what they are on and
 * what they have had, which is clinical by any reading — the same line the
 * ward board draws.
 */
@Controller('admissions/:admissionId')
@RequiresModule(TenantModule.WARDS)
export class MedicationChartController {
  constructor(private readonly medications: MedicationsService) {}

  @Get('chart')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('MEDICATION_CHART_VIEW')
  chart(@Param('admissionId', ParseIntPipe) admissionId: number) {
    return this.medications.chart(admissionId);
  }

  /**
   * One dose: a STAT decided on a ward round, or an as-needed dose being
   * signed for.
   *
   * NURSE only, like `record()` and for the same reason — a doctor prescribes,
   * a nurse gives it and signs. Adding a dose to the chart and signing for it
   * are the same action for PRN, so this endpoint carries the stricter of the
   * two roles.
   */
  @Post('doses')
  @Roles(UserRole.NURSE)
  @AuditAction('MEDICATION_DOSE_ADD')
  addDose(
    @Param('admissionId', ParseIntPipe) admissionId: number,
    @Body() dto: OneOffDoseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.medications.addOneOffDose(admissionId, dto, user);
  }
}
