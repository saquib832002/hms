import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SubscriptionStatus, TenantApplicationStatus, TenantModule } from '@prisma/client';

export class ApplicationQueryDto {
  @IsOptional() @IsEnum(TenantApplicationStatus) status?: TenantApplicationStatus;
}

/**
 * Overrides the reviewer may apply when approving.
 *
 * Every field optional: the application already carries what the applicant
 * asked for, and this exists for the cases where they asked for something taken
 * or wrong — a slug someone else has, a timezone they guessed.
 */
export class ApproveApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug may contain lowercase letters, numbers and hyphens only' })
  slug?: string;

  @IsOptional() @IsString() @MaxLength(64) timezone?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a three-letter ISO 4217 code' })
  currency?: string;

  @IsOptional() @IsString() @MaxLength(120) adminName?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) trialDays?: number;

  /**
   * What they are being sold. Absent means every module.
   *
   * Optional deliberately: the common case is a whole hospital, and a required
   * field here would make the reviewer restate the default on every approval —
   * which is how somebody eventually posts an empty array by accident and a new
   * customer's first hour is a product that refuses to book an appointment.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(TenantModule, { each: true })
  modules?: TenantModule[];
}

export class RejectApplicationDto {
  /**
   * Required, and long enough to be a sentence.
   *
   * "Why did we turn them down" is a question somebody asks months later,
   * usually when the same hospital applies again. A one-word reason answers it
   * no better than an empty one.
   */
  @IsString() @MinLength(10) @MaxLength(1000) reason: string;
}

/** Onboarding a hospital directly, with no application behind it. */
export class CreateTenantDto {
  @IsString() @MinLength(2) @MaxLength(200) hospitalName: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug may contain lowercase letters, numbers and hyphens only' })
  slug?: string;

  @IsEmail({}, { message: 'A valid administrator email is required' })
  @MaxLength(200)
  adminEmail: string;

  @IsString() @MinLength(2) @MaxLength(120) adminName: string;

  @IsOptional() @IsString() @MaxLength(64) timezone?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a three-letter ISO 4217 code' })
  currency?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) trialDays?: number;

  /**
   * What they are being sold. Absent means every module.
   *
   * Optional deliberately: the common case is a whole hospital, and a required
   * field here would make the reviewer restate the default on every approval —
   * which is how somebody eventually posts an empty array by accident and a new
   * customer's first hour is a product that refuses to book an appointment.
   */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(TenantModule, { each: true })
  modules?: TenantModule[];
}

export class SetSubscriptionDto {
  @IsEnum(SubscriptionStatus) status: SubscriptionStatus;

  /**
   * Explicit `null` clears the date and means open-ended; omitting the field
   * leaves whatever was there. The distinction matters — an invoiced hospital
   * with no fixed renewal is a normal state, not a missing value.
   */
  @IsOptional() @IsISO8601() endsAt?: string | null;

  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
