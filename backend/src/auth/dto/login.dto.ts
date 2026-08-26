import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  /**
   * Which hospital, as a tenant slug.
   *
   * Optional: an address that exists at exactly one hospital does not need it.
   * Required in practice for anyone with accounts at two, because login refuses
   * to guess — see AuthService.findLoginCandidate.
   *
   * Safe to accept from the client. It selects which account to check a
   * password against and nothing more; every authorisation decision afterwards
   * reads the tenant from the authenticated row.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9-]+$/i, { message: 'hospital must be a slug (letters, numbers, hyphens)' })
  hospital?: string;
}
