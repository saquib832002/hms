import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { TenantModule } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { IS_PLATFORM_ROUTE_KEY } from '../decorators/platform-route.decorator';
import { REQUIRES_MODULE_KEY } from '../decorators/requires-module.decorator';
import { AuthUser } from '../types/auth-user';
import { hasModule, moduleRefusal } from '../modules/tenant-modules';

/**
 * A hospital can only change what it has been sold.
 *
 * WHY THE METHOD, NOT A LIST OF ROUTES
 * ------------------------------------
 * Copied deliberately from `SubscriptionGuard`, which is the best-shaped guard
 * in this codebase. Keying on the HTTP verb means a route added to a module
 * tomorrow is covered without anybody remembering — and a route list rots: the
 * first endpoint somebody forgets is a write that keeps working for a tenant
 * that never bought the feature, and nothing anywhere would say so.
 *
 * The class-level `@RequiresModule()` is the only thing that has to be
 * remembered, and `module-coverage.spec.ts` fails the build on a controller in
 * a module's directory without one.
 *
 * WHY READS ARE REFUSED HERE AND NOT IN `SubscriptionGuard`
 * ---------------------------------------------------------
 * This guard used to let every read through, copying the subscription rule
 * wholesale. That was wrong, and the difference between the two is the whole
 * reason this comment is long.
 *
 * A lapsed subscription is automatic, common, and about money. It arrives
 * because a card expired, it can happen overnight, and the people it would
 * harm — a clinician who cannot open an allergy list — are not the people who
 * owe the money. Reads must never be refused for it, and they still are not.
 *
 * A module is none of those things. It is what the hospital was sold: set by a
 * human at the vendor, changed rarely, behind a confirmation that states how
 * many records are about to become unreachable. A pharmacy that never bought
 * the clinic has no appointments to hide, and hiding a screen it can never use
 * costs nothing. Where a module is removed from a hospital that *does* hold
 * records, that is a decision somebody took while looking at the count — and
 * one click of the same console gives it back.
 *
 * So the leverage here is stronger than the subscription's on purpose, and the
 * safety property that mattered is kept exactly where it was earned.
 *
 * WHAT IS STILL NEVER REFUSED
 * ---------------------------
 * Patients, staff accounts, clinic settings, the audit log and printing carry
 * no module at all — a module nobody can turn off is not a module, it is the
 * product. So a hospital reduced to nothing still has its patient list, its
 * people, and the record of who did what.
 *
 * ORDERING
 * --------
 * A guard rather than an interceptor, because the request has to be refused
 * before the handler runs and interceptors run after guards. That is the same
 * ordering lesson `AuditInterceptor` learned expensively — it tried to log
 * failures from a place that never sees them.
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    /*
     * The module is declared on the controller. A handler-level override is
     * accepted too — `getAllAndOverride` — for the one shape that will
     * eventually appear: a single route on a shared controller that belongs to
     * a different module.
     */
    const required = this.reflector.getAllAndOverride<TenantModule | undefined>(
      REQUIRES_MODULE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No module named: patients, staff, settings, the audit log. The product
    // rather than a part of it.
    if (!required) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // The vendor granting a module must not be blocked by the module.
    const isPlatform = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPlatform) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    /*
     * No method check, deliberately, and its absence is the design.
     *
     * `SubscriptionGuard` keys on the verb because it must let reads through.
     * This one refuses the route outright, so there is nothing to key on — and
     * a verb check reintroduced here would silently turn a boundary back into
     * a menu, which is what it was before.
     */

    /*
     * No user means no tenant to check. `JwtAuthGuard` runs before this and has
     * already refused anything unauthenticated that is not `@Public`, so
     * reaching here without one means a route this guard has no opinion about.
     * Passing is right; inventing a refusal would be guessing.
     */
    const user = request.user;
    if (!user) return true;

    if (hasModule(user.hospital.modules, required)) return true;

    /*
     * 403 naming the module, not a bare "Forbidden".
     *
     * The person reading this is a receptionist or a technician who has done
     * nothing wrong. They need to know that the system is not broken, that
     * their existing records are still there, and whom to ask — none of which
     * a status code conveys.
     */
    throw new ForbiddenException(moduleRefusal(required));
  }
}
