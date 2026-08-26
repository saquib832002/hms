#!/usr/bin/env node
/**
 * Diagnoses a database connection without involving Prisma.
 *
 *   node prisma/check-db.js
 *
 * Exists because P1000 ("credentials are not valid") is reported identically
 * whether the password is wrong, the URL is mis-parsed, or something in the
 * environment is overriding .env — and pgAdmin succeeding with "the same"
 * details rules out only the first of those.
 *
 * It never prints the password. It prints its length and whether it contains
 * characters that must be percent-encoded in a URL, which is the usual answer.
 */
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const envPath = resolve(__dirname, '../.env');
const fromFile = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

console.log('\n── where the value comes from ──────────────────────────────');
for (const key of ['DATABASE_URL', 'DATABASE_URL_ADMIN']) {
  const inShell = process.env[key];
  const inFile = fromFile[key];
  if (inShell && inFile && inShell !== inFile) {
    // The trap: a shell/system variable silently wins over .env, so editing
    // .env changes nothing and the error never moves.
    console.log(`  ${key}: ⚠ SHELL OVERRIDES .env — the shell value is being used`);
  } else if (inShell && !inFile) {
    console.log(`  ${key}: from the shell environment (not in .env)`);
  } else if (inFile) {
    console.log(`  ${key}: from .env`);
  } else {
    console.log(`  ${key}: NOT SET`);
  }
}

const url = process.env.DATABASE_URL || fromFile.DATABASE_URL;
if (!url) {
  console.error('\nDATABASE_URL is not set anywhere. Nothing to test.\n');
  process.exit(1);
}

console.log('\n── how the URL parses ──────────────────────────────────────');

// Check the RAW string first. An unencoded '@' or '/' in the password shifts
// where the host begins, so by the time URL() has parsed it the password looks
// short and innocent while the hostname is nonsense. Detecting it afterwards is
// too late, which is exactly why this failure is so confusing: the error names
// the user and the credentials, and the real fault is three fields away.
const afterScheme = url.slice(url.indexOf('://') + 3);
const atCount = (afterScheme.match(/@/g) || []).length;
if (atCount > 1) {
  const creds = afterScheme.slice(0, afterScheme.lastIndexOf('@'));
  const pw = creds.slice(creds.indexOf(':') + 1);
  console.log('  ⚠ MORE THAN ONE "@" — the password contains an unencoded @.');
  console.log('    Everything after the FIRST @ is read as the host, so the');
  console.log('    password and server are both wrong. Prisma then reports');
  console.log('    "credentials are not valid", which points at the wrong thing.');
  console.log(`\n    Replace the password in DATABASE_URL with:  ${encodeURIComponent(pw)}`);
  console.log('    (pgAdmin takes the raw password — a URL cannot.)\n');
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error('  The value is not a valid URL at all.');
  process.exit(1);
}

const user = decodeURIComponent(parsed.username);
const pass = decodeURIComponent(parsed.password);
const NEEDS_ENCODING = /[@:/?#[\]%&= ]/;

console.log(`  host      ${parsed.hostname}:${parsed.port || 5432}`);
console.log(`  database  ${parsed.pathname.replace(/^\//, '')}`);
console.log(`  user      ${user}`);
console.log(`  password  ${pass.length} characters`);

if (NEEDS_ENCODING.test(pass)) {
  console.log('\n  ⚠ The password contains a character that is special in a URL.');
  console.log('    It must be percent-encoded inside DATABASE_URL, even though');
  console.log('    pgAdmin takes it raw — pgAdmin has separate fields, a URL does not.');
  console.log(`    Encoded, your password is:  ${encodeURIComponent(pass)}`);
  console.log('    @ → %40   : → %3A   / → %2F   ? → %3F   # → %23   %  → %25');
}
if (pass !== parsed.password) {
  console.log(`\n  Note: the raw value in the URL is percent-encoded already.`);
}

console.log('\n── connecting directly with pg (no Prisma) ─────────────────');
const { Client } = require('pg');
const client = new Client({
  host: parsed.hostname,
  port: Number(parsed.port || 5432),
  user,
  password: pass,
  database: parsed.pathname.replace(/^\//, ''),
});

client
  .connect()
  .then(() => client.query('select current_user, current_database()'))
  .then((r) => {
    const row = r.rows[0];
    console.log(`  ✓ connected as ${row.current_user} to ${row.current_database}`);
    console.log('\n  So the credentials are fine and the fault is in how the');
    console.log('  application is reading them — check the override warning above.\n');
    return client.end();
  })
  .catch((err) => {
    /*
     * Node aggregates the IPv6 and IPv4 attempts into an AggregateError whose
     * own `message` is empty, so printing only `err.message` shows a bare "✗"
     * — which reads like a mysterious auth failure and is in fact "nothing is
     * listening on that port".
     */
    const parts = [];
    if (err.message) parts.push(err.message);
    if (Array.isArray(err.errors)) {
      for (const e of err.errors) parts.push(`${e.code ?? ''} ${e.message ?? e}`.trim());
    }
    if (err.code) parts.push(`code ${err.code}`);

    const summary = parts.filter(Boolean).join(' | ');
    console.log(`  ✗ ${summary || `${err.constructor?.name ?? 'Error'} with no message`}`);

    // Last resort. An AggregateError can carry its detail somewhere none of the
    // checks above look, and a diagnostic that prints nothing is worse than no
    // diagnostic at all — it makes the reader doubt the tool rather than the
    // database.
    if (!summary) {
      console.log('\n  Raw error object:');
      console.log(
        require('node:util')
          .inspect(err, { depth: 3 })
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      );
    }

    const text = `${summary} ${err.code ?? ''}`;
    if (/ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENOTFOUND/.test(text)) {
      console.log('\n  Nothing answered on that host and port. This is not a password');
      console.log('  problem — the server is not running, or not listening there.');
      console.log('\n  On Windows:');
      console.log('    1. services.msc → postgresql-x64-<version> → is it Running?');
      console.log('    2. If it will not start, the usual cause is a bad edit to');
      console.log('       pg_hba.conf or postgresql.conf. Postgres refuses to start');
      console.log('       and logs why in:');
      console.log('         C:\\Program Files\\PostgreSQL\\<version>\\data\\log\\');
      console.log('       Open the newest file and read the last few lines.');
      console.log('    3. Check the port matches: postgresql.conf → port = 5432');
    }
    if (/password authentication failed/i.test(err.message)) {
      console.log('\n  The password genuinely does not match. In pgAdmin, against hms_db:');
      console.log("    ALTER ROLE hms_app WITH PASSWORD 'whatever-you-want';");
      console.log('  then put the same value in .env, percent-encoded if needed.');
    }
    if (/no pg_hba\.conf entry/i.test(err.message)) {
      console.log('\n  Reached the server but pg_hba.conf refused this user/host.');
      console.log('  pgAdmin may be connecting over a different host or method.');
    }
    console.log();
    return client.end().catch(() => {});
  });
