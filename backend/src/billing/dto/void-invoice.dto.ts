import { IsString, MaxLength, MinLength } from 'class-validator';

export class VoidInvoiceDto {
  /**
   * Required. A voided invoice with no stated reason is indistinguishable from
   * one voided to hide something, and the person asking about it six months
   * later has nothing to go on.
   */
  @IsString() @MinLength(10) @MaxLength(500) reason: string;
}
