import { IsBoolean, IsString, MinLength, MaxLength } from 'class-validator';

/**
 * Undoing a handover that did not happen.
 *
 * Both fields are required, and neither is a formality.
 *
 * `notLeftPremises` is the only fact that distinguishes a reversal from a
 * return, and nothing in the database can tell them apart. Medicine that has
 * left cannot lawfully be resold in most jurisdictions, so the pharmacist
 * affirms it did not — the same shape as the allergy override, where a
 * decision the software cannot make is recorded as one a person made.
 *
 * `reason` is written down because a reversal moves stock and voids a bill.
 * "Patient could not pay", "wrong medicine picked", "patient changed their
 * mind" are different facts, and a month later the difference between them is
 * the difference between a training issue and a pricing one.
 */
export class ReverseDispenseDto {
  @IsString()
  @MinLength(10, {
    message:
      'Say why in a few words — this moves stock and voids a bill, and "error" tells the next reader nothing.',
  })
  @MaxLength(500)
  reason: string;

  @IsBoolean() notLeftPremises: boolean;
}
