#!/usr/bin/env node
/**
 * Says whether the two database URLs in `.env` are usable, and if not, why.
 *
 *   npm run db:env
 *
 * WHY THIS EXISTS
 * ---------------
 * Two roles connect to this database and the split is the whole of tenant
 * isolation (see docs/adr-001-multi-tenancy.md):
 *
 *   DATABASE_URL        hms_app   — the API. Non-superuser, so RLS applies.
 *   DATABASE_URL_ADMIN  hms_owner — migrations and the seed.
 *
 * Every way of getting this wrong surfaces as the same message:
 *
 *   P1000: Authentication failed … for `hms_app`
 *
 * which names a password and is, about half the time, something else. This
 * separates the causes, because the fix differs for each and guessing between
 * them is how a deployment loses an hour:
 *
 *   - the wrong ROLE, because a bare `npx prisma` call reads DATABASE_URL and
 *     hands the application role a migration to run;
 *   - a DUPLICATE definition, which is the nastiest of these — dotenv keeps the
 *     FIRST assignment of a key and systemd's EnvironmentFile keeps the LAST,
 *     so the running API and every script in this directory can disagree about
 *     the password while both read the same file;
 *   - a password containing a URL delimiter, which silently reparses the
 *     connection string into a different user, host or database;
 *   - a genuinely wrong password.
 *
 * It prints the password's LENGTH and never the password. A diagnostic that
 * echoes a credential is one whose output cannot be pasted into a bug report,
 * which is the only reason anybody runs it.
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Client } = require('pg');

const KEYS = ['DATABASE_URL', 'DATABASE_URL_ADMIN'];
const EXPECTED = { DATABASE_URL: 'hms_app', DATABASE_URL_ADMIN: 'hms_owner' };

/** Characters that end a component of a URL, so a password holding one splits it. */
const DELIMITERS = [...":/?#[]@"];

const envPath = resolve(__dirname, '../.env');
if (!existsSync(envPath)) {
  console.error(`\nNot found: ${envPath}\nRun this from backend/.\n`);
  process.exit(1);
}
const lines = readFileSync(envPath, 'utf8').split('\n');

/** Every assignment of `key`, in file order, so duplicates are visible. */
function definitions(key) {
  return lines
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => new RegExp(`^\\s*${key}\\s*=`).test(line))
    .map(([n, line]) => {
      const rhs = line.replace(new RegExp(`^\\s*${key}\\s*=\\s*`), '').trim();
      return { line: n, quoted: /^["']/.test(rhs), value: rhs.replace(/^["']|["']$/g, '') };
    });
}

let problems = 0;
const report = (msg) => {
  problems += 1;
  console.log(`      ⚠ ${msg}`);
};

(async () => {
  for (const key of KEYS) {
    const defs = definitions(key);
    console.log(`\n${key}`);

    if (!defs.length) {
      report('not set at all');
      continue;
    }

    if (defs.length > 1) {
      report(
        `defined ${defs.length} times, on lines ${defs.map((d) => d.line).join(', ')}.\n` +
          `        dotenv uses the FIRST; systemd EnvironmentFile uses the LAST.\n` +
          `        So the running API and these scripts can disagree. Delete all but one.`,
      );
    }

    for (const def of defs) {
      let url;
      try {
        url = new URL(def.value);
      } catch (err) {
        console.log(`   line ${def.line}: unparseable — ${err.message}`);
        problems += 1;
        continue;
      }

      const password = decodeURIComponent(url.password || '');
      const db = url.pathname.replace(/^\//, '');
      console.log(
        `   line ${def.line}: user=${url.username} host=${url.hostname}:${url.port || 5432} db=${db}`,
      );
      console.log(`      password: ${password.length} characters`);

      if (EXPECTED[key] && url.username !== EXPECTED[key]) {
        report(`expected user ${EXPECTED[key]}, found ${url.username}`);
      }
      const hit = DELIMITERS.filter((c) => password.includes(c));
      if (hit.length) {
        report(
          `the password contains ${JSON.stringify(hit.join(''))}, which must be\n` +
            `        percent-encoded in a URL (@ → %40, : → %3A, / → %2F, # → %23).\n` +
            `        Unencoded, the string reparses into a different user or host.`,
        );
      }
      if (!def.quoted && /[\s#]/.test(def.value)) {
        report('unquoted value contains whitespace or #. Wrap the whole value in quotes.');
      }
      if (password === 'admin') {
        report(
          url.username === 'hms_app'
            ? 'this is the development default that npm run db:rls creates hms_app\n' +
                '        with when the role does not already exist. It should not be in use\n' +
                '        on a production box.'
            : `"admin" is a development default and should not be ${url.username}'s password\n` +
                '        on a production box.',
        );
      }

      // Only the effective definition is worth connecting with: dotenv would
      // use the first, and that is what every other script here does.
      if (def !== defs[0]) continue;

      const client = new Client({ connectionString: def.value });
      try {
        await client.connect();
        const { rows } = await client.query('select current_user u, current_database() d');
        console.log(`      connects: OK → ${rows[0].u} @ ${rows[0].d}`);
        await client.end();
      } catch (err) {
        console.log(`      connects: FAILED → ${err.message}`);
        problems += 1;
        if (/password authentication failed/.test(err.message)) {
          console.log(
            `        The role exists and the password is wrong. Reset it as the\n` +
              `        admin user, then put the same value here:\n` +
              `          sudo -u postgres psql -c "ALTER ROLE ${url.username} WITH PASSWORD '…'"`,
          );
        } else if (/role .* does not exist/.test(err.message)) {
          console.log(
            `        The role has never been created. npm run db:rls creates hms_app;\n` +
              `        hms_owner is created by hand — see DEPLOY.md.`,
          );
        } else if (/database .* does not exist/.test(err.message)) {
          console.log(`        The database name in the URL is wrong, or it was dropped.`);
        }
      }
    }
  }

  console.log(
    problems === 0
      ? '\nBoth URLs are usable.\n'
      : `\n${problems} problem${problems === 1 ? '' : 's'} above. Nothing that touches the database will work until they are fixed.\n`,
  );
  process.exit(problems === 0 ? 0 : 1);
})();
