import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DoseStatus } from '@prisma/client';

/** 24-hour clock, hospital-local. "08:00", "14:30", "22:15". */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Dose times a nurse set by hand.
 *
 * WHY THIS EXISTS
 * ---------------
 * `parseFrequency` deliberately refuses anything it does not recognise, and
 * returns those items as `unscheduled` with a reason. The screen then told the
 * nurse *"these need a nurse to set the times"* — and there was nowhere in
 * either client to set them. A refusal that leads nowhere is not a safe
 * default; it is a medicine missing from the chart with a sentence explaining
 * that somebody should have added it.
 *
 * The times are entered rather than derived, which is the whole point: the
 * system says what it could not read, and a human supplies what it means.
 */
export class ManualScheduleDto {
  @IsInt() prescriptionItemId: number;

  /**
   * The clock times, hospital-local: `["08:00", "20:00"]`.
   *
   * Local rather than UTC because a nurse thinks in ward time, and a hospital
   * that changes its clocks twice a year would otherwise see a chart drift by
   * an hour against the round it belongs to.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @Matches(HHMM, { each: true, message: 'times must be HH:MM on a 24-hour clock' })
  times: string[];

  /** Days of chart to lay down. Capped: this is a ward round, not a repeat. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(14) days?: number;
}

/**
 * One dose, at one moment.
 *
 * Covers the two things a recurring schedule cannot express, and both were
 * impossible before:
 *
 *  - **STAT** — a single dose due now, decided on a ward round.
 *  - **PRN given** — an "as needed" medicine has no due times by design, and
 *    `whyNotScheduled` tells the nurse to "record each dose as it is given".
 *    There was nowhere to record it. Passing a `status` creates the dose and
 *    signs for it in one action, because for PRN the two are the same event:
 *    nothing was ever *due*, it was given.
 */
export class OneOffDoseDto {
  @IsInt() prescriptionItemId: number;

  /** Defaults to now. A PRN dose given twenty minutes ago is ordinary. */
  @IsOptional() @IsDateString() dueAt?: string;

  /**
   * Omit to create a dose that is merely due (STAT). Supply it to create the
   * dose already recorded (PRN just given, or a refusal at the bedside).
   */
  @IsOptional() @IsEnum(DoseStatus) status?: DoseStatus;

  @IsOptional() @IsDateString() givenAt?: string;

  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
