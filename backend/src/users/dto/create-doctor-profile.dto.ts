import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The clinical half of a person who already has a login.
 *
 * WHY THIS IS SEPARATE FROM `CreateUserDto`
 * -----------------------------------------
 * Creating a user and creating a doctor profile were one operation, which
 * quietly meant a `Doctor` row could only ever come into existence attached to
 * a *brand-new account*. For the owner of a small clinic who is also its
 * doctor, that forced a second email address and a second password for the same
 * human — which is exactly the split multi-role exists to prevent, and which
 * breaks the audit trail in the way `UserRoleAssignment` was built to avoid.
 *
 * No email, no password, no role here: those belong to the account, which
 * already exists. This adds only what a clinic needs in order to book someone.
 */
export class CreateDoctorProfileDto {
  /**
   * Required, and the reason the profile cannot be created silently.
   *
   * It appears next to the doctor's name everywhere a patient or a receptionist
   * picks one, and a blank specialisation makes a booking list unreadable.
   */
  @IsString() @MinLength(2) @MaxLength(120) specialization: string;

  @IsOptional() @Type(() => Number) @IsInt() departmentId?: number;

  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string;

  @IsOptional() @IsString() @MaxLength(40) phone?: string;
}
