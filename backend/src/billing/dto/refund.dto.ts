import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class RefundDto {
  /** String, for the same reason every other amount in this system is. */
  @IsString()
  @Matches(/^\d{1,8}(\.\d{1,2})?$/, {
    message: 'amount must be a positive value with at most 2 decimal places, sent as a string',
  })
  amount: string;

  /**
   * How the money is going back.
   *
   * Not inferred from the original payment, because it frequently differs — a
   * card payment refunded in cash at the desk is ordinary, and so is a card
   * reversal against a payment taken in three parts. Guessing here would put a
   * wrong figure in the method split that reconciles the till.
   */
  @IsEnum(PaymentMethod) method: PaymentMethod;

  /**
   * The payment being reversed, where one is identifiable.
   *
   * Optional because a cash refund often does not map to a single earlier
   * payment. Supply it when it matters — a card reversal has to reach the card
   * it came from, and this is the row that records which.
   */
  @IsOptional() @IsInt() paymentId?: number;

  /**
   * Required, and a real sentence.
   *
   * A refund is money leaving the clinic's own takings. "Why" is the first
   * question anyone reconciling the day will ask, and the same length floor as
   * a break-glass grant applies for the same reason: a single character
   * satisfies a validator and answers nothing.
   */
  @IsString() @MinLength(8) @MaxLength(500) reason: string;

  /**
   * Cancel the charge as well as returning the money. Defaults to true.
   *
   * WHY THIS IS A CHOICE AND WHY THE DEFAULT IS ON
   * ----------------------------------------------
   * A refund alone gives the money back and leaves the charge standing, so the
   * balance reappears and the invoice becomes payable again. In use that turned
   * into a loop with no exit: pay, refund, back to outstanding, pay again.
   *
   * Almost always the charge was wrong too, so the credit is the default. The
   * exception is real though and is why this is not simply implied: a returned
   * deposit against a charge that still stands, where the patient genuinely
   * still owes the money.
   */
  @IsOptional() @IsBoolean() cancelCharge?: boolean;
}
