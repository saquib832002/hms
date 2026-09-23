import { Controller, Get, Query } from '@nestjs/common';
import { UserRole, TenantModule } from '@prisma/client';
import { MeService } from './me.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

@Controller('me')
@RequiresModule(TenantModule.CLINIC)
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('queue')
  @Roles(UserRole.DOCTOR)
  @AuditAction('QUEUE_VIEW')
  queue(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    return this.me.queue(user, date);
  }

  /**
   * This doctor's own prescribing shortcuts.
   *
   * Read-only and about themselves — no patient is involved, so there is
   * nothing here to audit as a PHI access. Deliberately not given an
   * `@AuditAction`: it is fetched every time a prescription form opens, and
   * filling the trail with "a doctor opened a form" makes the rows that matter
   * harder to find.
   */
  @Get('prescribing')
  @Roles(UserRole.DOCTOR)
  prescribing(@CurrentUser() user: AuthUser) {
    return this.me.prescribing(user);
  }
}
