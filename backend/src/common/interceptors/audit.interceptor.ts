import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditOutcome } from '@prisma/client';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AuditService } from '../../audit/audit.service';
import { AUDIT_ACTION_KEY } from '../decorators/audit.decorator';
import { AuthUser } from '../types/auth-user';
import { attemptedEmail, resolveAuditTarget } from '../utils/audit-target';

/**
 * One place, applied globally. Every PHI-touching request lands here.
 *
 * WHY AN INTERCEPTOR AND NOT MIDDLEWARE
 * -------------------------------------
 * The original architecture note said "audit logging lives in middleware".
 * In NestJS that cannot work: middleware runs *before* guards, so at that
 * point there is no `req.user` and no handler metadata — it can record that
 * a request happened, but not who made it or whether it was allowed. An
 * interceptor runs after the guards and can see both. Same intent, correct
 * primitive.
 *
 * SUCCESSES ONLY — failures are recorded by AllExceptionsFilter.
 *
 * This interceptor used to log both with `tap({ next, error })`, and the error
 * branch was unreachable code. The same ordering rule cited above is why:
 * guards run *before* interceptors, so a rejection from `RolesGuard`,
 * `JwtAuthGuard` or `ThrottlerGuard` means `intercept()` is never called and
 * there is no observable to attach an error handler to.
 *
 * A live run made it obvious — 30 SUCCESS rows and zero FAILURE rows after
 * deliberately triggering five 403s, a 401 and three 429s. Nothing in the unit
 * suite could catch it; it is a property of the framework's runtime ordering,
 * not of any function.
 *
 * Failures now come from the exception filter, which does run for all of them.
 * Keeping successes here preserves the `@AuditAction` constant, which the
 * filter cannot see.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  /** Read-only, non-PHI endpoints. Logging these is noise that buries signal. */
  private static readonly SKIP = new Set(['/api/v1/health', '/api/v1/auth/me']);

  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();

    if (AuditInterceptor.SKIP.has(req.path)) return next.handle();

    const action =
      this.reflector.getAllAndOverride<string>(AUDIT_ACTION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? `${req.method} ${req.route?.path ?? req.path}`;

    const base = {
      action,
      method: req.method,
      path: req.route?.path ?? req.path,
      ipAddress: req.clientIp ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: req.requestId ?? null,
      ...resolveAuditTarget(req),
    };

    return next.handle().pipe(
      tap(() => {
        const user = req.user as AuthUser | undefined;
        this.audit.record({
          ...base,
          tenantId: user?.tenantId ?? null,
          userId: user?.userId ?? null,
          actorEmail: user?.email ?? attemptedEmail(req),
          actorRole: user?.role ?? null,
          outcome: AuditOutcome.SUCCESS,
          statusCode: http.getResponse<Response>().statusCode,
        });
      }),
      // No error handler here on purpose — AllExceptionsFilter owns failures,
      // and duplicating it would double-log exceptions thrown inside handlers.
    );
  }

}
