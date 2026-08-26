import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PrescriptionItemDto {
  // Free text in Phase 1; becomes a FK to `Medicine` in Phase 4.
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  medicineName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  dosage: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  frequency: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  duration: string;
}

export class CreatePrescriptionDto {
  @IsInt()
  patientId: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemDto)
  items: PrescriptionItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
