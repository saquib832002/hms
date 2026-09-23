import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * A ward asking the pharmacy to send stock of something already prescribed.
 *
 * `prescriptionItemId` and nothing else identifies the medicine. There is no
 * free-text field here on purpose: a supply request that could name any drug
 * would be a prescription written by a nurse, wearing a logistics label.
 */
export class CreateSupplyRequestDto {
  @IsInt() prescriptionItemId: number;

  /**
   * How many the ward is asking for — advisory.
   *
   * The pharmacist decides what actually goes and the dispense records what
   * did. Capped because a typo asking for 5,000 tablets should be refused by
   * the form rather than by a pharmacist's patience.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) quantity?: number;

  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/**
 * A nurse asking a doctor to prescribe something not on the chart.
 *
 * `medicineText` is free text because the nurse is describing a need, not
 * selecting a product — "something for the nausea" is a legitimate request and
 * a catalogue picker would quietly turn this into a draft prescription with the
 * nurse's name on it.
 */
export class CreateMedicationRequestDto {
  @IsString() @MinLength(2) @MaxLength(200) medicineText: string;

  /**
   * Why, and it is required.
   *
   * A prescriber cannot answer "she needs something", and a request with no
   * clinical reason is one that gets ignored or — worse — guessed at. Twelve
   * characters is the same floor `BreakGlassGrant` uses for its written reason.
   */
  @IsString() @MinLength(12) @MaxLength(1000) reason: string;
}

/** Declining either kind. The reason is the whole point of the endpoint. */
export class DeclineRequestDto {
  @IsString() @MinLength(5) @MaxLength(500) reason: string;
}

/** Supplying. The note is optional — "sent 20" needs no justification. */
export class SupplyDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

/**
 * Answering a medication request by having written the prescription.
 *
 * The prescription id is REQUIRED. A status that could be set without one would
 * let the chart and the request disagree about whether a medicine exists — a
 * nurse reading "prescribed" and finding nothing on the chart is worse off than
 * one still waiting, because they stop chasing.
 */
export class FulfilMedicationRequestDto {
  @IsInt() prescriptionId: number;

  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
