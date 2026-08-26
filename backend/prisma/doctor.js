#!/usr/bin/env node
/**
 * Reports the complete state of the database setup, and the one next action.
 *
 *   npm run db:doctor
 *
 * Written after several rounds of chasing symptoms: "role does not exist",
 * "password not valid" and "column tenantId does not exist" all turned out to
 * be one failed script, and each error described a consequence rather than the
 * cause. This checks every stage in order and stops at the first thing that is
 * actually wrong.
 *
 * It changes nothing.
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Client } = require('pg');

// ── env ────────────────────────────────────────────────────────────────────
const envPath = resolve(__dirname, '../.env');
const fromFile = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const val = (k) => process.env[k] || fromFile[k];

const ok = (s) => console.log(`  \u001b[32m✓\u001b[0m ${s}`);
const bad = (s) => console.log(`  \u001b[31m✗\u001b[0m ${s}`);
const info = (s) => console.log(`    ${s}`);

function verdict(problem, ...actions) {
  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(` PROBLEM: ${problem}`);
  console.log(' DO THIS:');
  for (const a of actions) console.log(`   ${a}`);
  console.log('──────────────────────────────────────────────────────────────\n');
  process.exit(1);
}

function parse(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

(async () => {
  console.log('\nDatabase setup check\n');

  // ── 1. env ───────────────────────────────────────────────────────────────
  const appUrl = val('DATABASE_URL');
  const adminUrl = val('DATABASE_URL_ADMIN');
  if (!appUrl || !adminUrl) {
    verdict(
      'backend/.env is missing DATABASE_URL or DATABASE_URL_ADMIN.',
      'Open backend/.env and make sure both lines are present.',
    );
  }
  const app = parse(appUrl);
  const admin = parse(adminUrl);
  ok(`.env read — app user "${app.user}", admin user "${admin.user}", database "${admin.database}"`);
  if (app.database !== admin.database) {
    bad(`the two URLs point at DIFFERENT databases: ${app.database} vs ${admin.database}`);
    verdict(
      'DATABASE_URL and DATABASE_URL_ADMIN name different databases.',
      'Make the database part of both URLs the same in backend/.env.',
    );
  }

  /*
   * ── 1b. do the migration files match the schema? ─────────────────────────
   *
   * Checked before touching the database, because this is the failure that
   * survives every attempt to fix it downstream: a migration generated before
   * multi-tenancy contains no tenantId, so `migrate reset` faithfully rebuilds
   * the OLD schema. Every symptom then appears in the database — missing
   * columns, a missing role, failed logins — while the actual fault is a file
   * on disk that nothing else looks at.
   */
  const migrationsDir = resolve(__dirname, 'migrations');
  if (existsSync(migrationsDir)) {
    const { readdirSync } = require('node:fs');
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const schemaHasTenancy = readFileSync(resolve(__dirname, 'schema.prisma'), 'utf8').includes(
      'tenantId',
    );
    const stale = dirs.filter((d) => {
      const f = resolve(migrationsDir, d, 'migration.sql');
      return existsSync(f) && !readFileSync(f, 'utf8').includes('tenantId');
    });

    if (schemaHasTenancy && dirs.length > 0 && stale.length === dirs.length) {
      bad(`every migration predates multi-tenancy: ${stale.join(', ')}`);
      info('schema.prisma has tenantId; none of the migration files do.');
      info('Replaying these rebuilds the OLD schema, whatever else you fix.');
      verdict(
        'The migration files are older than the tenancy schema.',
        `Delete the stale migration folder(s): prisma/migrations/${stale[0]}`,
        'Then rebuild:',
        '  node prisma/admin-cli.js migrate reset --force',
        '  node prisma/admin-cli.js migrate dev --name init',
        '  npm run seed',
        '  npm run db:rls',
      );
    }
    ok(`${dirs.length} migration(s) on disk, consistent with the schema`);
  } else {
    info('no migrations folder yet — the first migrate will create one');
  }

  /*
   * ── 1c. is the generated client older than the schema? ───────────────────
   *
   * `prisma generate` writes a typed client from schema.prisma. Edit the schema
   * without regenerating and every query still compiles against the OLD types,
   * then fails at runtime with "Unknown field X for include statement on model
   * Y" — which reads like a bug in the query rather than a build step that was
   * skipped.
   *
   * This has now cost three round trips in this project: once for the tenancy
   * fields, once for currency, once for roleAssignments. Cheap to detect.
   */
  const generated = resolve(__dirname, '../node_modules/.prisma/client/index.d.ts');
  const schemaFile = resolve(__dirname, 'schema.prisma');
  if (existsSync(generated) && existsSync(schemaFile)) {
    const { statSync } = require('node:fs');
    const schemaTime = statSync(schemaFile).mtimeMs;
    const clientTime = statSync(generated).mtimeMs;

    if (schemaTime > clientTime) {
      bad('the generated Prisma client is older than schema.prisma');
      info(`schema edited : ${new Date(schemaTime).toISOString()}`);
      info(`client built  : ${new Date(clientTime).toISOString()}`);
      info('Queries will fail at runtime with "Unknown field ... for include statement".');
      verdict(
        'The Prisma client has not been regenerated since the schema changed.',
        'npx prisma generate',
        'If the schema change also needs a table:',
        '  node prisma/admin-cli.js migrate dev --name <what_changed>',
      );
    }
    ok('generated Prisma client is up to date with the schema');
  }

  // ── 2. admin connection ──────────────────────────────────────────────────
  const a = new Client(admin);
  try {
    await a.connect();
    ok(`connected as admin "${admin.user}"`);
  } catch (e) {
    bad(`cannot connect as admin "${admin.user}": ${e.message || e.code}`);
    if (e.code === 'ECONNREFUSED' || (e.errors && e.errors.some((x) => x.code === 'ECONNREFUSED'))) {
      verdict(
        'PostgreSQL is not running (nothing is listening on that port).',
        'services.msc → postgresql-x64-<version> → Start',
        'If it will not start, read the newest file in',
        '  C:\\Program Files\\PostgreSQL\\<version>\\data\\log\\',
      );
    }
    verdict(
      `The password for "${admin.user}" in DATABASE_URL_ADMIN is wrong.`,
      'Fix the DATABASE_URL_ADMIN line in backend/.env.',
      'If you have forgotten it, reset it via pg_hba.conf trust — ask and I will walk you through it.',
    );
  }

  const one = async (q, p) => (await a.query(q, p)).rows[0];

  // ── 3. schema ────────────────────────────────────────────────────────────
  const tables = await one(
    "select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
  );
  const tenantCols = await one(
    "select count(*)::int n from information_schema.columns where table_schema='public' and column_name='tenantId'",
  );

  if (tables.n === 0) {
    bad('the database has no tables at all');
    verdict(
      'The migration has never run.',
      'node prisma/admin-cli.js migrate reset --force',
      'node prisma/admin-cli.js migrate dev --name init',
      'npm run seed',
      'npm run db:rls',
    );
  }
  ok(`${tables.n} tables present`);

  if (tenantCols.n === 0) {
    bad('no column named exactly "tenantId" anywhere');

    // 25 tables is the tenancy count (24 models + tenants), so "no tenantId"
    // and "25 tables" together usually mean the columns exist under a different
    // name rather than that the migration is missing. Show the evidence instead
    // of asserting a cause.
    const snake = await one(
      "select count(*)::int n from information_schema.columns where table_schema='public' and column_name='tenant_id'",
    );
    const tenantsTable = await one("select to_regclass('public.tenants') is not null as present");
    const cols = (
      await a.query(
        `select column_name from information_schema.columns
         where table_schema='public' and table_name='patients' order by ordinal_position limit 12`,
      )
    ).rows.map((r) => r.column_name);
    const names = (
      await a.query(
        `select table_name from information_schema.tables
         where table_schema='public' and table_type='BASE TABLE' order by table_name limit 30`,
      )
    ).rows.map((r) => r.table_name);

    info(`tenants table present: ${tenantsTable.present}`);
    info(`columns named tenant_id (snake_case): ${snake.n}`);
    info(`patients columns: ${cols.join(', ') || '(no patients table)'}`);
    info(`tables: ${names.join(', ')}`);

    if (snake.n > 0) {
      verdict(
        'The columns are named tenant_id, not tenantId — these tables were not created by Prisma.',
        'Rebuild them from the Prisma schema:',
        '  node prisma/admin-cli.js migrate reset --force',
        '  node prisma/admin-cli.js migrate dev --name init',
        '  npm run seed',
        '  npm run db:rls',
      );
    }
    verdict(
      'The tenancy migration has not been applied.',
      'node prisma/admin-cli.js migrate reset --force    (drops dummy data)',
      'node prisma/admin-cli.js migrate dev --name init',
      'npm run seed',
      'npm run db:rls',
    );
  }
  ok(`${tenantCols.n} tables carry tenantId`);

  const tenants = await one("select to_regclass('public.tenants') is not null as present");
  if (!tenants.present) {
    bad('there is no tenants table');
    verdict(
      'The tenancy migration is incomplete.',
      'node prisma/admin-cli.js migrate reset --force',
      'node prisma/admin-cli.js migrate dev --name init',
      'npm run seed',
      'npm run db:rls',
    );
  }
  const tenantRows = await one('select count(*)::int n from tenants');
  ok(`tenants table present, ${tenantRows.n} hospital(s) seeded`);

  // ── 4. role ──────────────────────────────────────────────────────────────
  const role = await one("select count(*)::int n from pg_roles where rolname='hms_app'");
  if (role.n === 0) {
    bad('the hms_app role does not exist');
    verdict('RLS has never been applied successfully.', 'npm run db:rls');
  }
  ok('hms_app role exists');

  const canConnect = await one(
    "select has_database_privilege('hms_app', current_database(), 'CONNECT') as v",
  );
  canConnect.v ? ok('hms_app may connect to the database') : bad('hms_app lacks CONNECT');

  const policies = await one(
    "select count(*)::int n from pg_policies where schemaname='public' and policyname='tenant_isolation'",
  );
  policies.n > 0
    ? ok(`${policies.n} tenant_isolation policies`)
    : bad('no RLS policies — tenant data is NOT isolated');

  if (!canConnect.v || policies.n === 0) {
    verdict('RLS is only partly applied.', 'npm run db:rls');
  }

  /*
   * audit_logs needs a WITH CHECK that permits a NULL tenant.
   *
   * An anonymous failed login belongs to no hospital, and the audit writer runs
   * from the exception filter with no tenant in scope. Under the generic policy
   * that insert violates RLS, so every failed login logs an error instead of a
   * row — losing exactly the events the trail exists for, and only on the
   * failure path, where it is least likely to be noticed.
   */
  const auditCheck = await one(
    "select coalesce(with_check,'') as c from pg_policies where tablename='audit_logs' and policyname='tenant_isolation'",
  );
  if (!auditCheck || !/tenantId.*IS NULL/i.test(auditCheck.c)) {
    bad('the audit_logs policy rejects rows with no tenant');
    info(`current WITH CHECK: ${auditCheck ? auditCheck.c : '(no policy)'}`);
    info('Anonymous failed logins cannot be recorded — they belong to no hospital.');
    verdict(
      'audit_logs has the generic policy instead of its own.',
      'npm run db:rls        (drops and recreates it from the SQL file)',
    );
  }
  ok('audit_logs accepts unattributed rows (anonymous failed logins)');

  /*
   * List the accounts, read with the ADMIN connection.
   *
   * "Invalid email or password" is deliberately identical whether the address
   * is unknown or the password is wrong — that is what stops an attacker
   * enumerating staff addresses — which also means it cannot tell you that the
   * seed never ran. Reading them here from outside the API answers the question
   * the error refuses to.
   */
  const users = (
    await a.query(
      `select u.email, u.role, t.slug, u."isActive"
       from users u join tenants t on t.id = u."tenantId"
       order by t.slug, u.role limit 20`,
    )
  ).rows;

  if (users.length === 0) {
    bad('there are no user accounts — the seed has not run');
    verdict('The database has no accounts to log in with.', 'npm run seed');
  }

  console.log('\n  Accounts you can sign in with (password: ChangeMe123!):');
  for (const u of users) {
    console.log(`    ${u.slug.padEnd(11)} ${u.role.padEnd(14)} ${u.email}${u.isActive ? '' : '  (INACTIVE)'}`);
  }

  await a.end();

  // ── 5. the app's own credentials ─────────────────────────────────────────
  const c = new Client(app);
  try {
    await c.connect();
    const who = await c.query('select current_user');
    ok(`connected as the application role "${who.rows[0].current_user}"`);
    const visible = await c.query('select count(*)::int n from patients');
    info(`patients visible with no tenant set: ${visible.rows[0].n} (0 is correct — RLS)`);
    await c.end();
  } catch (e) {
    bad(`cannot connect as "${app.user}": ${e.message || e.code}`);
    await c.end().catch(() => {});
    if (e.code === '28P01') {
      verdict(
        `The hms_app password in the database does not match DATABASE_URL.`,
        'npm run db:rls        (it sets the password from .env)',
        'If that still fails, run this in pgAdmin against the database:',
        `  ALTER ROLE hms_app WITH PASSWORD '${app.password}';`,
      );
    }
    verdict('The application cannot log in.', 'npm run db:rls');
  }

  console.log('\n  Everything checks out. Start the API:  npm run dev\n');
})().catch((e) => {
  console.error(`\nCheck failed unexpectedly: ${e.stack || e.message}\n`);
  process.exit(1);
});
