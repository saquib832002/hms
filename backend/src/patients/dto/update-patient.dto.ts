import { IsDateString, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Gender } from '@prisma/client';

/**
 * Deliberately NOT `PartialType(CreatePatientDto)`.
 *
 * PartialType makes every field `string | undefined`, which cannot express
 * "clear this field". Reception needs to be able to remove a phone number
 * that was typed wrong — and with the inherited type, sending `null` either
 * fails validation or gets silently dropped by the service's
 * `dto.email?.toLowerCase()` and leaves the old value in place. A save that
 * reports success and changes nothing is worse than one that errors.
 *
 * So optional fields are explicitly nullable here:
 *   undefined → leave untouched
 *   null      → clear it
 *
 * Identity fields (name, DOB, gender) are optional but never nullable. A
 * patient without a name is not a correction, it is a broken record.
 */
export class UpdatePatientDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @IsIn(['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'])
  bloodGroup?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  emergencyContactName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  emergencyContactPhone?: string | null;
}
