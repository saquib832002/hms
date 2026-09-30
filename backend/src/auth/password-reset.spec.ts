import { readFileSync } from 'fs';
import path from 'path';
import { grantCooldownMinutes } from '../platform/break-glass';

/**
 * Static guards on self-service password reset.
 *
 * Why static rather than behavioural: every property below is a property of the
 * *code*, and each one is the sort that survives a green test suite while
 * quietly ceasing to be true. The behaviour these describe has no visible
 * symptom when it breaks — an endpoint that starts answering differently for a
 * known address looks completely normal, and the person it harms never sees the
 * screen.
 *
 * The limit is the same one the rest of this directory has: it measures the
 * source, not a running system. Three of the worst bugs in this project were
 * invisible to exactly this kind of check. It is still worth far more than the
 * nothing that would otherwise be here.
 */
const SRC = path.resolve(__dirname, '..');

/** Comments first, always. `nav-modules.spec.ts` learned this the hard way. */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/** Just the body of one method, so a sibling's correctness cannot stand in. */
function methodBody(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.slice(1).search(/\n  (?:private |public )?(?:async )?\w+\s*\(/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('password reset', () => {
  const service = strip(read('auth/password-reset.service.ts'));

  it('never stores the raw token', () => {
    /*
     * The token is a bearer credential for a hospital account. Storing it in
     * the clear would make a database backup a set of working logins — and the
     * mistake is invisible in review, because `data: { token: raw }` reads
     * exactly like the correct line.
     */
    expect(service).toMatch(/tokenHash:\s*sha256\(/);
    expect(service).not.toMatch(/tokenHash:\s*raw\b/);
    expect(service).not.toMatch(/\btoken:\s*raw\b/);
  });

  it('answers identically whether or not the address has an account', () => {
    /*
     * The whole enumeration defence. `request()` has four early exits — no mail
     * transport, no candidate, no readable user, nothing sent — and every one
     * of them must return the *same object*.
     *
     * Asserted as "the only thing this method returns is `same`", rather than
     * by comparing strings, because the failure to catch is somebody adding a
     * fifth branch with a friendlier message. A second literal in here is the
     * bug.
     */
    const body = methodBody(service, 'request');
    const returns = [...body.matchAll(/\breturn\s+([^;]+);/g)].map((m) => m[1].trim());
    expect(returns.length).toBeGreaterThan(1);
    for (const r of returns) expect(r).toBe('same');
  });

  it('checks the password before spending the link', () => {
    /*
     * Ordering, and it is the difference between a flow people use and one they
     * give up on. Getting the strength rules wrong is the commonest thing that
     * happens on that form; burning the token over an eleven-character password
     * sends somebody back to the sign-in screen to start again.
     */
    const body = methodBody(service, 'consume');
    const strength = body.indexOf('checkPasswordStrength');
    const spend = body.indexOf('consumedAt: new Date()');
    expect(strength).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(-1);
    expect(strength).toBeLessThan(spend);
  });

  it('kills every other outstanding link for that user, not just the one used', () => {
    /*
     * Somebody who clicked "forgot password" three times has three live tokens
     * in their mailbox. Consuming only the presented one leaves two working
     * after the password has changed — so anybody who obtained an earlier email
     * takes the account straight back, past a reset performed because something
     * was already wrong.
     *
     * `updateMany` keyed on the user, never `update` keyed on the token id.
     */
    const body = methodBody(service, 'consume');
    expect(body).toMatch(/passwordResetToken\.updateMany\(/);
    expect(body).toMatch(/userId:\s*token\.userId,\s*consumedAt:\s*null/);
    expect(body).not.toMatch(/passwordResetToken\.update\(\s*\{[\s\S]*?where:\s*\{\s*id:/);
  });

  it('marks tokens consumed rather than deleting them', () => {
    /*
     * A token presented twice is either a double click or a replay, and a
     * deleted row makes both indistinguishable from one that never existed.
     * `RefreshToken` draws the same line with `revokedAt`.
     */
    expect(service).not.toMatch(/passwordResetToken\.delete/);
  });

  it('refuses a consumed, expired or unknown token with one identical message', () => {
    /*
     * Three checks, one `refusal`. Distinguishing them tells somebody holding a
     * guessed token that they were close — the same reason login does not
     * separate "no such account" from "wrong password".
     */
    const body = methodBody(service, 'consume');
    const throws = [...body.matchAll(/\bthrow\s+([^;]+);/g)].map((m) => m[1].trim());
    const distinct = new Set(throws.filter((t) => t !== 'refusal'));
    // The only other throw is the strength failure, which is *about the input
    // the user just typed* and must say what was wrong with it.
    expect([...distinct]).toEqual(['new BadRequestException(weakness)']);
  });

  it('gives a deactivated account no link', () => {
    /*
     * Deactivation is a decision an administrator made. A reset flow that
     * quietly worked around it would let somebody removed from a hospital walk
     * back in through the sign-in screen.
     */
    expect(methodBody(service, 'request')).toMatch(/!user\.isActive/);
  });

  it('builds the link from configuration, never from the request', () => {
    /*
     * A reset URL built from the `Host` header is one an attacker aims at their
     * own server by sending `Host: evil.example` — and the victim clicking it
     * hands over a live token. The header is attacker-controlled input.
     */
    expect(service).toMatch(/get<string>\('webUrl'\)/);
    expect(service).not.toMatch(/req\.(headers|hostname|get\()/);
  });

  it('hashes outside the tenant transaction', () => {
    /*
     * Argon2 is deliberately slow. Doing it inside `forTenant` holds a pool
     * connection for its duration, which is the self-deadlock this project
     * already shipped once and reported as "switching to nurse takes more than
     * two minutes".
     */
    const body = methodBody(service, 'consume');
    expect(body.indexOf('await hash(newPassword)')).toBeLessThan(body.indexOf('forTenant('));
  });
});

describe('a password change anywhere kills outstanding reset links', () => {
  /*
   * Ask for a link, give up, get an administrator to reset you instead — and
   * the emailed link is still live for the rest of its half hour. Whoever
   * obtains that mailbox takes the account back, past a reset performed because
   * something was wrong.
   *
   * Both routes that change a password without a token have to close them.
   */
  const users = strip(read('users/users.service.ts'));

  it.each(['resetPassword', 'changeOwnPassword'])('%s consumes them', (method) => {
    expect(methodBody(users, method)).toMatch(/consumeOutstandingResetLinks\(/);
  });

  it('does so through the proxy, not through unscoped', () => {
    /*
     * Both callers run inside an authenticated request, which already holds a
     * pool connection. `unscoped` there asks the pool for a second one while
     * holding the first — the deadlock, not slowness. `passwordResetToken` is
     * in GLOBAL_MODELS, so the proxy routes it onto the open transaction and
     * returns the same rows, because the table carries no policy.
     */
    const body = methodBody(users, 'consumeOutstandingResetLinks');
    expect(body).toMatch(/this\.prisma\.passwordResetToken\.updateMany/);
    expect(body).not.toMatch(/unscoped/);
  });
});

describe('the vendor path into a locked-out hospital', () => {
  const platform = strip(read('platform/platform.service.ts'));

  it('requires a live grant before doing anything', () => {
    expect(methodBody(platform, 'resetTenantUserPassword')).toMatch(/requireActiveGrant\(/);
  });

  it('refuses anybody who does not hold ADMIN', () => {
    /*
     * Not because resetting a nurse would be more dangerous — it would be less
     * — but because their own administrator can already do it, so a vendor
     * route that could would be a capability with no case behind it. A power
     * with no justification gets used for something else eventually.
     */
    const body = methodBody(platform, 'resetTenantUserPassword');
    expect(body).toMatch(/roleAssignments\.some\(\(r\) => r\.role === UserRole\.ADMIN\)/);
    expect(body).toMatch(/ForbiddenException/);
  });

  it('forces a change, so the vendor copy stops working immediately', () => {
    expect(methodBody(platform, 'resetTenantUserPassword')).toMatch(/mustChangePassword:\s*true/);
  });

  it("writes into the hospital's own log, never as one of their staff", () => {
    /*
     * `actorRole: null` is what keeps a vendor action distinguishable from an
     * administrator's in that hospital's own reports. Inventing one would make
     * the two identical in exactly the record that exists to tell them apart.
     */
    const body = methodBody(platform, 'resetTenantUserPassword');
    expect(body).toMatch(/action:\s*'PLATFORM_TENANT_ADMIN_PASSWORD_RESET'/);
    expect(body).toMatch(/actorRole:\s*null/);
    expect(body).toMatch(/tenantId,/);
  });

  it('names the route it refused, rather than always claiming diagnostics', () => {
    /*
     * `requireActiveGrant` hard-coded the diagnostics GET into its denial row,
     * which was true while diagnostics was its only caller. A denied password
     * reset logged as a denied diagnostics read is worse than no row: the whole
     * value of these is that a hospital can ask what the vendor reached for.
     */
    const body = methodBody(platform, 'requireActiveGrant');
    expect(body).toMatch(/method:\s*context\.method/);
    expect(body).toMatch(/path:\s*context\.path/);
  });
});

describe('the vendor console reset, which the CLI comment said should not exist', () => {
  /*
   * `create-platform-user.js` has said since it was written that there is no
   * "forgot password" for vendor staff and there should not be one, because a
   * reset link emailed to a vendor address is a way into every hospital on the
   * deployment guarded by one mailbox.
   *
   * The product owner asked for it anyway, which is their call. These assert
   * the controls that answer that argument — if any of them is removed, the
   * feature silently becomes the thing the comment warned about.
   */
  const service = strip(read('platform/platform-password-reset.service.ts'));
  const platform = strip(read('platform/platform.service.ts'));

  it('answers identically whether or not the address has a console account', () => {
    const body = methodBody(service, 'request');
    const returns = [...body.matchAll(/\breturn\s+([^;]+);/g)].map((m) => m[1].trim());
    expect(returns.length).toBeGreaterThan(1);
    for (const r of returns) expect(r).toBe('same');
  });

  it('never stores the raw token, and marks it consumed rather than deleting it', () => {
    expect(service).toMatch(/tokenHash:\s*sha256\(/);
    expect(service).not.toMatch(/platformPasswordResetToken\.delete/);
  });

  it('kills every other outstanding link for that account', () => {
    const body = methodBody(service, 'consume');
    expect(body).toMatch(/platformPasswordResetToken\.updateMany\(/);
    expect(body).toMatch(/platformUserId:\s*token\.platformUserId,\s*consumedAt:\s*null/);
  });

  it('stamps passwordResetAt, which is what the cooling-off reads', () => {
    expect(methodBody(service, 'consume')).toMatch(/passwordResetAt:\s*new Date\(\)/);
  });

  it('tells every other console account, on the request and on the completion', () => {
    /*
     * The control that makes a takeover through one mailbox non-silent. Unlike
     * anything built on logs it needs nobody to be looking, which is the only
     * reason it is worth having on a two-person vendor.
     */
    expect(methodBody(service, 'request')).toMatch(/notifyOthers\(/);
    expect(methodBody(service, 'consume')).toMatch(/notifyOthers\(/);
  });

  describe('break-glass waits after a reset', () => {
    /*
     * The one control here that actually interrupts the attack rather than
     * narrowing or reporting it — so it is the one that must not be a string
     * match. The first version of this *was*, asserting that `openGrant`
     * mentioned `passwordResetAt` and `ForbiddenException`, and it **passed
     * with the condition replaced by `if (false)`**. Fourth time in this repo
     * a guard has been verified by reintroducing the fault and found worthless.
     *
     * The decision moved into `grantCooldownMinutes` so these can call it.
     */
    const RESET = new Date('2026-09-29T10:00:00Z');

    it('blocks for the configured window and reports the minutes left', () => {
      expect(grantCooldownMinutes(RESET, 60, new Date('2026-09-29T10:00:00Z'))).toBe(60);
      expect(grantCooldownMinutes(RESET, 60, new Date('2026-09-29T10:30:00Z'))).toBe(30);
      // Ceil: a refusal still in force must not say "0 more minutes".
      expect(grantCooldownMinutes(RESET, 60, new Date('2026-09-29T10:59:30Z'))).toBe(1);
    });

    it('lifts exactly when it should', () => {
      expect(grantCooldownMinutes(RESET, 60, new Date('2026-09-29T11:00:00Z'))).toBe(0);
      expect(grantCooldownMinutes(RESET, 60, new Date('2026-09-29T14:00:00Z'))).toBe(0);
    });

    it('is off for an account that has never used the emailed path', () => {
      /*
       * Null is every account reset with `platform:user`, which already needs
       * the database's owner credentials — there is nothing weaker to
       * compensate for, and an engineer who reset their password at a shell
       * must not be locked out of the reason they did it.
       */
      expect(grantCooldownMinutes(null, 60, new Date())).toBe(0);
      expect(grantCooldownMinutes(undefined, 60, new Date())).toBe(0);
    });

    it('is off when configured to zero, and cannot be turned inside out', () => {
      expect(grantCooldownMinutes(RESET, 0, RESET)).toBe(0);
      // A negative would otherwise put `liftsAt` before the reset and read as
      // "no cooldown" by accident rather than by decision.
      expect(grantCooldownMinutes(RESET, -30, RESET)).toBe(0);
    });

    it('is what openGrant actually consults', () => {
      // Now a worthwhile string check: the behaviour is pinned above, and this
      // only has to establish that the caller reaches it.
      expect(methodBody(platform, 'openGrant')).toMatch(/grantCooldownMinutes\(/);
    });
  });

  it('does not penalise a reset done through the CLI', () => {
    const cli = strip(readFileSync(path.join(SRC, '../prisma/create-platform-user.js'), 'utf8'));
    expect(cli).not.toMatch(/passwordResetAt/);
  });

  it('is reachable at the path the console actually calls', () => {
    /*
     * `@Get('capabilities')` sits on `@Controller('platform/auth')`, so the
     * route is `/platform/auth/capabilities` — and the console was calling
     * `/platform/capabilities`. It 404'd, the catch hid the link, and the
     * result was indistinguishable from "no mail transport is configured".
     * Two opposite causes, one silent missing link, nothing on screen to tell
     * them apart.
     *
     * `endpoint-coverage.spec.ts` cannot see this: it exempts `/platform` as a
     * category, because the console is a different application wearing the
     * same deployment. So the prefix is asserted here instead, for all three
     * unauthenticated console routes rather than only the one that broke —
     * the next person to add a route to that controller will reach for the
     * same wrong prefix.
     */
    const console_ = strip(read('../../web/app/(platform)/platform/page.tsx'));
    for (const route of ['capabilities', 'forgot-password', 'reset-password']) {
      expect(console_).toContain(`/platform/auth/${route}`);
    }
  });

  it('keeps the vendor reset off the hospital `@Public()` list', () => {
    /*
     * These routes are unauthenticated and deliberately carry `@PlatformRoute()`
     * rather than `@Public()`. `access-matrix.spec.ts` asserts the exact set of
     * public routes and its value is that the list stays short enough to read;
     * folding vendor endpoints into it would retire that.
     */
    const controller = strip(read('platform/platform.controller.ts'));
    expect(controller).toMatch(/@Post\('forgot-password'\)/);
    expect(controller).not.toMatch(/@Public\(\)/);
  });
});

describe('unlocking is not resetting', () => {
  const users = strip(read('users/users.service.ts'));

  it('leaves the password and the sessions alone', () => {
    /*
     * The two are different acts and the difference is what the person knows.
     * A reset says "you cannot get in because you do not know the password"; an
     * unlock says "you do know it, and the wrong guesses are in the way". Only
     * the first is a reason to change the credential or end a session.
     *
     * The tempting tidy-up is to make `unlock` call `resetPassword` internally,
     * which would silently reintroduce both costs.
     */
    const body = methodBody(users, 'unlock');
    expect(body).toMatch(/failedLoginAttempts:\s*0/);
    expect(body).toMatch(/lockedUntil:\s*null/);
    expect(body).not.toMatch(/passwordHash/);
    expect(body).not.toMatch(/revokeAllForUser/);
    expect(body).not.toMatch(/mustChangePassword/);
  });
});
