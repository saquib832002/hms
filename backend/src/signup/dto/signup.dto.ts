import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * What somebody has to type to ask for an account.
 *
 * DELIBERATELY SHORT
 * ------------------
 * Four required fields. Every extra question on a form that has not yet given
 * anybody anything loses a share of the people filling it in, and the vendor
 * can ask the rest on the phone. Bed count, staff numbers and department lists
 * are conversations, not form fields.
 *
 * NOTHING HERE IS TRUSTED FOR ANYTHING
 * ------------------------------------
 * This is unauthenticated input from the open internet. It creates a
 * `TenantApplication` row and nothing else: no `Tenant`, no `User`, no slug
 * reservation. Everything consequential happens at approval, under a platform
 * login, where a human has read it.
 */
export class SignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  hospitalName: string;

  /**
   * The URL-safe name they would like. A *request*, not a reservation.
   *
   * Collision is checked at approval rather than here, on purpose: validating
   * it live would turn this form into an oracle for which hospitals already
   * exist, which is a customer list anybody could enumerate.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'requestedSlug may contain lowercase letters, numbers and hyphens only',
  })
  requestedSlug?: string;

  @IsString() @MinLength(2) @MaxLength(120) contactName: string;

  @IsEmail({}, { message: 'A working email address is needed to reply to you' })
  @MaxLength(200)
  contactEmail: string;

  @IsOptional() @IsString() @MaxLength(40) contactPhone?: string;

  /** IANA zone. Applied at approval; validated there against the Intl database. */
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a three-letter ISO 4217 code' })
  currency?: string;

  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
