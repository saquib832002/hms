import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { DoctorsService } from './doctors.service';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';

class UpdateDoctorDto {
  @IsOptional() @IsString() @MaxLength(200) fullName?: string;
  @IsOptional() @IsString() @MaxLength(120) specialization?: string;
  @IsOptional() @IsInt() departmentId?: number | null;
  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
}

const ALL_STAFF = [
  UserRole.ADMIN,
  UserRole.RECEPTIONIST,
  UserRole.DOCTOR,
  UserRole.NURSE,
  UserRole.PHARMACIST,
  UserRole.BILLING_STAFF,
] as const;

@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  // The doctor directory is not PHI — every role may read it.
  @Get()
  @Roles(...ALL_STAFF)
  findAll() {
    return this.doctors.findAll();
  }

  @Get(':id')
  @Roles(...ALL_STAFF)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.doctors.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('DOCTOR_PROFILE_UPDATE')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateDoctorDto) {
    return this.doctors.updateProfile(id, dto);
  }

  @Get(':id/availability')
  @Roles(UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.DOCTOR)
  availability(@Param('id', ParseIntPipe) id: number, @Query('date') date?: string) {
    return this.doctors.availability(id, date);
  }
}
