import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ALLOWED_SLOT_MINUTES } from '../../common/tenancy/clinic-settings';

/**
 * What a hospital admin may change about their own clinic day.
 *
 * Every field optional: the settings screen sends only what was edited, and a
 * partial update must not silently reset the rest to defaults.
 *
 * There is deliberately no tenantId here. An admin edits their own hospital and
 * only their own; the tenant comes from the authenticated user's row, and
 * accepting it from the client would be a one-line route into another
 * hospital's configuration.
 */
export class UpdateClinicSettingsDto {
  /** IANA zone, e.g. "America/Chicago". Validated against the Intl database. */
  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(ALLOWED_SLOT_MINUTES as unknown as number[], {
    message: `slotMinutes must be one of ${ALLOWED_SLOT_MINUTES.join(', ')}`,
  })
  slotMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  clinicStartHour?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  clinicEndHour?: number;

  /** ISO 4217, e.g. USD. Relabels existing amounts; it does not convert them. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a three-letter ISO 4217 code' })
  currency?: string;
}
