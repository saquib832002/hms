#!/usr/bin/env node
/**
 * Runs the Prisma CLI as the database *owner* instead of the application role.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two roles connect to this database, and the split is the whole of tenant
 * isolation (see docs/adr-001-multi-tenancy.md):
 *
 *   DATABASE_URL        hms_app   — the API. Non-superuser, so RLS applies.
 *   DATABASE_URL_ADMIN  owner     — migrations and the seed, which legitimately
 *                                   write across hospitals.
 *
 * The Prisma CLI only reads `DATABASE_URL`. Pointing that at `hms_app` — which
 * is correct for the running API — means `prisma migrate` authenticates as a
 * role that does not exist until the RLS migration creates it, and fails with
 * P1000 before it can create anything. It also *should* fail later: an
 * application role has no business running DDL.
 *
 * So this wrapper swaps in the admin URL for the duration of one CLI call.
 * Doing it here rather than in an npm script keeps it working on Windows,
 * where `VAR=x command` is not valid shell.
 *
 *   node prisma/admin-cli.js migrate dev --name init
 *   node prisma/admin-cli.js db execute --file prisma/rls/tenant-isolation.sql --schema prisma/schema.prisma
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

// Prisma loads .env itself, but only after we have already had to decide which
// URL to hand it, so read it here too.
const envPath = resolve(__dirname, '../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.trim().replace(/^["']|["']$/g, '');
  }
}

const admin = process.env.DATABASE_URL_ADMIN;
if (!admin) {
  console.error(
    'DATABASE_URL_ADMIN is not set.\n\n' +
      'It is the owner/superuser connection used for migrations and seeding.\n' +
      'DATABASE_URL is the application role (hms_app) and cannot run DDL.\n' +
      'See backend/.env and docs/adr-001-multi-tenancy.md.',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node prisma/admin-cli.js <prisma args...>');
  process.exit(1);
}

/*
 * Run Prisma's CLI directly with Node, rather than through npx.
 *
 * Node 18.20 / 20.12 / 22+ refuse to spawn a `.cmd` or `.bat` file without
 * `shell: true` (the CVE-2024-27980 fix). `spawnSync('npx.cmd', …)` therefore
 * fails to start at all on Windows: no output, exit code 1, and `result.error`
 * holding the only explanation — which this script used to discard.
 *
 * Resolving the CLI's entry point and running it with process.execPath avoids
 * the shell entirely, so it behaves the same on Windows and everywhere else.
 */
function prismaEntry() {
  const pkgPath = require.resolve('prisma/package.json', { paths: [resolve(__dirname, '..')] });
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.prisma;
  if (!rel) throw new Error('Cannot find the prisma CLI entry point in its package.json');
  return resolve(pkgPath, '..', rel);
}

let entry;
try {
  entry = prismaEntry();
} catch (e) {
  console.error(`\nCould not locate the Prisma CLI: ${e.message}`);
  console.error('Is it installed?  npm install\n');
  process.exit(1);
}

const result = spawnSync(process.execPath, [entry, ...args], {
  stdio: 'inherit',
  cwd: resolve(__dirname, '..'),
  // The override. Nothing else in the process sees it.
  env: { ...process.env, DATABASE_URL: admin },
});

// A process that never started reports its reason here and nowhere else.
if (result.error) {
  console.error(`\nFailed to run the Prisma CLI: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
