import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Matches, IsOptional } from 'class-validator';
import { UserRole } from '@prisma/client';
import { MedicationsService } from './medications.service';
import { ScheduleDosesDto } from './dto/schedule-doses.dto';
import { RecordDoseDto } from './dto/record-dose.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class RoundQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

@Controller('medications')
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
}
