import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(128) currentPassword: string;

  /** Strength is checked in the service so the message can be specific. */
  @IsString() @MinLength(12) @MaxLength(128) newPassword: string;
}
