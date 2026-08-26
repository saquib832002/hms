import { IsOptional, IsString } from 'class-validator';

export class RefreshDto {
  /**
   * Web sends the refresh token as an httpOnly cookie; mobile has no cookie
   * jar worth relying on and sends it in the body instead. Either is accepted.
   */
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
