import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';
import { LoginDto } from './dto/login.dto';
import { SESSION_USER_INCLUDE, toSessionUser } from './session-user';
import { AuthUser } from '../common/types/auth-user';
import { UserRole } from '@prisma/client';
import { canActAs } from '../users/role-assignment';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  /**
   * Exactly what `GET /auth/me` returns — the same `AuthUser`, from the same
   * mapper.
   *
   * It used to be a separate inline shape, and the two drifted: `hospital` was
   * added to one and not the other, so the currency was right after a page
   * reload and missing immediately after signing in. Typing this as `AuthUser`
   * means the compiler now objects if they diverge again.
   *
   * `mustChangePassword` is part of it: true after an admin created the account
   * or reset the password, and the client must route to a change-password
   * screen before anything else.
   */
  user: AuthUser;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private prisma: PrismaService,
    private tokens: TokenService,
  ) {}

  static hashPassword(plain: string): Promise<string> {
    // Argon2id defaults from @node-rs/argon2 follow the OWASP recommendation.
    return hash(plain);
  }

  /**
   * Finds the account to authenticate against, across hospitals.
   *
   * Login is the one request with no tenant yet — establishing it is the whole
   * point — so this query is deliberately unscoped and is the only place an
   * email is looked up across tenants.
   *
   * Email is unique *per hospital*, so an address can exist at more than one.
   * Two ways to resolve that:
   *
   *  - `hospital` (a tenant slug) supplied: use it. Safe despite being
   *    client-controlled, because it only selects which row to check a password
   *    against. Authorisation still comes from the row that authenticates.
   *
   *  - Not supplied: accept only if the address is unambiguous. If it exists at
   *    two hospitals we return the same generic failure as a wrong password
   *    rather than asking "which hospital did you mean" — that question is an
   *    oracle telling an attacker where an address is registered.
   *
   * The practical consequence is that anyone holding accounts at two hospitals
   * must send the slug. That is the UI's job (subdomain or a remembered
   * choice), not something to solve by leaking.
   */
  private async findLoginCandidate(dto: LoginDto) {
    const email = dto.email.toLowerCase();

    /*
     * Resolving the account is two steps, and it has to be.
     *
     * `users` is RLS-protected on tenantId, and at login no tenant is set — so
     * a direct query returns nothing and login could never succeed, whatever
     * the password. The database exposes `app_login_lookup`, a SECURITY
     * DEFINER function that crosses that boundary and returns *only*
     * identifiers: no name, no password hash, nothing that would matter if it
     * leaked.
     *
     * The full row is then read inside an ordinary tenant transaction, through
     * the same policies as everything else. The exception is one function
     * returning two integers, not a hole in the isolation.
     */
    const candidates = await this.prisma.unscoped.$queryRaw<
      { user_id: number; tenant_id: number }[]
      // ::text for the same reason the id lookup casts to ::int — the driver's
      // inferred parameter type has to match the function signature exactly.
    >`SELECT user_id, tenant_id FROM app_login_lookup(${email}::text)`;

    let match: { user_id: number; tenant_id: number } | undefined;

    if (dto.hospital) {
      // `tenants` carries no policy — it is the directory the policies key on —
      // so this lookup needs no special treatment.
      const tenant = await this.prisma.unscoped.tenant.findUnique({
        where: { slug: dto.hospital.toLowerCase() },
        select: { id: true, isActive: true },
      });
      if (!tenant || !tenant.isActive) return null;
      match = candidates.find((c) => c.tenant_id === tenant.id);
    } else {
      // Exactly one, or nothing. Asking "which hospital did you mean" would
      // tell an attacker where an address is registered.
      match = candidates.length === 1 ? candidates[0] : undefined;
    }

    if (!match) return null;
    const { user_id, tenant_id } = match;

    return this.prisma.forTenant(tenant_id, () =>
      this.prisma.user.findUnique({
        where: { id: user_id },
        include: SESSION_USER_INCLUDE,
      }),
    );
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.findLoginCandidate(dto);

    // Every failure below returns the same message. Distinguishing "no such
    // user" from "wrong password" hands an attacker a way to enumerate which
    // staff emails are real.
    const invalid = () => new UnauthorizedException('Invalid email or password');

    if (!user) {
      // Spend roughly the same time as a real verification would, so response
      // timing does not reveal whether the account exists.
      await verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$1FDJLLhTZaXLcHnDLZOnJDBFH0eB4h5tDbTNXvXhWLg',
        dto.password,
      ).catch(() => false);
      throw invalid();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'This account is temporarily locked. Try again shortly.',
      );
    }

    if (!user.isActive) {
      throw new UnauthorizedException('This account is not active.');
    }

    const ok = await verify(user.passwordHash, dto.password).catch(() => false);

    if (!ok) {
      const attempts = user.failedLoginAttempts + 1;
      const lock = attempts >= MAX_FAILED_ATTEMPTS;
      // Wrapped in forTenant like every other write to a tenant table. Login
      // runs before TenantInterceptor has opened one, so without this the row
      // is invisible to the UPDATE and the lockout counter silently never
      // advances — the brute-force control would be decorative.
      await this.prisma.forTenant(user.tenantId, () =>
        this.prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: lock ? 0 : attempts,
            lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
          },
        }),
      );
      if (lock) this.logger.warn(`Account locked after ${MAX_FAILED_ATTEMPTS} failures: userId=${user.id}`);
      throw invalid();
    }

    await this.prisma.forTenant(user.tenantId, () =>
      this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
      }),
    );

    const [accessToken, refreshToken] = await Promise.all([
      this.tokens.issueAccessToken(user),
      this.tokens.issueRefreshToken(user.id),
    ]);

    return {
      accessToken,
      refreshToken,
      // Identical to what /auth/me returns. Built here by hand once, and the
      // two drifted the first time a field was added.
      user: toSessionUser(user),
    };
  }

  /**
   * Change which role this session is acting as.
   *
   * Issues a NEW access token carrying the requested role. The old one keeps
   * working until it expires — it is a signed bearer token and cannot be
   * recalled — which is acceptable precisely because switching only ever moves
   * between roles the user already holds. Nothing is escalated; the ceiling is
   * the same either way.
   *
   * Refused if the role is not assigned. That check is here and not only in the
   * UI because the token claim is client-visible and the endpoint is the
   * boundary.
   */
  async switchRole(actor: AuthUser, role: UserRole): Promise<{ accessToken: string; user: AuthUser }> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.userId },
      include: SESSION_USER_INCLUDE,
    });

    if (!user || !user.isActive) throw new UnauthorizedException('Session is no longer valid');

    if (!canActAs(role, user.roleAssignments ?? [], user.role)) {
      // Deliberately explicit rather than a generic 403: the person is
      // authenticated and this is a UI-visible list, so naming the problem
      // helps them and tells an attacker nothing they could not already see.
      throw new ForbiddenException(`You do not hold the ${role} role`);
    }

    const accessToken = await this.tokens.issueAccessToken(user, role);
    return { accessToken, user: toSessionUser(user, role) };
  }

  async refresh(raw: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { userId, familyId } = await this.tokens.consumeRefreshToken(raw);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { doctorProfile: { select: { id: true } } },
    });

    // Deactivating a user must end their session now, not when the refresh
    // token happens to expire.
    if (!user || !user.isActive) {
      await this.tokens.revokeFamily(familyId);
      throw new UnauthorizedException('Session is no longer valid');
    }

    const [accessToken, refreshToken] = await Promise.all([
      this.tokens.issueAccessToken(user),
      this.tokens.issueRefreshToken(user.id, familyId),
    ]);

    return { accessToken, refreshToken };
  }

  async logout(raw?: string): Promise<void> {
    if (raw) await this.tokens.revokeToken(raw);
  }
}
