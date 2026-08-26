import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateMedicalRecordDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  diagnosis: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @IsOptional()
  @IsDateString()
  visitDate?: string;
}
