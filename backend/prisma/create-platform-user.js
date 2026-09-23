#!/usr/bin/env node
/**
 * Create or reset a vendor console account, without touching anything else.
 *
 * WHY THIS EXISTS RATHER THAN "RUN THE SEED"
 * ------------------------------------------
 * `npm run seed` is destructive: it deletes patients, invoices, prescriptions
 * and audit rows before rebuilding a demo hospital. That is correct for a fresh
 * database and catastrophic on one somebody has been using — which is exactly
 * the situation you are in the first time you need a console login.
 *
 * WHY NOT A psql INSERT
 * ---------------------
 * An Argon2 hash is `$argon2id$v=19$m=...`, and every `$` in it is a variable
 * to a POSIX shell and a psql client variable to `-c`. That combination has
 * already produced one truncated hash and an account nobody could sign into.
 * Node hashes it and writes it in the same process, so nothing ever passes
 * through a shell.
 *
 * WHY THE ADMIN CONNECTION
 * ------------------------
 * `platform_users` carries the *inverted* RLS policy: visible only when no
 * hospital is in scope. This script sets no tenant, so it satisfies that — but
 * `DATABASE_URL` is the application role, which has no business writing vendor
 * credentials. Same reasoning as `admin-cli.js`.
 *
 * Usage (Windows cmd):
 *   set PLATFORM_PASSWORD=whatever-you-choose
 *   node prisma/create-platform-user.js you@yourcompany.com "Your Name"
 *   set PLATFORM_PASSWORD=
 *
 * Passing the password as an argument works too and is worse: arguments show up
 * in shell history and in the process list.
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

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

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) {
  console.error(
    '\nDATABASE_URL_ADMIN is not set.\n' +
      'It is the owner connection used for migrations and seeding; DATABASE_URL is\n' +
      'the application role and has no business writing vendor credentials.\n',
  );
  process.exit(1);
}

const [email, fullName] = process.argv.slice(2);
const password = process.env.PLATFORM_PASSWORD ?? process.argv[4];

if (!email || !fullName || !password) {
  console.error(
    '\nusage: node prisma/create-platform-user.js <email> "<full name>"\n' +
      '       with PLATFORM_PASSWORD set in the environment\n',
  );
  process.exit(1);
}

if (password.length < 12) {
  // This credential can open a break-glass grant against any hospital on the
  // deployment. It is the most powerful password in the system and should not
  // be the weakest.
  console.error('\nChoose a password of at least 12 characters.\n');
  process.exit(1);
}

(async () => {
  const { PrismaClient } = require('@prisma/client');
  const { hash } = require('@node-rs/argon2');

  const prisma = new PrismaClient({ datasources: { db: { url: adminUrl } } });

  try {
    const passwordHash = await hash(password);
    const user = await prisma.platformUser.upsert({
      where: { email: email.trim().toLowerCase() },
      // Upsert rather than create, so this doubles as a password reset. There
      // is no "forgot password" for vendor staff and there should not be one —
      // the recovery path is somebody with database access, which is this.
      update: { passwordHash, fullName: fullName.trim(), isActive: true },
      create: { email: email.trim().toLowerCase(), passwordHash, fullName: fullName.trim() },
    });

    console.log(`\n  ${user.email} is ready.`);
    console.log('  Sign in at /platform on the web app.\n');
  } catch (err) {
    console.error(`\nFailed: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
