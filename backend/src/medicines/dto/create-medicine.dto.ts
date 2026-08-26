import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { DrugClass } from '@prisma/client';

export class CreateMedicineDto {
  @IsString() @MaxLength(200) name: string;
  @IsString() @MaxLength(60) form: string;
  @IsString() @MaxLength(60) strength: string;

  /**
   * The field the whole allergy check rests on. Defaulting to OTHER is safe
   * in the sense that it never produces a false conflict — but it also never
   * produces a true one, so an uncatalogued class shows up on the dispensing
   * screen as "not checked" rather than passing quietly.
   */
  @IsOptional() @IsEnum(DrugClass) drugClass?: DrugClass;

  @IsOptional() @IsBoolean() isControlled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) reorderLevel?: number;
}
