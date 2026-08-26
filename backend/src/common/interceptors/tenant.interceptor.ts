import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable, from } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../types/auth-user';

/**
 * Opens the tenant transaction for the request.
 *
 * ORDERING
 * --------
 * Must run after JwtAuthGuard, because it needs `req.user`. Interceptors run
 * after guards, so registering it as a global interceptor is sufficient — the
 * same ordering fact that made AuditInterceptor the right home for success
 * logging and the wrong home for failures.
 *
 * It must also run *before* AuditInterceptor, so that the audit write lands
 * inside the tenant transaction and gets stamped with the right hospital.
 * Global interceptors run in registration order, so it is listed first in
 * app.module.ts.
 *
 * UNAUTHENTICATED REQUESTS
 * ------------------------
 * Login, refresh and health have no user, so no tenant is set and no
 * transaction is opened. Those paths touch only global tables (User lookup by
 * a superuser-owned query, RefreshToken) or none at all. Any tenant table they
 * did touch would correctly return nothing.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as AuthUser | undefined;

    if (!user?.tenantId) return next.handle();

    // The handler's observable is consumed inside the transaction so the
    // transaction stays open for the whole request. Returning the observable
    // without awaiting it would commit before the handler had run a query, and
    // every subsequent query would find app.tenant_id unset.
    return from(
      this.prisma.forTenant(user.tenantId, async () => {
        const { lastValueFrom } = await import('rxjs');
        return lastValueFrom(next.handle());
      }),
    );
  }
}
