import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CounterSaleLineDto {
  @IsInt() medicineId: number;
  @IsInt() @Min(1) quantity: number;
}

/**
 * An over-the-counter sale: somebody buys medicine without a prescription.
 *
 * WHY THIS IS NOT A DISPENSE DTO WITH OPTIONAL FIELDS
 * ---------------------------------------------------
 * A dispense is keyed on prescription items — the pharmacist is filling
 * something a doctor wrote, and the server already knows what and how much. A
 * counter sale is keyed on the catalogue, because nothing was written down
 * before the person walked in. Sharing one DTO would make both halves optional
 * and neither meaningful, and the validation would stop saying anything.
 */
export class CounterSaleDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => CounterSaleLineDto)
  lines: CounterSaleLineDto[];

  /**
   * Optional, and optional is the point.
   *
   * Most counter trade is anonymous — somebody buying paracetamol is not under
   * the hospital's care, and creating a `Patient` row for them would put a
   * stranger into the list reception searches, indistinguishable from a real
   * patient. Set it where the buyer *is* a patient and the sale should show on
   * their record.
   */
  @IsOptional() @IsInt() patientId?: number;

  /**
   * A name for the receipt where there is no patient record. Free text, not
   * stored against anybody, and not searchable.
   */
  @IsOptional() @IsString() @MaxLength(120) buyerName?: string;

  @IsOptional() @IsString() @MaxLength(1000) notes?: string;

  /**
   * A prescription written at another hospital and sent here.
   *
   * Filled through the counter-sale path rather than the dispensing one,
   * because the prescription itself belongs to the other hospital — there is no
   * `Prescription` row in this tenant to key on, and inventing one would mean
   * inventing a `Patient` for somebody not under this hospital's care.
   *
   * What the pharmacist does is read the referral's lines, find the matching
   * medicines in *their own* catalogue, and sell them. The same mapping problem
   * the uncatalogued-item flag already describes inside one hospital, made
   * explicit across two.
   */
  @IsOptional() @IsInt() referralId?: number;
}
