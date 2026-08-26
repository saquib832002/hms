import { IsInt } from 'class-validator';

export class TransferDto {
  @IsInt() bedId: number;
}
