import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class InvoiceItemDto {
  /**
   * Free text typed by billing — a service or tariff description.
   *
   * Deliberately NOT copied from clinical data. "Amoxicillin 500mg × 21" would
   * hand billing a medication history, which is exactly what the role-shaped
   * patient response exists to prevent.
   */
  @IsString() @MinLength(2) @MaxLength(200) description: string;

  /**
   * Currency as a string. A JSON number has already been through float
   * representation by the time it reaches here, and `0.1 + 0.2` is not `0.3`.
   */
  @IsString()
  @Matches(/^\d{1,8}(\.\d{1,2})?$/, {
    message: 'amount must be a positive value with at most 2 decimal places, sent as a string',
  })
  amount: string;
}

export class CreateInvoiceDto {
  @IsInt() patientId: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items: InvoiceItemDto[];

  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
