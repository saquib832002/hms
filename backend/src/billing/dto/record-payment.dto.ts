import { IsDateString, IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class RecordPaymentDto {
  /** String, for the same reason invoice lines are. */
  @IsString()
  @Matches(/^\d{1,8}(\.\d{1,2})?$/, {
    message: 'amount must be a positive value with at most 2 decimal places, sent as a string',
  })
  amount: string;

  @IsEnum(PaymentMethod) method: PaymentMethod;

  /** Card auth code, cheque number, bank reference, insurance claim id. */
  @IsOptional() @IsString() @MaxLength(100) reference?: string;

  /** When the money actually arrived, which may not be when it was entered. */
  @IsOptional() @IsDateString() receivedAt?: string;

  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
