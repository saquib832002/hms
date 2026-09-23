import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';
import { LoginDto } from './dto/login.dto';
import { SESSION_USER_INCLUDE, toSessionUser } from './session-user';
import {
  hasModule,
  MODULE_LABEL,
  roleBlockedBy,
} from '../common/modules/tenant-modules';
import { AuthUser } from '../common/types/auth-user';
import { Prisma, UserRole } from '@prisma/client';
import { canActAs } from '../users/role-assignment';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Why an address did not resolve to exactly one account.
 *
 * **For the log and never for the response.** Every one of these produces the
 * identical `Invalid email or password`, because naming them would tell an
 * attacker whether an address is registered and at how many hospitals — the
 * enumeration oracle the signup form and the partner lookup are also shaped
 * around.
 *
 * They are worth distinguishing anyway, because they are not equally the
 * caller's fault:
 *
 * - `no-such-address` — nothing here. The ordinary case, and usually a typo.
 * - `ambiguous` — the address exists at two or more hospitals and no code was
 *   given. **The person typing has done nothing wrong and cannot guess what to
 *   change**, which is why it was reported as a temporary password not working.
 * - `no-such-hospital` / `not-at-that-hospital` — a code was given and is wrong,
 *   or right and holds no such account.
 * - `row-not-readable` — `app_login_lookup` found the row and the scoped read
 *   did not, which means the function and the policy disagree. Not the caller's
 *   fault in any sense, and the shape that took login down completely once.
 */
type LoginRefusal =
  | 'no-such-address'
  | 'ambiguous'
  | 'no-such-hospital'
  | 'not-at-that-hospital'
  | 'row-not-readable';

/**
 * Exactly what the scoped read returns, derived rather than restated.
 *
 * `SESSION_USER_INCLUDE` is shared so that a new field on the session user is
 * one edit rather than two; writing this shape out by hand would reintroduce
 * the second edit through the back door, and the copy that drifts is always the
 * one nothing points at.
 */
type SessionUserRecord = Prisma.UserGetPayload<{ include: typeof SESSION_USER_INCLUDE }>;

type LoginCandidate =
  | { user: SessionUserRecord; reason: null; hospitals?: undefined }
  | { user: null; reason: LoginRefusal; hospitals?: number };

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
   * must send the slug. **That was described as "the UI's job" and no UI did
   * it** — `signIn(email, password)` on both clients, so `hospital` was a field
   * the DTO accepted, this comment relied on, and nothing could fill. Reported
   * as *"newly created tenant's password is not working"*: the password was
   * fine and the account was never found, because the address already existed
   * at another hospital. Sixth instance of a setting with no route in, and the
   * quietest yet — the other five produced a 404 or a refusal that read as
   * broken, and this one produces *Invalid email or password*, which reads as
   * correct.
   *
   * WHY THE REFUSAL STILL DOES NOT SAY WHICH
   * ----------------------------------------
   * It returns `reason` for the *log*, never for the response. Telling the
   * client "that address is at two hospitals, pick one" confirms the address is
   * real and registered more than once — the enumeration oracle this method
   * exists to close, and the same concern that shapes the signup form and the
   * partner lookup. So the message is byte-identical for every failure and the
   * server writes down which branch fired, which is what turns the next report
   * like this into one log line.
   */
  private async findLoginCandidate(dto: LoginDto): Promise<LoginCandidate> {
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

    if (candidates.length === 0) return { user: null, reason: 'no-such-address' };

    let match: { user_id: number; tenant_id: number } | undefined;

    if (dto.hospital) {
      // `tenants` carries no policy — it is the directory the policies key on —
      // so this lookup needs no special treatment.
      const tenant = await this.prisma.unscoped.tenant.findUnique({
        where: { slug: dto.hospital.toLowerCase() },
        select: { id: true, isActive: true },
      });
      if (!tenant || !tenant.isActive) return { user: null, reason: 'no-such-hospital' };
      match = candidates.find((c) => c.tenant_id === tenant.id);
      if (!match) return { user: null, reason: 'not-at-that-hospital' };
    } else {
      // Exactly one, or nothing. Asking "which hospital did you mean" would
      // tell an attacker where an address is registered.
      match = candidates.length === 1 ? candidates[0] : undefined;
      if (!match) {
        return { user: null, reason: 'ambiguous', hospitals: candidates.length };
      }
    }

    const { user_id, tenant_id } = match;

    const user = await this.prisma.forTenant(tenant_id, () =>
      this.prisma.user.findUnique({
        where: { id: user_id },
        include: SESSION_USER_INCLUDE,
      }),
    );

    /*
     * The lookup found the row and the scoped read did not.
     *
     * Should be impossible — `app_login_lookup` reads the same table — so it
     * means the policy and the function disagree, which is the failure that
     * took login down completely once before when ownership of the SECURITY
     * DEFINER functions moved. Worth its own reason precisely because it is
     * the one that is not the user's fault at all.
     */
    if (!user) return { user: null, reason: 'row-not-readable' };

    return { user, reason: null };
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const candidate = await this.findLoginCandidate(dto);
    const user = candidate.user;

    // Every failure below returns the same message. Distinguishing "no such
    // user" from "wrong password" hands an attacker a way to enumerate which
    // staff emails are real.
    const invalid = () => new UnauthorizedException('Invalid email or password');

    if (!user) {
      /*
       * The one place the branches are distinguishable, and it is a log line.
       *
       * `Invalid email or password` covers four different situations, and
       * `ambiguous` is the only one where the person typing has done nothing
       * wrong and cannot possibly guess what to change. It was reported as a
       * temporary password not working; the password was never checked.
       *
       * The address is included because `AllExceptionsFilter` already writes it
       * to the audit trail on a failed login — so this reveals nothing new to
       * anybody who can read the server's logs, and without it the line says
       * that *somebody* failed to sign in, which is the part nobody needs.
       */
      this.logger.warn(
        `Login refused (${candidate.reason}) for ${dto.email}` +
          (candidate.reason === 'ambiguous'
            ? `: registered at ${candidate.hospitals} hospitals and no hospital code was given. The client should offer one.`
            : ''),
      );

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

    /*
     * Holding a role is not the same as being able to act as one.
     *
     * A commercial change at the vendor never strips an assignment — that would
     * take a role off a member of staff mid-shift as a side effect of an
     * invoice — so somebody can still *hold* DOCTOR at a hospital whose clinic
     * module has gone. Switching into it would put them on a session with no
     * screens and a 403 behind every one, which is the state `hasAnyScreen`
     * exists to explain rather than a state worth entering deliberately.
     *
     * The assignment stays, and comes back the moment the module does. Both
     * clients narrow the switcher from the same rule; this is the boundary,
     * because the switcher is a list on a page and `POST /auth/switch-role` is
     * one curl away.
     */
    const blocking = roleBlockedBy(role);
    if (blocking && !hasModule(user.tenant.modules, blocking)) {
      throw new ForbiddenException(
        `${MODULE_LABEL[blocking]} is not part of your hospital’s plan, so there is nothing to do as ${role}. Your provider can add it.`,
      );
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
