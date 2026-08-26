import { IsDateString, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Deliberately not `PartialType(CreateAppointmentDto)` — `patientId` must not
 * be editable. Repointing an existing appointment at a different patient
 * would silently move any record written against it too.
 */
export class UpdateAppointmentDto {
  @IsOptional()
  @IsInt()
  doctorId?: number;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
