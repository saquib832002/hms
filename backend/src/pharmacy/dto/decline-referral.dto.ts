import { IsString, MaxLength, MinLength } from 'class-validator';

export class DeclineReferralDto {
  /**
   * Required, and long enough to be a sentence.
   *
   * The sending hospital has no way to ask why — there is no back-channel by
   * design — so this is read by whoever at this pharmacy is asked about it
   * later, and by the patient standing there. "No" on its own is not an answer
   * anybody can act on.
   */
  @IsString() @MinLength(6) @MaxLength(500) reason: string;
}
