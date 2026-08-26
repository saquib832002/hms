import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AuditOutcome, Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { AuditService } from '../../audit/audit.service';
import { AuthUser } from '../types/auth-user';
import { attemptedEmail, resolveAuditTarget } from '../utils/audit-target';

/**
 * The only place errors become HTTP responses — and the only place that can
 * audit a denial.
 *
 * WHY FAILURE LOGGING LIVES HERE AND NOT IN THE INTERCEPTOR
 * --------------------------------------------------------
 * `AuditInterceptor` used to log both outcomes with `tap({ next, error })`.
 * It never recorded a single failure, and a live run proved it: 30 SUCCESS
 * rows, zero FAILURE rows, after deliberately triggering five 403s, a 401 and
 * three 429s.
 *
 * The cause is the same NestJS ordering rule the interceptor's own comment
 * cites. Guards run *before* interceptors. When `RolesGuard` throws, or
 * `JwtAuthGuard` rejects, or `ThrottlerGuard` refuses, `intercept()` is never
 * called — so there is no observable to attach an error handler to, and the
 * error path was unreachable code.
 *
 * An exception filter runs for all of them. So: the interceptor records
 * successes, this filter records failures, and nothing is logged twice.
 *
 * This matters beyond tidiness. "A receptionist walking sequential patient IDs
 * produces nothing but 403s" was the stated reason for logging failures — and
 * that was exactly the case being silently dropped.
 *
 * TWO OTHER RULES, both because this system handles PHI:
 *
 *  1. A stack trace never reaches the client. Stack traces in a Nest app
 *     routinely contain query parameters and DTO contents — here that means
 *     patient names, dates of birth, and diagnoses.
 *
 *  2. Prisma error messages are never forwarded. Prisma helpfully includes the
 *     offending field *values* in messages like "Unique constraint failed" —
 *     helpful in a terminal, a disclosure in a response body.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly audit: AuditService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, title, detail, errors } = this.translate(exception);

    this.recordFailure(req, status);

    this.logger.error(
      `${req.method} ${req.originalUrl} → ${status} [req:${req.requestId ?? '-'}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    res.status(status).type('application/problem+json').json({
      type: 'about:blank',
      title,
      status,
      detail,
      ...(errors ? { errors } : {}),
      instance: req.originalUrl,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Records the denial.
   *
   * `req.user` is present for a 403 — `JwtAuthGuard` populated it before
   * `RolesGuard` rejected — which is what makes "who was refused what"
   * answerable. For a 401 there is no user, and the attempted email is the only
   * identifier available; that is exactly the row worth keeping when someone is
   * guessing at accounts.
   *
   * The action name is `METHOD /path` rather than the `@AuditAction` constant:
   * a filter has no reliable handle on the route handler when the exception
   * came from a guard, and the path is the fact that matters.
   */
  private recordFailure(req: Request, status: number) {
    // Health checks fail noisily during startup and are not security events.
    if (req.path === '/api/v1/health') return;

    const user = req.user as AuthUser | undefined;

    this.audit.record({
      // Null for an anonymous failure — a login attempt against an address
      // that exists at no hospital genuinely belongs to none.
      tenantId: user?.tenantId ?? null,
      userId: user?.userId ?? null,
      actorEmail: user?.email ?? attemptedEmail(req),
      actorRole: user?.role ?? null,
      action: `${req.method} ${req.route?.path ?? req.path}`,
      method: req.method,
      path: req.route?.path ?? req.path,
      outcome: AuditOutcome.FAILURE,
      statusCode: status,
      ipAddress: req.clientIp ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: req.requestId ?? null,
      ...resolveAuditTarget(req),
    });
  }

  private translate(exception: unknown): {
    status: number;
    title: string;
    detail: string;
    errors?: unknown;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // ValidationPipe returns { message: string[] }. Those messages describe
      // field names and constraints, not values, so they are safe to return
      // and genuinely useful to the client.
      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        const msg = b.message;
        if (Array.isArray(msg)) {
          return {
            status,
            title: 'Validation failed',
            detail: 'One or more fields are invalid.',
            errors: msg,
          };
        }
        return {
          status,
          title: (b.error as string) ?? exception.name,
          detail: typeof msg === 'string' ? msg : exception.message,
        };
      }
      return { status, title: exception.name, detail: String(body) };
    }

    // Prisma — map to sensible codes, but never forward the message.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            title: 'Conflict',
            detail: 'A record with these details already exists.',
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            title: 'Not Found',
            detail: 'The requested record does not exist.',
          };
        case 'P2003':
          return {
            status: HttpStatus.BAD_REQUEST,
            title: 'Bad Request',
            detail: 'A referenced record does not exist.',
          };
        default:
          return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            title: 'Internal Server Error',
            detail: 'The request could not be completed.',
          };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        title: 'Bad Request',
        detail: 'The request was malformed.',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      title: 'Internal Server Error',
      detail: 'The request could not be completed.',
    };
  }
}
