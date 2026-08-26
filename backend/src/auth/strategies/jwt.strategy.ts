import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { AccessTokenPayload } from '../token.service';
import { SESSION_USER_INCLUDE, toSessionUser } from '../session-user';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret') as string,
    });
  }

  /**
   * Re-reads the user on every request rather than trusting the token claims.
   *
   * This costs one indexed primary-key lookup per request. The alternative is
   * that a deactivated account, or one whose role was just downgraded, keeps
   * its old access for up to the token TTL. For a system holding patient
   * records that is not an acceptable window.
   */
  async validate(payload: AccessTokenPayload): Promise<AuthUser> {
    /*
     * Two steps, for the same reason login has two.
     *
     * This guard runs before TenantInterceptor opens a tenant transaction, so
     * `users` is still hidden by RLS. `app_user_tenant` is a SECURITY DEFINER
     * function returning one integer — the hospital — and nothing else. It
     * returns NULL if the user or the hospital is deactivated, so a suspended
     * account or a suspended tenant stops working immediately rather than when
     * the access token happens to expire.
     *
     * The full row is then read through the policies like any other query.
     */
    // The cast is not optional. Prisma's library engine binds a JS number as
    // bigint and its adapter build as int; naming the type here means the call
    // resolves the same way under either.
    const [row] = await this.prisma.unscoped.$queryRaw<{ tenant_id: number | null }[]>`
      SELECT app_user_tenant(${payload.sub}::bigint) AS tenant_id
    `;
    const tenantId = row?.tenant_id ?? null;

    if (tenantId == null) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    const user = await this.prisma.forTenant(tenantId, () =>
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: SESSION_USER_INCLUDE,
      }),
    );

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    // The token carries tenantId only as a tripwire. The row is authoritative;
    // a mismatch means either a forged token or a session that outlived a
    // tenant move, and neither should be allowed to continue.
    if (payload.tenantId !== undefined && payload.tenantId !== user.tenantId) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    /*
     * The token's role is a REQUEST, not a grant.
     *
     * `resolveActiveRole` inside toSessionUser checks it against the roles this
     * user actually holds, read from the database on this request. A forged or
     * stale claim — including one minted before an admin revoked the role —
     * falls back to what they are still entitled to rather than being honoured.
     *
     * This is the same reasoning as `tenantId` above: a claim describes what
     * the holder of a signing key asserts, and the row is what is true.
     */
    return toSessionUser(user, payload.role as UserRole | undefined);
  }
}
