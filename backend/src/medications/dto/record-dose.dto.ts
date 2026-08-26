import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { DoseStatus } from '@prisma/client';

export class RecordDoseDto {
  @IsEnum(DoseStatus) status: DoseStatus;

  @IsOptional() @IsUUID() clientRef?: string;

  /** When it was actually given — may be earlier than when this request arrives. */
  @IsOptional() @IsDateString() givenAt?: string;

  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
