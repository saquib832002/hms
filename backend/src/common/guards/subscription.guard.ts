import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_PLATFORM_ROUTE_KEY } from '../decorators/platform-route.decorator';
import { AuthUser } from '../types/auth-user';
import { canWrite, refusalMessage } from '../subscription/subscription';

/**
 * A hospital whose subscription has lapsed can read everything and write
 * nothing.
 *
 * WHY A GUARD AND NOT AN INTERCEPTOR
 * ----------------------------------
 * The request must be refused before the handler runs, and interceptors run
 * after guards. This is the same ordering lesson the audit layer learned the
 * expensive way: `AuditInterceptor` tried to log failures and could not,
 * because a rejection means `intercept()` is never called. Putting a refusal in
 * an interceptor would work for the happy path and quietly not run for the
 * cases that matter.
 *
 * WHY THE METHOD, NOT A LIST OF ROUTES
 * ------------------------------------
 * Keying on the HTTP verb means a route added tomorrow is covered without
 * anybody remembering to add it. A route list is a thing that rots: the first
 * endpoint somebody forgets to add is a write that keeps working after a
 * hospital has been suspended, and nothing anywhere would say so.
 *
 * WHAT IS DELIBERATELY EXEMPT
 * ---------------------------
 * `@Public()` routes, because login and refresh are how somebody reaches the
 * readable data at all — blocking them is the lockout this design refuses.
 * `@PlatformRoute()`, because the vendor restoring the subscription must not be
 * blocked by the subscription. And changing your own password, because a user
 * forced to change it would otherwise face an unpassable door.
 *
 * See `subscription.ts` for why the answer is writes-only, and
 * `subscription.spec.ts` for the assertions that stop it becoming a lockout.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  /**
   * Handlers that keep working whatever the commercial state.
   *
   * Written as controller.handler rather than a path, so a route rename cannot
   * silently drop an exemption and lock somebody out of their own password.
   */
  private static readonly ALWAYS_ALLOWED = new Set([
    'MePasswordController.changePassword',
    // Switching to a role you already hold changes nothing about the hospital's
    // data. Blocking it would strand an owner-doctor in whichever role they
    // happened to be wearing.
    'AuthController.switchRole',
  ]);

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const isPlatform = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPlatform) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const method = (request.method ?? 'GET').toUpperCase();

    // Reads always pass. This is the whole design in one line.
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

    const handlerName = `${context.getClass().name}.${context.getHandler().name}`;
    if (SubscriptionGuard.ALWAYS_ALLOWED.has(handlerName)) return true;

    const user = request.user;
    /*
     * No user means no subscription to check. `JwtAuthGuard` runs before this
     * and has already refused anything unauthenticated that is not @Public, so
     * reaching here without one means a route this guard has no opinion about.
     * Passing is right; inventing a refusal would be guessing.
     */
    if (!user) return true;

    if (canWrite({ status: user.hospital.subscriptionStatus, endsAt: user.hospital.subscriptionEndsAt })) {
      return true;
    }

    /*
     * 403 with an explanation, not 402 Payment Required.
     *
     * 402 is barely implemented anywhere and clients treat it unpredictably;
     * more to the point, the person reading this message is a receptionist who
     * has done nothing wrong and needs to know who to tell, not an HTTP status
     * about money. The failure is audited by `AllExceptionsFilter` like every
     * other refusal, so a hospital can see exactly what stopped working and when.
     */
    throw new ForbiddenException(
      refusalMessage({
        status: user.hospital.subscriptionStatus,
        endsAt: user.hospital.subscriptionEndsAt,
      }),
    );
  }
}
