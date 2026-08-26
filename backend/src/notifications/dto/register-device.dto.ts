import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class RegisterDeviceDto {
  /**
   * Expo push tokens look like `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`.
   * Validated by shape so an arbitrary string cannot be stored and later
   * posted to Expo on the hospital's behalf.
   */
  @IsString()
  @MaxLength(200)
  @Matches(/^Expo(nent)?PushToken\[[A-Za-z0-9._-]+\]$/, {
    message: 'pushToken is not a valid Expo push token',
  })
  pushToken: string;

  @IsOptional()
  @IsIn(['ios', 'android'])
  platform?: string;
}
