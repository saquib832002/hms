import { IsEmail, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class PlatformLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class OpenGrantDto {
  @IsInt()
  @Min(1)
  tenantId!: number;

  /**
   * Length is enforced here *and* in `validateGrantRequest`.
   *
   * Not redundant: the DTO stops a malformed request at the edge, and the pure
   * rule is what a test can assert without standing up a HTTP pipeline. The
   * rule is the authority — this is a courtesy.
   */
  @IsString()
  @MinLength(12)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  minutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ticketRef?: string;
}
