import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class CreateVitalDto {
  @IsInt() patientId: number;

  /**
   * Idempotency key generated on the device before the write is attempted.
   * A UUID rather than free text so a client cannot collide with another
   * device's key by accident.
   */
  @IsOptional() @IsUUID() clientRef?: string;

  /**
   * When the observation was actually taken, which is not when it reached the
   * server. An offline entry replayed an hour later must sit at the right
   * point on the chart.
   */
  @IsOptional() @IsDateString() recordedAt?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(40) @Max(300) systolic?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(20) @Max(200) diastolic?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(20) @Max(250) pulse?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 1 }) @Min(25) @Max(45) temperatureC?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(4) @Max(60) respiratoryRate?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(50) @Max(100) spo2?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) painScore?: number;

  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
