import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * One request, one database connection.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `TenantInterceptor` wraps every authenticated request in an interactive
 * transaction. A Prisma interactive transaction holds one pool connection for
 * its entire lifetime — so a request that also reads through `unscoped` asks
 * the same pool for a *second* connection while still holding the first.
 *
 * With Prisma's default pool (about 2×CPUs + 1) that is a self-deadlock rather
 * than slowness. Once that many requests are in flight, every one of them
 * holds a connection and waits for another that nobody can release. Requests
 * stall until the pool timeout, the 15-second auto-refresh on the ward board
 * and the queues fires them again, and the page simply never loads.
 *
 * Reported as "switching to the nurse role takes more than two minutes". It
 * presents as a slow page and is not one: no query is slow, and no test that
 * runs one request at a time can see it. That is the whole reason this file is
 * a static check rather than a unit test.
 *
 * WHERE `unscoped` IS STILL CORRECT
 * ---------------------------------
 * Code that runs *outside* a request transaction, where there is no first
 * connection to conflict with:
 *
 *   - `auth` — login and refresh happen before the interceptor has a user
 *   - `platform` — vendor routes deliberately set no tenant scope
 *   - `signup` — public, unauthenticated
 *   - `provisioning` — creates the tenant a scope would key on
 *
 * And `PrismaService.forTenant`, which opens the transaction in the first
 * place.
 */

const SRC = path.resolve(__dirname, '..');

/** Files that may legitimately take a connection outside a request scope. */
const ALLOWED = [
  'auth/',
  'platform/',
  'signup/',
  'prisma/',
  // The cross-tenant referral write opens a second, deliberate transaction
  // against another hospital's scope. It is one write on one uncommon path,
  // not a per-request cost.
  'prescriptions/prescriptions.service.ts',
  /*
   * The audit writer drains a background queue, not the request.
   *
   * `record()` is deliberately non-blocking — a nurse must be able to save
   * vitals while the audit table is unwell — so the insert happens on a single
   * drain loop after the request's transaction has closed. It also has to be
   * unscoped: an anonymous failed login belongs to no hospital, and that row is
   * one of the most useful in the table.
   */
  'audit/audit.service.ts',

  /*
   * Push notifications are fire-and-forget for the same reason audit writes
   * are — a push service having a bad day must not fail a check-in — so the
   * send runs after the response has gone and after the request's transaction
   * has committed.
   *
   * It shipped without this and produced *"Transaction already closed: A query
   * cannot be executed on a committed transaction"* on the first real
   * check-in. `device` is a global model, and global models are routed through
   * the request's transaction deliberately, which is correct for everything
   * that runs inside a request and exactly wrong for anything that outlives
   * one.
   *
   * Safe as well as necessary: `devices` carries no `tenantId` and no policy,
   * and the lookup is keyed on `userId`, so the unscoped client returns the
   * same rows the scoped one would.
   */
  'notifications/notifications.service.ts',
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('a request does not take a second connection', () => {
  const files = walk(SRC);

  it('finds the source', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('never leaves a fire-and-forget call on the request transaction', () => {
    /*
     * THE BUG THIS EXISTS FOR
     * -----------------------
     *     Push notification could not be delivered (PATIENT_CHECKED_IN):
     *     Transaction already closed: A query cannot be executed on a
     *     committed transaction.
     *
     * `NotificationsService.notifyDoctor` calls `void this.send(...)` so a push
     * service having a bad day cannot fail a check-in. That means `send` runs
     * *after* the response has gone and after `TenantInterceptor`'s transaction
     * has committed — while `this.prisma.device` was still proxied onto that
     * transaction.
     *
     * It is the mirror image of the check below. That one catches a second
     * connection opened *during* a request; this one catches a proxied query
     * executed *after* one. Both come from the same design — one request, one
     * connection — and neither is visible to a test that runs one request at a
     * time, because the failure needs the transaction to have closed.
     *
     * The rule: a method reached by `void this.x(...)` outlives the request, so
     * every database call in it must go through `unscoped`.
     */
    const offenders: string[] = [];

    for (const file of files) {
      const src = strip(readFileSync(file, 'utf8'));

      for (const call of src.matchAll(/\bvoid this\.(\w+)\(/g)) {
        const name = call[1];

        /*
         * The method's *declaration*, anchored to the start of a member line.
         *
         * Written first as a bare `name\\s*\\(`, which matched `void this.send(`
         * — the call site — so the slice below contained the one-line wrapper
         * and no database call, and the test passed with the real bug in
         * place. Verified by reintroducing it; a guard nobody has watched fail
         * is a guard that asserts nothing, which this repo has learned twice.
         */
        const decl = new RegExp(`\\n  (?:private |public )?(?:async )?${name}\\s*\\(`);
        const at = src.search(decl);
        if (at < 0) continue;

        const rest = src.slice(at + 1);
        const end = rest.slice(1).search(/\n  (?:private |public )?(?:async )?\w+\s*\(/);
        const body = end === -1 ? rest : rest.slice(0, end);

        /*
         * `this.prisma.<model>` goes through the proxy; `this.prisma.unscoped`
         * and a local `this.db` getter that returns it do not. A helper getter
         * is allowed because that is how a service with several deferred calls
         * says this once rather than at every call site.
         */
        if (/this\.prisma\.(?!unscoped)\w/.test(body)) {
          offenders.push(`${path.relative(SRC, file)} → ${name}()`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps `unscoped` off request-scoped paths', () => {
    /*
     * If this fails on code you have just written, the question is: does this
     * run inside a request? If yes, drop `unscoped` — global models like
     * `tenants` carry no RLS policy, so the scoped client returns exactly the
     * same rows through the connection the request already holds.
     *
     * If it genuinely runs outside a request, add the file to ALLOWED with a
     * reason, the way the exemption lists elsewhere in this repo work.
     */
    const offenders = files
      .filter((f) => !ALLOWED.some((a) => f.replace(/\\/g, '/').includes(`/src/${a}`)))
      .filter((f) => strip(readFileSync(f, 'utf8')).includes('.unscoped.'))
      .map((f) => path.relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it('routes global models through the request transaction', () => {
    /*
     * The other half. Scoped models were always routed; global ones fell
     * through to the base client, which is what took the second connection —
     * `tenants` is read for the hospital's timezone on nearly every request.
     */
    const proxy = strip(readFileSync(path.join(SRC, 'prisma', 'prisma.service.ts'), 'utf8'));
    expect(proxy).toMatch(/GLOBAL_MODELS\.has\(prop\)/);
  });

  it('still wraps the request in one transaction', () => {
    // The other side of the arrangement. Without this the RLS scope would not
    // be set at all, which is a correctness problem rather than a speed one.
    const interceptor = strip(
      readFileSync(path.join(SRC, 'common', 'interceptors', 'tenant.interceptor.ts'), 'utf8'),
    );
    expect(interceptor).toContain('forTenant');
  });
});
