import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DischargeDto {
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
