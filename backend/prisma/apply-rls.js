#!/usr/bin/env node
/**
 * Applies prisma/rls/tenant-isolation.sql, and says what it did.
 *
 *   npm run db:rls
 *
 * WHY NOT `prisma db execute`, AND WHY NOT `psql`
 * ----------------------------------------------
 * `psql` is not on most Windows PATHs. `prisma db execute` is, but it needs the
 * Prisma schema engine and reports failure quietly enough that the RLS step
 * appeared to succeed while `hms_app` was never created — the first sign being
 * a P1000 from the API much later, pointing at credentials rather than at a
 * migration that never ran.
 *
 * `pg` is already a dependency, needs no engine, and lets this print a summary
 * that can be checked rather than assumed.
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
      'RLS creates a role and alters every table, so it runs as the database\n' +
      'owner — not as hms_app, which is the role it creates. See backend/.env.\n',
  );
  process.exit(1);
}

const sqlPath = resolve(__dirname, 'rls/tenant-isolation.sql');
const sql = readFileSync(sqlPath, 'utf8');

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

  const { rows: pre } = await client.query(
    "select count(*)::int as n from information_schema.tables where table_schema='public'",
  );
  if (pre[0].n === 0) {
    throw new Error(
      'There are no tables in this database yet.\n' +
        '  Run the migration first:  npm run db:migrate -- --name init',
    );
  }

  /*
   * Tables existing is not enough — they must be the *tenancy* schema.
   *
   * A database left over from before multi-tenancy has all 24 tables and no
   * tenantId column, so the policy loop fails on the first ALTER with a bare
   * `column "tenantId" does not exist`. That names the symptom and not the
   * cause, which is a migration that has not been applied.
   */
  const { rows: cols } = await client.query(
    `select count(*)::int as n from information_schema.columns
     where table_schema='public' and column_name='tenantId'`,
  );
  if (cols[0].n === 0) {
    throw new Error(
      'These tables predate multi-tenancy — no tenantId column anywhere.\n' +
        '  The tenancy migration has not been applied to this database.\n\n' +
        '  Rebuild it (drops all data — this is dummy data):\n' +
        '    node prisma/admin-cli.js migrate reset --force\n' +
        '    node prisma/admin-cli.js migrate dev --name init\n' +
        '    npm run seed\n' +
        '    npm run db:rls',
    );
  }

  /*
   * Create the role in a statement of its own, BEFORE the main script.
   *
   * `client.query()` sends a multi-statement string over the simple query
   * protocol, which Postgres wraps in a single implicit transaction. One failure
   * anywhere rolls back everything — so when the policy loop failed on a
   * database that had no tenantId column, the CREATE ROLE at the top of the file
   * was undone with it. The visible symptom was `role "hms_app" does not exist`
   * long afterwards, in a different command, which is about as far from the
   * cause as an error can land.
   *
   * Creating it separately means a later failure leaves the role in place and
   * the error describes the real problem.
   */
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_app') THEN
        CREATE ROLE hms_app LOGIN PASSWORD 'change_me_in_env'
          NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
    END $$;
  `);

  // The rest of the file. Idempotent, so re-running after a failure is safe.
  await client.query(sql);

  const q = async (text) => (await client.query(text)).rows[0];

  /*
   * Sync hms_app's password to whatever DATABASE_URL says.
   *
   * The password previously lived in two places — this SQL file and .env — and
   * `CREATE ROLE` only runs when the role is absent, so editing the file after
   * the first run changed nothing. The result was a role holding the original
   * placeholder while .env held something else, surfacing as P1000 from the API
   * and blaming credentials that looked correct in pgAdmin.
   *
   * .env is now the only place the password is written. This makes the database
   * agree with it, every time, so the two cannot drift.
   */
  const appUrl = process.env.DATABASE_URL;
  if (appUrl) {
    const appPassword = decodeURIComponent(new URL(appUrl).password || '');
    if (appPassword) {
      // Let Postgres quote it: %L escapes correctly for any password, where
      // string-concatenating one into DDL would not.
      const { rows } = await client.query(
        // $1::text, not $1 — format() is variadic "any", so Postgres cannot
        // infer the parameter's type and refuses the statement outright.
        "select format('ALTER ROLE hms_app WITH PASSWORD %L', $1::text) as stmt",
        [appPassword],
      );
      await client.query(rows[0].stmt);
      console.log('\n  hms_app password set from DATABASE_URL in .env.');
    }
  }

  const role = await q("select count(*)::int as n from pg_roles where rolname='hms_app'");
  const policies = await q(
    "select count(*)::int as n from pg_policies where schemaname='public' and policyname='tenant_isolation'",
  );
  const forced = await q(
    `select count(*)::int as n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
     where ns.nspname='public' and c.relrowsecurity and c.relforcerowsecurity`,
  );
  const canConnect = await q(
    "select has_database_privilege('hms_app', current_database(), 'CONNECT') as ok",
  );

  console.log('\nRow-Level Security applied:');
  console.log(`  hms_app role ............ ${role.n === 1 ? 'created' : 'MISSING'}`);
  console.log(`  can connect to database . ${canConnect.ok ? 'yes' : 'NO'}`);
  console.log(`  tenant_isolation policies ${policies.n}`);
  console.log(`  tables RLS-enabled+forced ${forced.n}`);

  if (role.n !== 1 || policies.n === 0 || !canConnect.ok) {
    throw new Error('RLS did not apply cleanly — see the counts above.');
  }

  console.log('\n  Done. Start the API with:  npm run dev\n');
  await client.end();
})().catch(async (err) => {
  console.error(`\nFailed to apply RLS:\n  ${err.message}\n`);
  await client.end().catch(() => {});
  process.exit(1);
});
