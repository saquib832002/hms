import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { PatientsService } from './patients.service';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  /**
   * Every staff role can list patients — but the response body differs per
   * role (see dto/patient-response.ts). Rate-limited harder than other reads:
   * paging through the entire patient list is the classic exfiltration
   * pattern, and it looks exactly like normal use one request at a time.
   */
  @Get()
  @Roles(
    UserRole.ADMIN,
    UserRole.RECEPTIONIST,
    UserRole.DOCTOR,
    UserRole.NURSE,
    UserRole.PHARMACIST,
    UserRole.BILLING_STAFF,
  )
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @AuditAction('PATIENT_SEARCH')
  findAll(@Query() query: PaginationDto, @CurrentUser() user: AuthUser) {
    return this.patients.findAll(query, user);
  }

  @Get('duplicates')
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  @AuditAction('PATIENT_DUPLICATE_CHECK')
  duplicates(@Query('fullName') fullName: string, @Query('phone') phone?: string) {
    return this.patients.findPossibleDuplicates(fullName ?? '', phone);
  }

  @Get(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.RECEPTIONIST,
    UserRole.DOCTOR,
    UserRole.NURSE,
    UserRole.PHARMACIST,
    UserRole.BILLING_STAFF,
  )
  @AuditAction('PATIENT_VIEW')
  findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.patients.findOne(id, user);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  @AuditAction('PATIENT_CREATE')
  create(@Body() dto: CreatePatientDto, @CurrentUser() user: AuthUser) {
    return this.patients.create(dto, user);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST)
  @AuditAction('PATIENT_UPDATE')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePatientDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.patients.update(id, dto, user);
  }

  // DELETE is intentionally absent.
  //
  // Patient records are not deletable in a clinical system — retention is a
  // legal obligation, and a deleted row destroys the audit trail that points
  // at it. Correcting a mistaken registration is a merge, and merges are a
  // deliberate, audited operation rather than a DELETE endpoint.
}
