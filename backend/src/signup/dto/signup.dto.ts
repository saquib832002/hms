import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TenantModule } from '@prisma/client';

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

  /**
   * Which parts of the product they said they wanted. A **request**, and
   * advisory exactly as `requestedSlug` is.
   *
   * The vendor still sets `Tenant.modules` at approval. What a hospital was sold
   * is a commercial fact decided by a human reading the application, and a
   * public endpoint must not be the thing that decides it — otherwise anybody
   * on the internet is choosing their own entitlements and the approval step is
   * theatre. What this buys is a reviewer's picker that opens on the customer's
   * own answer instead of on all five.
   *
   * `@IsEnum` against the generated enum rather than a hand-typed list: adding a
   * sixth module must not leave this quietly refusing it, which is what a string
   * union copied into a DTO does.
   *
   * Absent and empty both mean "they did not say" — see the model comment for
   * why that is deliberately distinct from asking for everything.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(TenantModule, { each: true, message: 'requestedModules holds unknown modules' })
  requestedModules?: TenantModule[];

  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
