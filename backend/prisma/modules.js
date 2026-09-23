#!/usr/bin/env node
/**
 * Read — and repair — what each hospital was sold.
 *
 *   npm run db:modules                       list every tenant and its modules
 *   npm run db:modules -- st-marys           one tenant
 *   npm run db:modules -- st-marys all       give it everything back
 *   npm run db:modules -- st-marys CLINIC,PHARMACY
 *
 * WHY THIS EXISTS
 * ---------------
 * `Tenant.modules` decides which menu items a hospital sees, and a gated item
 * simply disappears. So a narrow or empty list presents as *the product is
 * broken* — reported here twice in one afternoon, as "a lot of options have
 * gone, partner labs, partner pharmacy" and then "an administrator cannot see
 * the pharmacy or the laboratory". Both times the question that could not be
 * answered from inside the application was the simplest one: **what is
 * actually in that column right now?**
 *
 * The vendor console can show and change it, and needs a platform login, a
 * running API and a browser. When the thing you are debugging is *why screens
 * are missing*, requiring a second UI to find out is the wrong dependency —
 * this reads the row directly and prints it.
 *
 * It is also the route out. Everything else in this system that narrows a
 * plan is a deliberate act by the vendor; nothing could widen it again without
 * that console, which is the "precondition nobody can satisfy" shape this
 * project keeps having to reopen.
 *
 * Runs as the database owner, like `db:rls` and `db:constraints`: `tenants` is
 * a global model with no policy, but the owner connection is the one that is
 * unambiguously allowed to write it.
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

const url = process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL;
if (!url) {
  console.error('\nNeither DATABASE_URL_ADMIN nor DATABASE_URL is set. See backend/.env.\n');
  process.exit(1);
}

/**
 * Written out rather than imported from the generated client, so this keeps
 * working when the client is stale — which is one of the states it exists to
 * diagnose.
 */
const ALL = ['CLINIC', 'WARDS', 'PHARMACY', 'LABORATORY', 'BILLING'];

/**
 * Read an array column back out of `pg`.
 *
 * node-postgres parses arrays only for the **built-in** type OIDs it ships a
 * parser for. `TenantModule[]` is a user-defined enum array whose OID is
 * assigned when the type is created, so there is no parser and the value
 * arrives as the raw Postgres literal — the string `{CLINIC,PHARMACY}` rather
 * than an array.
 *
 * That produced `rows[0].modules.join is not a function` on the first real
 * run: a diagnostic written to answer "what is in this column" falling over
 * while printing the answer, having already applied the change correctly. Both
 * shapes are handled rather than one assumed, because a registered type parser
 * elsewhere in the process would flip it back without warning.
 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return String(value)
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((v) => v.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

const [slug, spec] = process.argv.slice(2);

async function main() {
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    if (slug && spec) {
      const wanted =
        spec.toLowerCase() === 'all'
          ? ALL
          : spec
              .split(',')
              .map((m) => m.trim().toUpperCase())
              .filter(Boolean);

      const unknown = wanted.filter((m) => !ALL.includes(m));
      if (unknown.length) {
        console.error(`\nNot a module: ${unknown.join(', ')}\nKnown: ${ALL.join(', ')}\n`);
        process.exit(1);
      }

      /*
       * The complete set, never a delta — the same rule
       * `PATCH /platform/tenants/:id/modules` follows. Two people applying two
       * half-changes to a row neither of them read is how a plan ends up
       * meaning nothing anybody chose.
       */
      const { rowCount, rows } = await client.query(
        `UPDATE tenants SET modules = $1::"TenantModule"[] WHERE slug = $2
         RETURNING slug, name, modules`,
        [wanted, slug],
      );

      if (rowCount === 0) {
        console.error(`\nNo hospital with the code "${slug}".\n`);
        process.exit(1);
      }

      console.log(`\n  ${rows[0].slug} — ${rows[0].name}`);
      console.log(`  now: ${toArray(rows[0].modules).join(', ') || '(none)'}`);
      console.log(
        '\n  Nothing was deleted either way: records under a module that was off\n' +
          '  come back with it. Staff have to sign out and in again — the module\n' +
          '  list travels in the session and the menu is built from it.\n',
      );
      return;
    }

    const { rows } = await client.query(
      `SELECT slug, name, "isActive", modules FROM tenants
       ${slug ? 'WHERE slug = $1' : ''} ORDER BY slug`,
      slug ? [slug] : [],
    );

    if (rows.length === 0) {
      console.error(slug ? `\nNo hospital with the code "${slug}".\n` : '\nNo hospitals.\n');
      process.exit(1);
    }

    console.log('');
    for (const t of rows) {
      const has = toArray(t.modules);
      const missing = ALL.filter((m) => !has.includes(m));
      console.log(`  ${t.slug}${t.isActive ? '' : '  (inactive)'} — ${t.name}`);
      console.log(`    has:     ${has.join(', ') || '(none)'}`);
      /*
       * The missing list is printed as well as the present one, because that
       * is the question somebody actually arrived with — "why can I not see
       * the pharmacy" — and making them diff two lists in their head is how a
       * diagnostic gets misread.
       */
      console.log(`    missing: ${missing.join(', ') || '—'}`);
      console.log('');
    }

    console.log('  Give one back with:  npm run db:modules -- <code> all\n');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  /*
   * A missing column here is itself the answer, and a stack trace buries it.
   * `tenants.modules` not existing means the `tenant_modules` migration has
   * not been applied — which disables the *restriction* rather than the
   * feature, silently and completely, and is exactly the failure
   * `schema-drift.spec.ts` was written after.
   */
  if (/column .*modules.* does not exist/i.test(String(err.message))) {
    console.error(
      '\n  tenants.modules does not exist — the tenant_modules migration has not\n' +
        '  been applied to this database. Run:\n\n' +
        '    node prisma/admin-cli.js migrate deploy\n',
    );
    process.exit(1);
  }
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
