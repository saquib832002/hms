import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdmitDto {
  @IsInt() patientId: number;
  @IsInt() bedId: number;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
