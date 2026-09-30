import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PasswordResetService } from './password-reset.service';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtStrategy, PasswordResetService],
  // Exported so `HealthController` can say whether self-service reset actually
  // works on this deployment. A login screen that offers a link into a flow
  // with no mail transport is the failure this repo keeps reopening.
  exports: [AuthService, TokenService, PasswordResetService],
})
export class AuthModule {}
