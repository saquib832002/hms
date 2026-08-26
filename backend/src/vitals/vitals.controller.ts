import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { UserRole } from '@prisma/client';
import { VitalsService } from './vitals.service';
import { CreateVitalDto } from './dto/create-vital.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class VitalsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

@Controller('vitals')
export class VitalsController {
  constructor(private readonly vitals: VitalsService) {}

  /**
   * Nurses record observations; doctors may too. Nobody else — an observation
   * is a clinical act, and an unattributable one is worse than none.
   */
  @Post()
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('VITALS_RECORD')
  create(@Body() dto: CreateVitalDto, @CurrentUser() user: AuthUser) {
    return this.vitals.create(dto, user);
  }
}

@Controller('patients/:patientId/vitals')
export class PatientVitalsController {
  constructor(private readonly vitals: VitalsService) {}

  @Get()
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('VITALS_VIEW')
  findForPatient(
    @Param('patientId', ParseIntPipe) patientId: number,
    @Query() query: VitalsQueryDto,
  ) {
    return this.vitals.findForPatient(patientId, query.limit ?? 50);
  }
}
