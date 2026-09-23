import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export class ReceiveStockDto {
  @IsInt() medicineId: number;

  @IsString()
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9._/-]+$/, { message: 'batchNumber must be alphanumeric' })
  batchNumber: string;

  @IsDateString() expiresAt: string;

  @Type(() => Number) @IsInt() @Min(1) quantity: number;

  /**
   * What this delivery cost per unit, as a string.
   *
   * A string rather than a number for the same reason every other amount is:
   * a float has already lost precision by the time validation sees it. Up to
   * four decimal places, matching the selling price — trade prices on
   * thousand-unit boxes routinely need them.
   *
   * Optional. Margin reporting wants it; receiving stock does not depend on it,
   * and blocking a delivery over a missing cost would be a bookkeeping
   * preference stopping a shelf being restocked.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,4})?$/, { message: 'costPrice must be a number with up to 4 decimal places' })
  costPrice?: string;
}
