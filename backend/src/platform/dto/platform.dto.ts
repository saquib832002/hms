import { IsEmail, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class PlatformLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

/**
 * A vendor account changing its own password.
 *
 * `MinLength(12)` here and `checkPasswordStrength` in the service, for the
 * reason `OpenGrantDto.reason` carries its length twice: the DTO refuses a
 * malformed request at the edge, and the pure rule is what a test can assert
 * without standing up an HTTP pipeline. The rule is the authority.
 *
 * The current password is required even though the caller is already holding a
 * valid token. A vendor token opens break-glass grants against any hospital on
 * the deployment, so an unattended console must not be enough to take the
 * account away from the person it belongs to.
 */
export class ChangePlatformPasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}

/** Ask for a console reset link. An address and nothing else. */
export class ForgotPlatformPasswordDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;
}

/** Spend one. */
export class ResetPlatformPasswordDto {
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
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
