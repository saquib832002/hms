import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';

/**
 * The global rate limiter, with one change to how requests are counted.
 *
 * THE PROBLEM WITH THE DEFAULT
 * ----------------------------
 * `ThrottlerGuard` buckets by client IP. A live run showed what that means for
 * login: five sign-ins from one address exhausted the bucket and the sixth
 * member of staff — a different person, a correct password — got a 429.
 *
 * A hospital NATs its whole site behind one or two addresses, and a shift
 * change is dozens of people signing in within the same minute. Per-IP limiting
 * turns a brute-force control into a self-inflicted outage at the busiest
 * moment of the day, and the people locked out are the ones who did nothing
 * wrong.
 *
 * THE FIX
 * -------
 * On `/auth/login`, bucket by IP *and* the account being attempted. An attacker
 * guessing at one account still gets five tries a minute; colleagues no longer
 * consume each other's allowance.
 *
 * This is not a weakening. Spraying one guess across many accounts from one IP
 * is still bounded — every other route stays IP-bucketed at the global limit —
 * and repeated failures against any single account trip the lockout in
 * `AuthService` (5 failures → 15 minutes), which is the control that actually
 * belongs to that threat.
 *
 * Overriding the tracker on the *global* guard rather than adding a second one
 * matters: a route-level guard does not replace the global one, so both would
 * run and the IP-bucketed global limit would still be the binding constraint.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const ip = req.ip ?? req.clientIp ?? 'unknown';

    if (req.path?.endsWith('/auth/login')) {
      const body = req.body as { email?: unknown; hospital?: unknown } | undefined;
      const email = body?.email;
      const account = typeof email === 'string' ? email.trim().toLowerCase() : 'anonymous';
      // The same address can exist at two hospitals and mean two different
      // people. Without the slug in the key they would share one bucket, so a
      // failing login at one hospital would throttle a colleague at another.
      const hospital = typeof body?.hospital === 'string' ? body.hospital.toLowerCase() : '-';
      return `login:${ip}:${hospital}:${account}`;
    }

    return ip;
  }

  /*
   * WHY THERE IS NO PER-TENANT BUCKET HERE
   * --------------------------------------
   * A per-hospital bucket looks obviously right — one busy tenant should not
   * exhaust another's allowance — and it cannot be written in this class.
   *
   * This guard is registered first, ahead of JwtAuthGuard, so that an
   * over-limit request is rejected before anything expensive happens. That
   * means `req.user` does not exist yet. Reading `req.user.tenantId` here
   * compiles, type-checks, and is always undefined: every request would fall
   * through to the plain IP bucket and the tenant branch would never execute.
   *
   * Reading the tenant from the JWT claim without verifying it is worse than
   * doing nothing: this guard does not validate signatures, so an attacker
   * could mint a fresh bucket per request by varying the claim and remove the
   * rate limit entirely.
   *
   * A real per-tenant limit therefore belongs after authentication — a separate
   * interceptor with its own store — not here. Until then IP bucketing is the
   * honest behaviour. This is the same ordering trap that made failure
   * auditing unreachable for six phases; see CLAUDE.md.
   */
}
