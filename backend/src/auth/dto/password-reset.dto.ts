import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Ask for a link.
 *
 * Only an address, and deliberately no hospital code beside it. Login needs one
 * because it has to pick *which* account to check a password against; this does
 * not have to pick anything — it sends one message to the mailbox listing every
 * hospital the address is registered at. Asking for a code here would demand
 * the one thing somebody locked out is least likely to have to hand, to solve a
 * problem the email format already solves.
 */
export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;
}

/**
 * Spend it.
 *
 * `MinLength(12)` on the password mirrors `ChangePasswordDto`, and
 * `checkPasswordStrength` in the service is the authority — the DTO refuses
 * something malformed at the edge and the pure rule is what a test can assert.
 *
 * The token is a bare string with a length floor rather than a UUID or a regex:
 * it is 64 hex characters today, and pinning the shape here would mean two
 * places to change if that ever became something else, with the second one
 * failing as "invalid link" rather than as a type error.
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  token!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}
