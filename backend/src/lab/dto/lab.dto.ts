import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  LabCategory,
  LabOrderDestination,
  LabPriority,
  LabSpecimenType,
  ReferralBilling,
} from '@prisma/client';

/**
 * Validation for the diagnostics module.
 *
 * The caps are deliberately generous on prose and tight on anything that
 * multiplies. A histopathology report runs to paragraphs and truncating one is
 * a clinical error, so `findings` is long; a requisition of two hundred tests
 * is a mistake or an attack, so the array is short.
 */

export class AnalyteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string | null;

  /*
   * Numeric limits arrive as strings for the same reason money does: a range
   * boundary is compared against a measurement, and `parseFloat("12abc")`
   * returning 12 is the coercion `money.ts` exists to refuse.
   */
  @IsOptional()
  @IsNumberString()
  refLow?: string | null;

  @IsOptional()
  @IsNumberString()
  refHigh?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  refText?: string | null;

  @IsOptional()
  @IsNumberString()
  criticalLow?: string | null;

  @IsOptional()
  @IsNumberString()
  criticalHigh?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  position?: number;
}

export class CreateLabTestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(24)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsEnum(LabCategory)
  category!: LabCategory;

  @IsOptional()
  @IsEnum(LabSpecimenType)
  specimenType?: LabSpecimenType;

  @IsOptional()
  @IsNumberString()
  sellingPrice?: string | null;

  @IsOptional()
  @IsInt()
  taxRateId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8760)
  turnaroundHours?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  preparation?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => AnalyteDto)
  analytes?: AnalyteDto[];
}

export class UpdateLabTestDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsEnum(LabCategory)
  category?: LabCategory;

  @IsOptional()
  @IsEnum(LabSpecimenType)
  specimenType?: LabSpecimenType;

  /**
   * Null clears the price, which is not the same as setting it to zero.
   *
   * `@IsOptional()` accepts null as well as undefined, so the service has to
   * tell "not sent" from "sent as null" itself — the distinction that broke
   * `PATCH /letterhead` the first time it ran.
   */
  @IsOptional()
  @IsNumberString()
  sellingPrice?: string | null;

  @IsOptional()
  @IsInt()
  taxRateId?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8760)
  turnaroundHours?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  preparation?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => AnalyteDto)
  analytes?: AnalyteDto[];
}

export class CreateLabOrderDto {
  @IsInt()
  patientId!: number;

  @IsArray()
  @ArrayMinSize(1)
  // A requisition of two hundred tests is a mistake or an attack. Twenty is
  // more than any real form.
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  testIds!: number[];

  @IsOptional()
  @IsEnum(LabPriority)
  priority?: LabPriority;

  @IsOptional()
  @IsEnum(LabOrderDestination)
  destination?: LabOrderDestination;

  /** The `LabPartner` row id, never a raw tenant id. */
  @IsOptional()
  @IsInt()
  partnerId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  clinicalDetails?: string;
}

export class CancelLabOrderDto {
  /**
   * Required, and at least a few words.
   *
   * A cancelled test with no reason is indistinguishable from one cancelled by
   * accident, and the person who finds it is the doctor wondering why a result
   * never came.
   */
  @IsString()
  @MinLength(6)
  @MaxLength(500)
  reason!: string;
}

export class RejectSpecimenDto {
  /**
   * Required. This is the message that gets somebody to take blood again, and
   * "rejected" on its own sends a ward to the telephone — which is the thing
   * the worklist replaces.
   */
  @IsString()
  @MinLength(6)
  @MaxLength(500)
  reason!: string;
}

export class ResultValueDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  analyteName!: string;

  /**
   * A string, always. "<0.01", "No growth" and "5.4" are all real laboratory
   * results — see `reference-range.ts`.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string | null;
}

export class RecordResultDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ResultValueDto)
  values?: ResultValueDto[];

  // Long, because a histopathology report is paragraphs and truncating one is
  // a clinical error rather than a formatting one.
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  findings?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  impression?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  methodology?: string | null;
}

export class CriticalNotifiedDto {
  /**
   * Who was told. Free text for the same reason `escalatedTo` is: the registrar
   * covering a ward at 3am usually has no account here, and demanding a user id
   * would mean the commonest real call could not be recorded at all.
   */
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  notifiedTo!: string;
}

export class VerifyLabOrderDto {
  /**
   * Named where the authorising pathologist is not a user of this system.
   * Absent means the signed-in technician authorised it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  externalVerifiedBy?: string | null;
}

export class AddLabPartnerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  slug!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label!: string;

  /**
   * Who pays this lab. Optional, defaulting to ORIGIN_PAYS — which is what
   * every partnership predating this was silently doing, so an old client that
   * does not send it keeps the arrangement it already had.
   */
  @IsOptional()
  @IsEnum(ReferralBilling)
  billing?: ReferralBilling;
}

/**
 * Change how an existing partnership is billed.
 *
 * Its own DTO rather than a partial of the one above, because a body and its
 * DTO were free to disagree once already: the lab-test form posted one literal
 * to both create and update, `isActive` belonged to only one of them, and the
 * global pipe refused it with nothing on screen but *Bad Request Exception*.
 * Two contracts, two shapes.
 */
/**
 * Mark a partner laboratory's charge as dealt with, or undo that.
 *
 * `settled` is explicit rather than a toggle inferred from the current state,
 * because two people on the same screen would otherwise flip each other's
 * work — and the commonest correction here is un-marking the wrong row.
 */
export class SettlePartnerChargeDto {
  @IsBoolean()
  settled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

/**
 * Settle a whole month's charges from one laboratory.
 *
 * `month` is optional and means "the one on screen" — but the client always
 * sends it, because the screen and the server resolving "now" a second apart
 * across a month boundary would settle the wrong month. `@Matches` rather than
 * a date type: this is a hospital-local calendar month, not an instant, and
 * parsing it as a `Date` is what puts a payment taken at 23:40 on the 31st into
 * the following month.
 */
export class SettlePartnerStatementDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'month looks like 2026-09' })
  month?: string;

  /**
   * The period, when it is not a whole month.
   *
   * Referral agreements are written weekly, ten-daily and fortnightly as often
   * as monthly, so settling has to name the same span the statement covered —
   * otherwise a hospital reconciling a fortnightly bill can only mark a month
   * settled, which closes rows the statement never mentioned.
   *
   * `@Matches` rather than a date type, exactly as `month` is: these are
   * hospital-local calendar days, not instants, and parsing them as a `Date`
   * is what moves a boundary for every hospital east of Greenwich.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from looks like 2026-09-01' })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to looks like 2026-09-15' })
  to?: string;

  @IsBoolean()
  settled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class UpdateLabPartnerDto {
  @IsEnum(ReferralBilling)
  billing!: ReferralBilling;
}

export class DeclineLabReferralDto {
  @IsString()
  @MinLength(6)
  @MaxLength(500)
  reason!: string;
}

/** One test's result, sent back to the hospital that ordered it. */
export class ReferralResultItemDto {
  @IsInt()
  sourceOrderItemId!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ResultValueDto)
  values?: ResultValueDto[];

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  findings?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  impression?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  methodology?: string | null;
}

/**
 * Which of this laboratory's tests each referred test corresponds to.
 *
 * WHY A MAPPING STEP AND NOT AN EXACT CODE MATCH
 * ----------------------------------------------
 * Test codes are local vocabulary. One hospital's `FBC` is another's `CBC`, and
 * two independent businesses have no reason to have agreed on a compendium.
 * Matching on the code alone worked only where both sides happened to use the
 * same string, and refused everything else with "add it to the catalogue" —
 * an instruction the technician reading it cannot follow, because creating a
 * test is an administrator's job.
 *
 * That is the shape this project keeps repeating: a correct refusal with no
 * route out. Mapping is the route out, and it is also what reference labs
 * actually do — inbound codes are mapped to the performing lab's own.
 *
 * Optional: where the codes do agree the server matches them itself, so the
 * common case still takes one tap.
 */
export class MapReferralItemDto {
  @Type(() => Number) @IsInt() referralItemId!: number;
  @Type(() => Number) @IsInt() labTestId!: number;
}

export class AcceptLabReferralDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MapReferralItemDto)
  mappings?: MapReferralItemDto[];
}

export class ReturnReferralResultDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReferralResultItemDto)
  items!: ReferralResultItemDto[];

  /**
   * Who authorised it at this lab. Required on the way out, because a result
   * arriving at another hospital with nobody's name on it cannot be queried,
   * and "who signed this off" is the first thing asked when one is disputed.
   */
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  verifiedBy!: string;
}
