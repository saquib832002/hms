import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  /**
   * Deliberately returns nothing about the system beyond up/down. Health
   * endpoints are unauthenticated by definition, so they must not leak
   * version numbers, table counts, or connection strings.
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
    return { status: database === 'up' ? 'ok' : 'degraded', database };
  }
}
