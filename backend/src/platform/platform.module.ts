import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PlatformAuthController, PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformGuard } from './platform-auth';

// PrismaModule, AuditModule and TenancyModule are all @Global, so only the
// JWT signer needs importing here.
@Module({
  imports: [JwtModule.register({})],
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformService, PlatformGuard],
})
export class PlatformModule {}
