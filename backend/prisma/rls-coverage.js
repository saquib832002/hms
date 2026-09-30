#!/usr/bin/env node
/**
 * Checks that every table holding tenant data actually carries an RLS policy.
 *
 *   npm run db:rls:verify
 *
 * It changes nothing.
 *
 * WHY THIS EXISTS, AND WHY db:doctor IS NOT ENOUGH
 * -----------------------------------------------
 * `db:doctor` asks `count(*) > 0` over `pg_policies`. That was true and useful
 * when there were 25 tables; it is now a check that passes while ten new
 * tables have no policy at all, because 25 is still greater than zero. A guard
 * that cannot fail asserts nothing, and this repo has found that four times.
 *
 * The specific hazard it misses is the normal case rather than an exotic one.
 * `prisma migrate deploy` creates tables and **cannot express a policy**, so
 * every migration that adds a tenant-scoped table leaves it unprotected until
 * `npm run db:rls` runs. `migrate status` then says *Database schema is up to
 * date*, which is true about the schema and says nothing about isolation — so
 * the one command that must not be skipped is the one with no output telling
 * you that you skipped it.
 *
 * A table with no policy is readable **across hospitals** by anything
 * connecting as `hms_app`, which is the API. That is the single failure this
 * whole design exists to prevent.
 *
 * WHAT IT DECIDES, AND FROM WHAT
 * ------------------------------
 * The expectation is derived from the database itself rather than from a list
 * kept here: **a table with a `tenantId` column must be scoped.** A hand-kept
 * list is the thing that goes stale, and it would go stale in the silent
 * direction — a new table missing from it reads as "not expected to have a
 * policy" rather than as a gap.
 *
 * `PLATFORM_TABLES` is the one exception and must stay in step with
 * `rls/tenant-isolation.sql`. These carry the *inverted* policy — visible only
 * when no hospital is in scope — and `break_glass_grants` and
 * `tenant_applications` both have a `tenantId`, so the generic rule would
 * apply cleanly to them and be wrong.
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Client } = require('pg');

/** Must match `platform_tables` in rls/tenant-isolation.sql. */
const PLATFORM_TABLES = [
  'platform_users',
  'break_glass_grants',
  'tenant_applications',
  'platform_password_reset_tokens',
];

/** Prisma's own bookkeeping. Not ours, and deliberately unprotected. */
const IGNORED = ['_prisma_migrations'];

const envPath = resolve(__dirname, '../.env');
const fromFile = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && fromFile[m[1]] === undefined) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
/*
 * The owner, not `hms_app`. This reads `pg_class` and `pg_policies`, and the
 * application role has no business doing so — but more to the point, a check
 * that ran as the role being constrained could be misled by the very policies
 * it is inspecting.
 */
const url = process.env.DATABASE_URL_ADMIN || fromFile.DATABASE_URL_ADMIN;
if (!url) {
  console.error('\nDATABASE_URL_ADMIN is not set. See backend/.env.\n');
  process.exit(1);
}

const green = (s) => `\u001b[32m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;

const client = new Client({ connectionString: url });

(async () => {
  await client.connect();
  const { rows: who } = await client.query('select current_user u, current_database() d');
  console.log(`\nRLS coverage — ${who[0].u} @ ${green(who[0].d)}\n`);

  const { rows: tables } = await client.query(`
    select c.relname                  as name,
           c.relrowsecurity           as enabled,
           c.relforcerowsecurity      as forced,
           exists (
             select 1 from information_schema.columns col
             where col.table_schema = 'public'
               and col.table_name   = c.relname
               and col.column_name  = 'tenantId'
           )                          as has_tenant_id,
           p.qual                     as using_expr,
           p.with_check               as check_expr
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_policies p
           on p.schemaname = 'public'
          and p.tablename  = c.relname
          and p.policyname = 'tenant_isolation'
    where n.nspname = 'public'
      and c.relkind = 'r'
    order by c.relname
  `);

  if (!tables.length) {
    console.error(red('No tables at all. Run npm run db:migrate first.\n'));
    process.exit(1);
  }

  const failures = [];
  const scoped = [];
  const platform = [];
  const global = [];

  for (const t of tables) {
    if (IGNORED.includes(t.name)) continue;

    const isPlatform = PLATFORM_TABLES.includes(t.name);
    const expectPolicy = isPlatform || t.has_tenant_id;

    if (!expectPolicy) {
      global.push(t.name);
      // A policy here is not automatically wrong, but it is worth seeing: a
      // table with no tenantId cannot be scoped by the generic predicate.
      if (t.using_expr) {
        failures.push(
          `${t.name}: has a tenant_isolation policy but no tenantId column — ` +
            `it is either misclassified here or in rls/tenant-isolation.sql`,
        );
      }
      continue;
    }

    const problems = [];
    if (!t.using_expr) problems.push('NO POLICY — readable across hospitals');
    if (!t.enabled) problems.push('row level security not ENABLED');
    // Without FORCE, the table owner bypasses the policy. Migrations and the
    // seed connect as the owner and legitimately need to; the point of FORCE
    // is that nothing else silently inherits that exemption.
    if (!t.forced) problems.push('row level security not FORCED');

    if (t.using_expr) {
      const inverted = /app_current_tenant\(\)\s+IS\s+NULL/i.test(t.using_expr);
      if (isPlatform && !inverted) {
        problems.push(
          'carries the generic tenant policy where the INVERTED one is required ' +
            '— one hospital could read vendor rows',
        );
      }
      if (!isPlatform && inverted) {
        problems.push('carries the INVERTED platform policy — no hospital can read its own rows');
      }
    }

    /*
     * audit_logs is the one deliberate variation: tenantId is nullable, because
     * an anonymous failed login belongs to no hospital and that row is one of
     * the most useful in the table. The WITH CHECK must permit the NULL insert
     * or every failed login logs an error instead of a row — on the failure
     * path, where it is least likely to be noticed.
     */
    if (t.name === 'audit_logs' && t.check_expr && !/IS NULL/i.test(t.check_expr)) {
      problems.push('WITH CHECK rejects rows with no tenant — failed logins will not be recorded');
    }

    (isPlatform ? platform : scoped).push(t.name);
    for (const p of problems) failures.push(`${t.name}: ${p}`);
  }

  console.log(`  tenant-scoped tables : ${scoped.length}`);
  console.log(`  platform tables      : ${platform.length}`);
  console.log(`  global (no tenantId) : ${global.length}   ${dim('no policy expected')}`);

  const missing = PLATFORM_TABLES.filter((t) => !tables.some((r) => r.name === t));
  for (const t of missing) {
    failures.push(`${t}: table does not exist — a migration has not been applied`);
  }

  if (!failures.length) {
    console.log(
      `\n${green('✓')} Every table carrying tenantId is scoped, enabled and forced, ` +
        `and every platform table carries the inverted policy.\n`,
    );
    process.exit(0);
  }

  console.log(`\n${red(`✗ ${failures.length} problem${failures.length === 1 ? '' : 's'}:`)}\n`);
  for (const f of failures) console.log(`   ${f}`);
  console.log(
    `\nAlmost always the fix is one command, and it is idempotent:\n` +
      `   npm run db:rls\n\n` +
      `Until then, treat this database as having no tenant isolation. Migrations\n` +
      `create tables and cannot create policies, so "schema is up to date" and\n` +
      `"isolated" are different claims.\n`,
  );
  process.exit(1);
})().catch(async (err) => {
  console.error(`\n${red('Failed')}: ${err.message}\n`);
  process.exit(1);
});
