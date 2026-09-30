import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AuthModule } from '../auth/auth.module';

// AuthModule for `PasswordResetService`, so the public health check can say
// whether self-service reset would actually deliver anything on this
// deployment. Both login screens ask before offering the link.
@Module({ imports: [AuthModule], controllers: [HealthController] })
export class HealthModule {}
