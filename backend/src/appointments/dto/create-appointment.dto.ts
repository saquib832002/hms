import { IsDateString, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAppointmentDto {
  @IsInt()
  patientId: number;

  @IsInt()
  doctorId: number;

  @IsDateString()
  scheduledAt: string;

  /**
   * The booking reason typed by reception — NOT a diagnosis. Reception may
   * write this; it is what the patient said on the phone.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
