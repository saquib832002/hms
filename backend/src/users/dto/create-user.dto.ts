import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
  @IsEmail() @MaxLength(255) email: string;
  @IsString() @MinLength(2) @MaxLength(200) fullName: string;
  @IsEnum(UserRole) role: UserRole;

  /**
   * Only for DOCTOR. A doctor needs a profile before they can hold a clinic —
   * appointments and prescriptions are keyed on `Doctor.id`, not `User.id`.
   */
  @IsOptional() @IsString() @MaxLength(120) specialization?: string;
  @IsOptional() departmentId?: number;
  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string;
}
