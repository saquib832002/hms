import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PlatformAuthController, PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformGuard } from './platform-auth';
import { PlatformPasswordResetService } from './platform-password-reset.service';

// PrismaModule, AuditModule, TenancyModule and MailModule are all @Global, so
// only the JWT signer needs importing here.
@Module({
  imports: [JwtModule.register({})],
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformService, PlatformGuard, PlatformPasswordResetService],
})
export class PlatformModule {}
