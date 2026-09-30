#!/usr/bin/env node
/**
 * Reset a hospital user's password from the machine, when nobody inside the
 * hospital can do it for them.
 *
 *   npm run password:reset -- you@example.com
 *   npm run password:reset -- you@example.com st-marys
 *
 * WHY THIS EXISTS
 * ---------------
 * An administrator resets any member of staff from Admin → Users, and that has
 * always worked. What had no route at all is the case underneath it: the
 * hospital's *only* administrator forgetting their own password. Nobody in the
 * building can reset them, `POST /users/:id/reset-password` is `@Roles(ADMIN)`
 * so they cannot reset themselves, and break-glass deliberately buys the vendor
 * aggregates and configuration rather than the ability to write to `users`.
 * The hospital was locked out of the product permanently, and the only exit was
 * a database console — which is the shape this project keeps reopening.
 *
 * `POST /platform/tenants/:id/users/:userId/reset-password` is now the answer
 * for a customer, and self-service reset is the answer for somebody with a
 * working mailbox. This stays as the floor under both: it needs no mail
 * transport, no vendor account and no working API, so it is what recovers a
 * deployment where one of those is the thing that is broken. Same reasoning as
 * `create-platform-user.js`, which is the equivalent for vendor staff — and
 * which is still the right tool for those, since `platform_users` is not
 * reachable from here.
 *
 * WHY IT SETS A TEMPORARY PASSWORD RATHER THAN ONE YOU CHOOSE
 * ----------------------------------------------------------
 * The strength rules live in `account-rules.ts` and are enforced by the API on
 * the way in. A second copy of them here would be a second thing to keep in
 * step, and it would be the copy nobody re-reads. So this mints a temporary
 * password and sets `mustChangePassword`, which hands the account straight to
 * the password gate both clients already mount above everything else — the same
 * path a newly created account takes. Nothing new to get wrong.
 *
 * WHY `pg` RATHER THAN THE PRISMA CLIENT
 * --------------------------------------
 * A recovery tool must not depend on the generated client being in step with
 * the schema. `prisma generate` and `migrate deploy` are two commands and the
 * gap between them has produced three incident reports here already; a script
 * whose entire purpose is getting back into a database that is in a bad state
 * should not be the fourth. Text, a connection, no engine. Same argument as
 * `scripts/audit-replay.js`.
 *
 * WHY THE ADMIN CONNECTION, AND WHY IT STILL SETS A TENANT
 * -------------------------------------------------------
 * `DATABASE_URL` is `hms_app`, which has no business rewriting credentials.
 * But `users` carries FORCE row-level security, so connecting as the owner is
 * not on its own enough to see a row: scope has to be established, exactly as
 * `PrismaService.forTenant` does per request. This sets `app.tenant_id` around
 * each read and the write. It is the one place a plain `set_config(..., false)`
 * is correct rather than `SET LOCAL` — there is one connection, it is this
 * script's own, and nothing else will ever inherit it.
 */
const { existsSync, readFileSync } = require('node:fs');
const { randomInt } = require('node:crypto');
const { resolve } = require('node:path');
const { Client } = require('pg');

const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const url = process.env.DATABASE_URL_ADMIN;
if (!url) {
  console.error(
    '\nDATABASE_URL_ADMIN is not set.\n' +
      'It is the owner connection. DATABASE_URL is the application role, which\n' +
      'is subject to RLS and has no business rewriting credentials.\n' +
      'See backend/.env.\n',
  );
  process.exit(1);
}

const [rawEmail, rawSlug] = process.argv.slice(2);
if (!rawEmail) {
  console.error(
    '\nusage: npm run password:reset -- <email> [hospital-code]\n\n' +
      '  The hospital code is only needed when one address is registered at more\n' +
      '  than one hospital. This will tell you if it is.\n\n' +
      '  For a vendor console account use:  npm run platform:user\n',
  );
  process.exit(1);
}

const email = rawEmail.trim().toLowerCase();
const slug = rawSlug ? rawSlug.trim().toLowerCase() : null;

/**
 * A temporary password, in the shape `aB3d-Ef7h-Jk9m`.
 *
 * The alphabet excludes I, l, O, 0, 1 and S for the reason the accession check
 * character does: this gets read down a telephone or copied off a screen, and a
 * character somebody has to disambiguate is one they will get wrong.
 *
 * This deliberately mirrors `generateTemporaryPassword` in `account-rules.ts`
 * rather than importing it — that file is TypeScript and recovery must not need
 * a build. Nothing pins the two together and nothing should: the format is a
 * courtesy, and the only property that has to hold is that this one is random,
 * which `randomInt` gives regardless of what the other file says.
 */
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRTUVWXYZabcdefghjkmnpqrtuvwxyz23456789';
  const block = () =>
    Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${block()}-${block()}-${block()}`;
}

const parsed = new URL(url);
const client = new Client({
  host: parsed.hostname,
  port: Number(parsed.port || 5432),
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database: parsed.pathname.replace(/^\//, ''),
});

/** Enter (or leave, with null) a hospital's scope on this connection. */
async function scope(tenantId) {
  await client.query(`select set_config('app.tenant_id', $1, false)`, [
    tenantId === null ? '' : String(tenantId),
  ]);
}

(async () => {
  /*
   * Load argon2 before touching the database, and say something useful if it
   * will not load. Its native binding has failed to load in this repo before —
   * it is why `access-matrix.spec.ts` sat unrunnable for a phase — and finding
   * that out *after* printing "resetting…" would read as a database problem.
   */
  let hash;
  try {
    ({ hash } = require('@node-rs/argon2'));
  } catch (err) {
    console.error(
      `\nCould not load @node-rs/argon2: ${err.message}\n\n` +
        '  It is a native module. Try:  npm install\n' +
        '  The API cannot verify a password without it either, so this is worth\n' +
        '  fixing before going further.\n',
    );
    process.exit(1);
  }

  await client.connect();

  try {
    /*
     * `tenants` carries no policy — it is a global model — so this reads
     * without scope. Inactive ones are included deliberately: a suspended
     * hospital is exactly one somebody may need to get into to fix why.
     */
    const { rows: tenants } = await client.query(
      slug
        ? `select id, slug, name, "isActive" from tenants where lower(slug) = $1`
        : `select id, slug, name, "isActive" from tenants order by id`,
      slug ? [slug] : [],
    );

    if (tenants.length === 0) {
      console.error(
        slug
          ? `\nNo hospital has the code "${slug}".\n` +
            '  Run without a code to see which hospitals hold this address.\n'
          : '\nThis database holds no hospitals yet.\n',
      );
      process.exitCode = 1;
      return;
    }

    /*
     * One read per hospital, in its own scope. A single unscoped read would be
     * the faster thing to write and would return nothing under FORCE RLS —
     * silently, which is the failure mode this whole design is built to avoid.
     */
    const found = [];
    /*
     * Every address the scan could actually see, kept so a miss can say what it
     * looked at.
     *
     * "No account with that address" and "the scoped read returned nothing at
     * all" render identically without this, and they are opposite problems: one
     * is a typo, the other is RLS, a permission, or the wrong database. Getting
     * the more misleading of the two is how somebody spends an evening checking
     * spelling while the policy is what is refusing them. Same shape as an
     * empty table and an unbuilt feature looking alike.
     */
    const seen = [];
    for (const t of tenants) {
      await scope(t.id);
      const { rows } = await client.query(
        `select id, email, "fullName", role, "isActive"
           from users
          order by id`,
      );
      for (const u of rows) {
        seen.push({ email: u.email, tenant: t });
        if (u.email.toLowerCase() === email) found.push({ ...u, tenant: t });
      }
    }
    await scope(null);

    if (found.length === 0) {
      console.error(`\nNo account with the address ${email}.\n`);

      if (seen.length === 0) {
        /*
         * The important case, and the one that used to be invisible. The scan
         * read `users` inside every hospital's scope and got nothing anywhere —
         * which is not a statement about this address at all. Either the
         * database has no staff accounts, or something is refusing the read.
         */
        console.error(
          `  The scan looked inside ${tenants.length} hospital${tenants.length === 1 ? '' : 's'} and found NO staff accounts at all,\n` +
            '  which is a different problem from a wrong address. One of:\n\n' +
            '    - This database genuinely has no users yet. Was it seeded, or was a\n' +
            '      hospital provisioned through the platform console?\n' +
            "    - The owner connection cannot read `users`. Check DATABASE_URL_ADMIN\n" +
            '      points at the right database — the same one the API uses.\n' +
            '    - RLS is refusing the read. `npm run db:rls` proves isolation and login\n' +
            '      still work; run it and read what it reports.\n',
        );
      } else {
        /*
         * There *are* accounts and this is not one of them, so the answer is a
         * list rather than advice about spelling. Safe to print: whoever is
         * running this holds the owner credentials for the database, so there
         * is nothing here they could not already select.
         */
        const CAP = 25;
        console.error(`  ${seen.length} account${seen.length === 1 ? '' : 's'} exist here:\n`);
        for (const u of seen.slice(0, CAP)) {
          console.error(`    ${u.email.padEnd(34)} ${u.tenant.slug}`);
        }
        if (seen.length > CAP) console.error(`    … and ${seen.length - CAP} more`);
        console.error('');
      }

      console.error(
        '  Addresses are unique per hospital, not globally.\n' +
          '  A vendor console account is not in this table — use npm run platform:users.\n',
      );
      process.exitCode = 1;
      return;
    }

    /*
     * Refuse to guess between two hospitals, exactly as login does — but unlike
     * login, say which they are. The refusal at sign-in is there because naming
     * them would tell an attacker where an address is registered; whoever is
     * running this already holds the owner credentials for the database, so
     * there is nothing left to protect and a bare refusal would only be
     * unhelpful.
     */
    if (found.length > 1) {
      console.error(`\n${email} has an account at ${found.length} hospitals:\n`);
      for (const u of found) {
        console.error(`    ${u.tenant.slug.padEnd(24)}  ${u.tenant.name}`);
      }
      console.error('\n  Say which one:\n' + `    npm run password:reset -- ${email} <hospital-code>\n`);
      process.exitCode = 1;
      return;
    }

    const user = found[0];
    const password = temporaryPassword();
    const passwordHash = await hash(password);

    await scope(user.tenant.id);
    await client.query('begin');
    try {
      await client.query(
        `update users
            set "passwordHash" = $1,
                "mustChangePassword" = true,
                "failedLoginAttempts" = 0,
                "lockedUntil" = null,
                "updatedAt" = now()
          where id = $2`,
        [passwordHash, user.id],
      );

      /*
       * Every existing session goes, and this is not tidiness. A password is
       * reset because somebody may have lost control of the account; leaving a
       * live refresh token behind means the reset changed the lock and left a
       * key in the door. `UsersService.resetPassword` revokes for the same
       * reason. `refresh_tokens` carries no tenantId and no policy, so scope
       * does not affect it — it is keyed on the user.
       */
      const { rowCount: revoked } = await client.query(
        `update refresh_tokens set "revokedAt" = now()
          where "userId" = $1 and "revokedAt" is null`,
        [user.id],
      );
      await client.query('commit');

      console.log(`\n  ${user.email} — ${user.fullName} (${user.role})`);
      console.log(`  at ${user.tenant.name}`);
      console.log(`\n  Temporary password:  ${password}\n`);
      console.log('  Sign in with it and you will be asked to choose a new one');
      console.log('  before anything else loads.');
      if (found.length > 1 || tenants.length > 1) {
        console.log(`\n  Hospital code, if sign-in asks for one:  ${user.tenant.slug}`);
      }
      if (!user.isActive) {
        // Deliberately not reactivated. Deactivating somebody is a decision an
        // administrator made, and a password reset is not the place to quietly
        // undo it — the person running this would have no reason to know it had
        // happened.
        console.log('\n  Note: this account is deactivated and cannot sign in.');
        console.log('  An administrator has to reactivate it first.');
      }
      if (!user.tenant.isActive) {
        console.log('\n  Note: this hospital is marked inactive, so login will refuse.');
      }
      if (revoked > 0) {
        console.log(`\n  ${revoked} existing session${revoked === 1 ? '' : 's'} signed out.`);
      }
      console.log('');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  } catch (err) {
    console.error(`\nFailed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
