import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { DrugClass } from '@prisma/client';

export class UpdateMedicineDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(60) form?: string;
  @IsOptional() @IsString() @MaxLength(60) strength?: string;
  @IsOptional() @IsEnum(DrugClass) drugClass?: DrugClass;
  @IsOptional() @IsBoolean() isControlled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) reorderLevel?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
