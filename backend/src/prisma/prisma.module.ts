import { Global, Module } from '@nestjs/common';
import { PrismaService, createTenantAwarePrisma } from './prisma.service';

/**
 * `PrismaService` is provided through a factory so every injection point gets
 * the tenant-aware proxy rather than the raw client.
 *
 * The class is still the DI token, so no service's constructor changes. What
 * changes is that `this.prisma.patient` now resolves to the current request's
 * tenant transaction. Providing the raw client here would compile, pass every
 * unit test, and silently run every query with no tenant set.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () => createTenantAwarePrisma(new PrismaService()),
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
