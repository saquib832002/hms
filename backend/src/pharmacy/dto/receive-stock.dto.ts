import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsString, Matches, MaxLength, Min } from 'class-validator';

export class ReceiveStockDto {
  @IsInt() medicineId: number;

  @IsString()
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9._/-]+$/, { message: 'batchNumber must be alphanumeric' })
  batchNumber: string;

  @IsDateString() expiresAt: string;

  @Type(() => Number) @IsInt() @Min(1) quantity: number;
}
