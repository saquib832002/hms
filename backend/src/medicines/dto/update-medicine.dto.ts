import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { DrugClass } from '@prisma/client';

export class UpdateMedicineDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(60) form?: string;
  @IsOptional() @IsString() @MaxLength(60) strength?: string;
  @IsOptional() @IsEnum(DrugClass) drugClass?: DrugClass;
  @IsOptional() @IsBoolean() isControlled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) reorderLevel?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;

  /**
   * What one unit sells for, as a string with up to four decimal places.
   *
   * A string, like every other amount that crosses the wire: a float has
   * already lost precision by the time validation sees it. `null` means "nobody
   * has priced this" and is different from `"0"`, which means the hospital
   * gives it away — see `Medicine.sellingPrice` in the schema for why the two
   * must not collapse into one value.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(/^\d+(\.\d{1,4})?$/, {
    message: 'sellingPrice must be a number with up to 4 decimal places, or null',
  })
  sellingPrice?: string | null;

  /**
   * Which tax rate this medicine carries. Null means the hospital's default.
   *
   * Null is NOT "untaxed" — a catalogue nobody has been through must not
   * silently become zero-rated the day tax is switched on. Point it at a 0%
   * rate to make it genuinely untaxed.
   */
  @IsOptional() @IsInt() taxRateId?: number | null;

}
