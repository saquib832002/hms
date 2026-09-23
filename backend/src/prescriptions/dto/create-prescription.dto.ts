import { Type } from 'class-transformer';
import { PrescriptionDestination } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PrescriptionItemDto {
  // Free text in Phase 1; becomes a FK to `Medicine` in Phase 4.
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  medicineName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  dosage: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  frequency: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  duration: string;

  /**
   * How many units to hand over — the number the pharmacist dispenses against.
   *
   * WHY THE PRESCRIBER STATES IT
   * The system used to infer this from `frequency` and `duration`, and used
   * the inference to decide whether a prescription was fully dispensed. When
   * either field could not be parsed the inference returned null and the
   * prescription stayed PARTIALLY_DISPENSED permanently, however much had
   * actually gone over the counter.
   *
   * Optional, and blank is meaningful: an as-needed or open-ended course has no
   * fixed total, and the pharmacist settles it. What blank must never mean
   * again is "the parser could not read the duration".
   *
   * Capped at 1000. A realistic mistake is a stray digit, and a basket
   * multiplied out by it is enormous, confident and wrong.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  quantityPrescribed?: number;
}

export class CreatePrescriptionDto {
  @IsInt()
  patientId: number;

  /**
   * Where the patient will fill it. Defaults to the hospital's own pharmacy.
   *
   * A destination is a routing note, never an authorisation: marking it
   * external does not stop this hospital's pharmacy dispensing it if the
   * patient turns up at the counter after all.
   */
  @IsOptional()
  @IsEnum(PrescriptionDestination)
  destination?: PrescriptionDestination;

  /**
   * The partner pharmacy, required when `destination` is PARTNER.
   *
   * A `PharmacyPartner.id` — this hospital's own row — rather than a raw tenant
   * id. Accepting a tenant id from a client would let a doctor address any
   * hospital on the platform, including ones that never agreed to receive
   * anything, which is precisely what the two-sided opt-in exists to prevent.
   */
  @IsOptional()
  @IsInt()
  partnerId?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemDto)
  items: PrescriptionItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
