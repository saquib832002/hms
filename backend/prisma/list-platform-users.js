#!/usr/bin/env node
/**
 * Who can sign in to the vendor console.
 *
 *   npm run platform:users
 *
 * WHY THIS EXISTS
 * ---------------
 * `create-platform-user.js` upserts, so it both creates and resets — and there
 * was no way to find out **which addresses already exist**. Somebody coming
 * back to a deployment after a month either remembered the address or guessed,
 * and guessing wrong silently creates a *second* account rather than resetting
 * the first. One more capability with no route in, in the same family as the
 * eight already recorded in CLAUDE.md.
 *
 * WHY IT IS A SCRIPT AND NOT A CONSOLE SCREEN
 * -------------------------------------------
 * A screen listing every vendor account would need a route on the platform API
 * that enumerates the accounts able to open a break-glass grant against any
 * hospital. That is a list worth protecting, and the protection would be "you
 * are already signed in as one of them" — no help at all to the person who
 * cannot sign in, which is the only person asking. Database access is the right
 * bar, and it is the same bar `create-platform-user.js` sets.
 *
 * WHY NO HASHES
 * -------------
 * `passwordHash` is deliberately not selected. There is no use for it here and
 * every reason not to put one on a terminal that scrolls back.
 *
 * WHY `platform_users` IS VISIBLE TO THIS AT ALL
 * ----------------------------------------------
 * It carries the *inverted* RLS policy — `USING (app_current_tenant() IS NULL)`
 * — so it is readable exactly when no hospital is in scope. A fresh connection
 * has none set, which is why an ordinary psql or pgAdmin session sees these
 * rows and an authenticated hospital request never can. That is the opposite
 * of every other table here and it is the point, not an oversight.
 */
const { existsSync, readFileSync } = require('node:fs');
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
      'It is the owner connection. See backend/.env.\n',
  );
  process.exit(1);
}

const parsed = new URL(url);
const client = new Client({
  host: parsed.hostname,
  port: Number(parsed.port || 5432),
  user: decodeURIComponent(parsed.username),
  password: decodeURIComponent(parsed.password),
  database: parsed.pathname.replace(/^\//, ''),
});

(async () => {
  await client.connect();
  try {
    const { rows } = await client.query(
      `select id, email, "fullName", "isActive", "createdAt"
         from platform_users
        order by id`,
    );

    if (rows.length === 0) {
      console.log(
        '\n  No vendor console accounts exist yet.\n\n' +
          '  Create one:\n' +
          '    set PLATFORM_PASSWORD=choose-something-long\n' +
          '    npm run platform:user -- you@yourcompany.com "Your Name"\n',
      );
      return;
    }

    console.log(`\n  ${rows.length} vendor console account${rows.length === 1 ? '' : 's'}:\n`);
    for (const u of rows) {
      const state = u.isActive ? '' : '   (deactivated)';
      console.log(`    ${u.email.padEnd(34)} ${u.fullName}${state}`);
    }
    console.log(
      '\n  Sign in at /platform on the web app.\n' +
        '  Forgotten the password? There is no reset link for these by design —\n' +
        '  re-run npm run platform:user with the same address; it upserts.\n',
    );
  } catch (err) {
    /*
     * The likely failure is that `platform_users` does not exist, which means
     * the migration has not been applied — and the error Postgres gives for
     * that names a relation, which sends whoever reads it looking at the wrong
     * thing. Same reasoning as the pending-migration warning at boot.
     */
    console.error(
      `\nFailed: ${err.message}\n\n` +
        '  If that says the relation does not exist, apply the migrations first:\n' +
        '    npm run db:migrate\n',
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
