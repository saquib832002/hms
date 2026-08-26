import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MeService } from './me.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('queue')
  @Roles(UserRole.DOCTOR)
  @AuditAction('QUEUE_VIEW')
  queue(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    return this.me.queue(user, date);
  }
}
