import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { LabBillingMode, PharmacyBillingMode, ReferralBilling } from '@prisma/client';
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

  /**
   * Whether the pharmacy bills on its own account or on the hospital's.
   *
   * Changing this does not restate anything already billed. Invoices already
   * raised keep the kind they were raised with, for the same reason changing
   * the currency relabels rather than converts: a setting that silently
   * rewrites history is not a setting, it is a migration nobody asked for.
   */
  @IsOptional()
  @IsEnum(PharmacyBillingMode)
  pharmacyBilling?: PharmacyBillingMode;

  /**
   * Does this hospital run a pharmacy at all?
   *
   * Off for a clinic that has none: the dispensing queue, stock and the
   * pharmacist role are furniture for a room that does not exist, and every
   * prescription is external without the doctor being asked.
   */
  @IsOptional() @IsBoolean() hasPharmacy?: boolean;

  /**
   * Tax off entirely. Off by default, and explicit rather than inferred from
   * whether any rates exist — so a hospital can set its table up and check it
   * before any of it reaches a patient's bill.
   */
  @IsOptional() @IsBoolean() taxEnabled?: boolean;

  /**
   * Whether the prices staff type already contain tax. India: yes, the MRP
   * includes GST. United States: no, tax is added at the till.
   */
  @IsOptional() @IsBoolean() pricesIncludeTax?: boolean;

  /**
   * The rate applied to consultation fees. Null means untaxed, which is the
   * correct answer in India — healthcare services are largely exempt while the
   * medicines dispensed at the same visit are not.
   */
  @IsOptional() @IsInt() consultationTaxRateId?: number | null;

  /**
   * Will this pharmacy accept prescriptions written at another hospital?
   *
   * The receiving half of a two-sided opt-in, and the thing that makes this
   * tenant findable by a partner at all. Off by default: appearing in somebody
   * else's directory is a decision.
   */
  @IsOptional() @IsBoolean() acceptsExternalPrescriptions?: boolean;

  /** Whether tests are billed by the lab or on the hospital's invoice. */
  @IsOptional() @IsEnum(LabBillingMode) labBilling?: LabBillingMode;

  /**
   * Does this hospital run a lab at all? Most small clinics do not — they draw
   * the blood and send it out.
   */
  @IsOptional() @IsBoolean() hasLab?: boolean;

  /**
   * Will this lab accept test orders raised at another hospital?
   *
   * The receiving half of the two-sided opt-in, and the thing that makes this
   * tenant findable by a partner at all. Off by default.
   *
   * **Reported from use**: the column and the lookup shipped without this
   * switch, so every attempt to add a partner lab was refused with "no lab is
   * accepting orders under that code" — correct, unexplainable, and impossible
   * to clear from anywhere in the product.
   */
  @IsOptional() @IsBoolean() acceptsExternalLabOrders?: boolean;

  /**
   * Which payers this lab takes referred work under. See `ReferralBilling`.
   *
   * An empty array is accepted deliberately — it means work is taken under no
   * arrangement, which is a real setup state. Refusing it would force a lab to
   * leave one switched on while it decides.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsEnum(ReferralBilling, { each: true })
  acceptedReferralBilling?: ReferralBilling[];
}
