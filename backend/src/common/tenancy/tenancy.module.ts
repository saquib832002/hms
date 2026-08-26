import { Global, Module } from '@nestjs/common';
import { ClinicSettingsService } from './clinic-settings.service';

/**
 * Global, like PrismaModule, because the clinic day is needed anywhere times
 * are generated or validated — appointments, doctors, admin reports — and
 * importing it into each feature module would be noise around a single
 * read-only lookup.
 */
@Global()
@Module({
  providers: [ClinicSettingsService],
  exports: [ClinicSettingsService],
})
export class TenancyModule {}
