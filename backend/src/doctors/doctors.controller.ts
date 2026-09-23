import { Body, Controller, Get, Param, ParseIntPipe, Patch, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { UserRole, TenantModule } from '@prisma/client';
import { DoctorsService } from './doctors.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';

class UpdateDoctorDto {
  @IsOptional() @IsString() @MaxLength(200) fullName?: string;
  @IsOptional() @IsString() @MaxLength(120) specialization?: string;
  @IsOptional() @IsInt() departmentId?: number | null;
  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string | null;

  /**
   * "MBBS, MD (Medicine)" — printed under the name on a prescription.
   *
   * Editable here rather than only at account creation, because a doctor
   * finishing a qualification is ordinary and re-creating their account to
   * record it is not.
   */
  @IsOptional() @IsString() @MaxLength(120) qualifications?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;

  /**
   * Consultation fee, as a string. Never a JSON number.
   *
   * The same rule as every other amount in this system: a JSON number has been
   * through float representation by the time it arrives, and `parseFloat` on
   * the way in is how pennies go missing. Empty string clears the fee, which is
   * distinct from zero — no fee means "cannot be billed at checkout", zero
   * would mean "this consultation is free".
   */
  @IsOptional()
  @IsString()
  @Matches(/^$|^\d{1,8}(\.\d{1,2})?$/, {
    message: 'consultationFee must be a positive amount with at most 2 decimal places, as a string',
  })
  consultationFee?: string;
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
@RequiresModule(TenantModule.CLINIC)
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
