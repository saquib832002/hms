import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ScheduleDosesDto {
  @IsInt() prescriptionId: number;

  /** How many days of chart to generate. Capped — this is a ward round, not a repeat prescription. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(14) days?: number;
}
