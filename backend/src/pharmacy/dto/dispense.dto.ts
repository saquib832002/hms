import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class DispenseLineDto {
  @IsInt() prescriptionItemId: number;

  /**
   * Units handed over. The pharmacist enters this — the server suggests a
   * figure when frequency and duration are both unambiguous, and says nothing
   * when they are not.
   */
  @IsInt() @Min(1) quantity: number;
}

export class DispenseDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DispenseLineDto)
  lines: DispenseLineDto[];

  /**
   * Required when a blocking allergy conflict is present. Free text on
   * purpose: the reason is for a human reviewing the dispense later, and a
   * dropdown of canned reasons would be picked past without thought.
   */
  @IsOptional() @IsString() @MaxLength(1000) overrideReason?: string;

  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
