#!/usr/bin/env node
/**
 * Print the two connection strings for a rehearsal database, derived from the
 * real ones in `.env`.
 *
 *   eval "$(node prisma/rehearse-env.js)"
 *   echo "$REHEARSE_APP"
 *
 * A different database name may be given as the first argument; it defaults to
 * the production name with `_rehearsal` appended.
 *
 * WHY THIS EXISTS
 * ---------------
 * `DEPLOY-UPGRADE.md` used to set these as shell variables in one step and use
 * them four steps later — with an `exit` back to the admin account in between,
 * to fix a Postgres role. Shell variables do not survive that, so the later
 * commands ran with empty values and the API refused to boot with
 *
 *   Missing required environment variables: DATABASE_URL
 *
 * which is `validateEnv` doing exactly its job and says nothing about the
 * actual mistake. A runbook that holds state in the shell between steps is a
 * runbook that breaks the moment somebody opens a second terminal or takes a
 * break, and both are normal during a deployment.
 *
 * So every block re-derives instead. This is idempotent, needs no arguments,
 * and works in any shell on the box.
 *
 * WHY IT DOES NOT TAKE A PASSWORD
 * -------------------------------
 * It reads `.env`, so there is nothing to type. The runbook previously wrote
 * `hms_owner:PASSWORD@…` as a placeholder in a command that otherwise looked
 * ready to paste, and it was pasted literally — producing a P1000 that reads as
 * a wrong password rather than as a placeholder. A tool that cannot be given
 * the wrong password is better than a warning not to.
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const envPath = resolve(__dirname, '../.env');
if (!existsSync(envPath)) {
  console.error('echo "backend/.env not found — run this from backend/" >&2; false');
  process.exit(1);
}

/** Read one key out of `.env` without disturbing the process environment. */
function fromEnvFile(key) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

const app = fromEnvFile('DATABASE_URL');
const admin = fromEnvFile('DATABASE_URL_ADMIN');

if (!app || !admin) {
  console.error(
    `echo "DATABASE_URL${!app ? '' : '_ADMIN'} is not set in backend/.env" >&2; false`,
  );
  process.exit(1);
}

/**
 * The database name is the last path segment, before any `?query`.
 *
 * Replaced by position rather than by a string substitution of the name: a
 * naive `s/hms_db/hms_db_rehearsal/` also rewrites a password that happens to
 * contain `hms_db`, and a host called `hms_db.internal`. Both are unlikely and
 * both would produce a connection string that looks right and points somewhere
 * else, which is the worst available failure for a command whose whole purpose
 * is not touching production.
 */
function retarget(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const source = new URL(app).pathname.replace(/^\//, '');
const target = process.argv[2] || `${source}_rehearsal`;

if (target === source) {
  console.error(
    'echo "Refusing: the rehearsal name is the same as the real database" >&2; false',
  );
  process.exit(1);
}

/** Single-quoted for the shell, so a password with `$` or a space survives. */
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

console.log(`export REHEARSE_APP=${q(retarget(app, target))}`);
console.log(`export REHEARSE_ADMIN=${q(retarget(admin, target))}`);
console.log(`export REHEARSE_DB=${q(target)}`);
