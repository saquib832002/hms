import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordResetService } from '../auth/password-reset.service';

@Controller('health')
export class HealthController {
  constructor(
    private prisma: PrismaService,
    private reset: PasswordResetService,
  ) {}

  /**
   * Deliberately returns nothing about the system beyond up/down. Health
   * endpoints are unauthenticated by definition, so they must not leak
   * version numbers, table counts, or connection strings.
   *
   * `passwordResetAvailable` is the one capability flag, and it is here rather
   * than on a route of its own because both login screens need it *before*
   * anybody has signed in, and this is already the public thing they can ask.
   *
   * It is safe to expose: it says whether this deployment has a mail transport,
   * which is a property of the installation and not of any person or hospital.
   * It is *necessary* to expose because the alternative is a "Forgot password?"
   * link that leads to a form that says a link is on its way when nothing was
   * sent — which is the exact failure this codebase has recorded a dozen times,
   * and the most painful place to repeat it is the screen somebody reaches when
   * they are already locked out.
   */
  @Public()
  @Get()
  async check() {
    let database = 'down';
    try {
      await this.prisma.department.count();
      database = 'up';
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      passwordResetAvailable: this.reset.available,
      /*
       * `smtp` | `log` | `none`. Sent so the clients can *say* which rather
       * than silently offering a link that behaves differently on a
       * developer's machine — a control that works in one environment and not
       * another, with nothing on screen admitting it, is how a flow gets
       * believed to work when it does not.
       *
       * Safe on a public endpoint for the same reason the flag is: it
       * describes the installation, not a person or a hospital. In production
       * the only values anybody sees are `smtp` and `none`.
       */
      passwordResetDelivery: this.reset.delivery,
    };
  }
}
