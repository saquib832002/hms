import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/**
 * A bed label is short and gets read aloud on a handover.
 *
 * Letters, digits, spaces and hyphens only. Nothing else appears on a real bed
 * card, and the label is the thing a nurse says out loud when escalating —
 * punctuation in it is a transcription error waiting to happen.
 */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 \-/]*$/;

export class CreateWardDto {
  @IsString() @MaxLength(80) name: string;

  /** "2nd floor", "East wing". Free text — hospitals do not agree on a scheme. */
  @IsOptional() @IsString() @MaxLength(40) floor?: string;

  /**
   * Create this many beds along with the ward.
   *
   * The whole reason this exists: a 30-bed ward entered one bed at a time is
   * the kind of setup task somebody abandons half way, and a half-configured
   * ward looks exactly like a working one until a patient cannot be admitted.
   *
   * Capped at 200. A single ward larger than that is almost certainly a typo,
   * and the cost of the mistake is 5,000 rows somebody has to delete by hand.
   */
  @IsOptional() @IsInt() @Min(0) @Max(200) bedCount?: number;

  /** Prefix for generated labels: "A" gives A-01, A-02, … */
  @IsOptional() @IsString() @MaxLength(10) @Matches(LABEL) bedPrefix?: string;
}

export class UpdateWardDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(40) floor?: string;
}

export class AddBedsDto {
  /**
   * How many to add. Numbering continues from the highest existing label that
   * shares the prefix, so adding six beds to a ward twice does not collide.
   */
  @IsInt() @Min(1) @Max(200) count: number;

  @IsOptional() @IsString() @MaxLength(10) @Matches(LABEL) prefix?: string;
}

export class UpdateBedDto {
  @IsOptional() @IsString() @MaxLength(20) @Matches(LABEL) label?: string;

  /**
   * Taken out of service — maintenance, a deep clean, a broken bed.
   *
   * Distinct from deleting it, and the distinction is the point: an
   * out-of-service bed keeps its admission history and comes back with the
   * same label, which is what a recall or an incident review needs.
   */
  @IsOptional() @IsBoolean() isActive?: boolean;
}
