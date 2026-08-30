#!/usr/bin/env node
/**
 * Applies the partial unique indexes Prisma cannot declare.
 *
 *   npm run db:constraints
 *
 * WHY THIS EXISTS SEPARATELY FROM THE MIGRATION
 * ---------------------------------------------
 * Both appointment slot rules must ignore cancelled and no-show rows, and
 * `schema.prisma` has no syntax for a partial unique index. Left as a plain
 * `@@unique`, a cancelled appointment holds its slot for ever — reception
 * cancels the 09:20, tries to rebook it, and is told the slot is taken by an
 * appointment that no longer exists.
 *
 * Runs as the database owner, like `db:rls`, because it drops and creates
 * indexes. It is idempotent, and it self-checks: the SQL inserts a probe
 * appointment, proves both rules fire, and rolls the probe back.
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
      'These are index changes, so they run as the database owner rather than\n' +
      'as hms_app. See backend/.env.\n',
  );
  process.exit(1);
}

const sql = readFileSync(resolve(__dirname, 'sql/appointment-slots.sql'), 'utf8');

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

  const { rows } = await client.query(
    "select to_regclass('public.appointments') is not null as ok",
  );
  if (!rows[0].ok) {
    throw new Error(
      'There is no appointments table yet.\n' +
        '  Run the migration first:  npm run db:migrate',
    );
  }

  /*
   * NOTICEs are the point of this script, not noise.
   *
   * The self-check inside the SQL reports through RAISE NOTICE, so a silent run
   * would hide the one thing worth knowing — whether the indexes actually
   * refuse a double booking.
   */
  client.on('notice', (n) => console.log(`   ${n.message}`));

  await client.query(sql);

  const { rows: made } = await client.query(
    `select indexname from pg_indexes
      where schemaname='public' and indexname like 'appointment_%_slot_active'
      order by indexname`,
  );

  console.log('\nSlot constraints applied:');
  for (const r of made) console.log(`   ✓ ${r.indexname}`);

  if (made.length !== 2) {
    throw new Error(
      `Expected 2 slot indexes, found ${made.length}. The script did not do what it claims.`,
    );
  }

  console.log(
    '\n   A doctor cannot be double-booked, a patient cannot be in two places\n' +
      '   at once, and cancelling an appointment frees its slot.\n',
  );
})()
  .catch((err) => {
    console.error('\nFailed to apply appointment constraints:\n  ' + err.message + '\n');
    process.exitCode = 1;
  })
  .finally(() => client.end());
