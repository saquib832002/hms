import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ObservationFrequency, UserRole, TenantModule } from '@prisma/client';
import { ObservationsService } from './observations.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class SetOrderDto {
  @IsEnum(ObservationFrequency) frequency: ObservationFrequency;

  /** Why it changed. Optional for a doctor's plan, worth reading at handover. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class RaiseEscalationDto {
  /**
   * Who was told. Free text — the on-call registrar covering a ward at 3am
   * usually has no account here, and demanding a user id would mean the
   * commonest real escalation could not be recorded at all.
   */
  @IsString() @MinLength(2) @MaxLength(120) escalatedTo: string;

  /** What was wrong. Required: without it the row says somebody made a call. */
  @IsString() @MinLength(5) @MaxLength(1000) concern: string;

  /** The observation set that prompted it, when there was one. */
  @IsOptional() @IsInt() vitalId?: number;
}

class RespondDto {
  @IsString() @MinLength(2) @MaxLength(1000) response: string;
}

/**
 * Observation orders and escalations for one admission.
 *
 * NURSE and DOCTOR. Admin is excluded from all of it — these name a patient and
 * carry a written clinical concern about their condition, which is the same
 * line that keeps admin off the ward board and the drug chart.
 */
@Controller('admissions/:admissionId/observations')
@RequiresModule(TenantModule.WARDS)
export class ObservationsController {
  constructor(private readonly observations: ObservationsService) {}

  /** Order, when the next set is due, and the escalation trail. */
  @Get()
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('OBSERVATION_SUMMARY_VIEW')
  summary(@Param('admissionId', ParseIntPipe) admissionId: number) {
    return this.observations.summary(admissionId);
  }

  /*
   * There is no `GET .../orders` history route.
   *
   * `orderHistory` exists on the service and is deliberately not exposed: no
   * screen shows the full sequence of frequency changes yet, and an endpoint
   * with no caller is an unfinished feature rather than a spare part.
   * `summary` carries the order in force with who set it and when, which is
   * what a ward round actually reads. Expose it when a screen wants it.
   */

  /**
   * Set how often observations are due.
   *
   * Both roles may call it and they are not equal: the service lets a nurse
   * only *tighten* the interval. Watching a patient more closely because they
   * look unwell must not wait for a doctor to be found; deciding somebody needs
   * less watching is a clinical judgement about their condition.
   *
   * Enforced in the service rather than by splitting the route, because the
   * rule is about the value being set and a guard cannot see it.
   */
  @Post('order')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('OBSERVATION_ORDER_SET')
  setOrder(
    @Param('admissionId', ParseIntPipe) admissionId: number,
    @Body() dto: SetOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.observations.setOrder(admissionId, dto.frequency, dto.reason, user);
  }

  @Post('escalations')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('OBSERVATION_ESCALATION_RAISE')
  escalate(
    @Param('admissionId', ParseIntPipe) admissionId: number,
    @Body() dto: RaiseEscalationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.observations.raiseEscalation(admissionId, dto, user);
  }
}

/**
 * Recording what came back, on its own controller because it acts on the
 * escalation rather than on an admission.
 */
@Controller('escalations')
@RequiresModule(TenantModule.WARDS)
export class EscalationsController {
  constructor(private readonly observations: ObservationsService) {}

  @Patch(':id/response')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('OBSERVATION_ESCALATION_RESPOND')
  respond(@Param('id', ParseIntPipe) id: number, @Body() dto: RespondDto) {
    return this.observations.recordResponse(id, dto.response);
  }
}
