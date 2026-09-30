#!/usr/bin/env node
/**
 * Why a vendor console sign-in is failing.
 *
 *   npm run platform:check -- admin@example.com
 *
 *   set PLATFORM_PASSWORD=the-one-you-are-typing
 *   npm run platform:check -- admin@example.com
 *
 * WHY THIS EXISTS
 * ---------------
 * `platform.service.login` returns *Invalid email or password* for a missing
 * account, a deactivated one and a wrong password, and that is correct — the
 * alternative tells an attacker which vendor addresses are real. The cost is
 * that the one person who legitimately needs to know which of the three it is
 * gets the least useful sentence in the system, and no way to find out.
 *
 * Same shape as the hospital login refusal, and the same answer: the reason is
 * available to somebody with database access, and nowhere else.
 *
 * WHY IT CHECKS BOTH CONNECTIONS
 * ------------------------------
 * `create-platform-user.js` writes as **DATABASE_URL_ADMIN**; the API reads as
 * **DATABASE_URL**. If those two point at different databases, a reset reports
 * success and the account the API looks at never changes — which presents
 * exactly as "I reset the password and still cannot sign in", with nothing
 * anywhere saying why.
 *
 * On Windows that is not hypothetical. `localhost` resolves to `::1` and
 * `127.0.0.1` does not, so a machine running two Postgres instances — one on
 * IPv6, one on IPv4 — gives those two URLs two different servers while they
 * read as the same host. This prints what each connection actually reached.
 *
 * WHY IT WILL VERIFY A PASSWORD
 * -----------------------------
 * Only from `PLATFORM_PASSWORD`, only against the hash already stored, and only
 * to somebody holding the database's owner credentials — who could read the
 * hash and run argon2 themselves anyway. It is the difference between "the
 * credential is wrong" and "the credential is right and something downstream is
 * refusing it", which is the whole question here and is otherwise unanswerable.
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

const [rawEmail] = process.argv.slice(2);
if (!rawEmail) {
  console.error('\nusage: npm run platform:check -- <email>\n');
  process.exit(1);
}
const email = rawEmail.trim().toLowerCase();
const password = process.env.PLATFORM_PASSWORD || null;

function clientFor(url) {
  const p = new URL(url);
  return {
    label: `${decodeURIComponent(p.username)}@${p.hostname}:${p.port || 5432}/${p.pathname.replace(/^\//, '')}`,
    user: decodeURIComponent(p.username),
    client: new Client({
      host: p.hostname,
      port: Number(p.port || 5432),
      user: decodeURIComponent(p.username),
      password: decodeURIComponent(p.password),
      database: p.pathname.replace(/^\//, ''),
    }),
  };
}

/**
 * What one connection can see. Deliberately the same questions for both, so the
 * two reports can be held side by side — a difference between them IS the
 * finding, and it only shows up if the same thing was asked twice.
 */
async function inspect(url, role) {
  const { label, client } = clientFor(url);
  const out = { role, label, ok: false };

  try {
    await client.connect();
  } catch (err) {
    out.error = err.message;
    return out;
  }

  try {
    /*
     * The server actually reached, not the one the URL names. This is the line
     * that catches two Postgres instances behind `localhost` and `127.0.0.1`.
     */
    const { rows: who } = await client.query(
      `select current_database() as db,
              current_user       as who,
              inet_server_addr()::text as addr,
              inet_server_port() as port,
              (select setting from pg_settings where name = 'data_directory') as datadir`,
    );
    Object.assign(out, who[0]);

    // Does the table exist at all? A missing one means the migration has not
    // been applied here, which is a different problem from an absent row.
    const { rows: exists } = await client.query(
      `select to_regclass('public.platform_users') is not null as present`,
    );
    if (!exists[0].present) {
      out.error = 'platform_users does not exist — migrations have not been applied here';
      return out;
    }

    /*
     * `app.tenant_id` decides whether this table is visible at all. It carries
     * the INVERTED policy — visible only when no hospital is in scope — so a
     * session with a tenant set sees zero rows and nothing says why. Reported
     * rather than assumed, because on a fresh connection it should be unset and
     * an unexpected value here is the answer.
     */
    const { rows: scope } = await client.query(
      `select coalesce(nullif(current_setting('app.tenant_id', true), ''), '(unset)') as tenant`,
    );
    out.tenantScope = scope[0].tenant;

    const { rows: rls } = await client.query(
      `select relrowsecurity as enabled, relforcerowsecurity as forced
         from pg_class where oid = 'public.platform_users'::regclass`,
    );
    out.rls = rls[0];

    const { rows: all } = await client.query(`select count(*)::int as n from platform_users`);
    out.visibleRows = all[0].n;

    const { rows } = await client.query(
      `select id, email, "fullName", "isActive", "passwordHash", "updatedAt"
         from platform_users where lower(email) = $1`,
      [email],
    );
    out.account = rows[0] ?? null;
    out.ok = true;
    return out;
  } catch (err) {
    out.error = err.message;
    return out;
  } finally {
    await client.end().catch(() => {});
  }
}

(async () => {
  const adminUrl = process.env.DATABASE_URL_ADMIN;
  const appUrl = process.env.DATABASE_URL;

  if (!adminUrl || !appUrl) {
    console.error('\nBoth DATABASE_URL and DATABASE_URL_ADMIN must be set. See backend/.env.\n');
    process.exit(1);
  }

  const reports = [
    await inspect(adminUrl, 'owner  (what the reset script writes to)'),
    await inspect(appUrl, 'app    (what the API reads from)'),
  ];

  for (const r of reports) {
    console.log(`\n  ${r.role}`);
    console.log(`    ${r.label}`);
    if (r.error) {
      console.log(`    ✗ ${r.error}`);
      continue;
    }
    console.log(`    server        ${r.addr ?? 'local socket'}:${r.port}  db=${r.db}  as=${r.who}`);
    if (r.datadir) console.log(`    data dir      ${r.datadir}`);
    console.log(`    tenant scope  ${r.tenantScope}`);
    console.log(
      `    RLS           ${r.rls.enabled ? 'enabled' : 'DISABLED'}${r.rls.forced ? ', forced' : ''}`,
    );
    console.log(`    rows visible  ${r.visibleRows}`);
    console.log(
      r.account
        ? `    ${email} — ${r.account.fullName}, ${r.account.isActive ? 'active' : 'DEACTIVATED'}, changed ${r.account.updatedAt.toISOString()}`
        : `    ${email} — NOT FOUND`,
    );
  }

  /* ── the verdict, which is the point of running this ────────────────────── */

  const [owner, app] = reports;
  console.log('\n  ─────────────────────────────────────────────────────────\n');

  if (owner.ok && app.ok && (owner.datadir !== app.datadir || owner.db !== app.db)) {
    /*
     * The finding that explains "I reset it and still cannot sign in" without
     * anything looking broken. Reported first because every other check below
     * is meaningless once this is true.
     */
    console.log(
      '  ✗ THE TWO CONNECTIONS ARE DIFFERENT DATABASES.\n\n' +
        '    The reset script writes to one and the API reads the other, so a\n' +
        '    successful reset changes an account nobody signs in to.\n' +
        '    Make DATABASE_URL and DATABASE_URL_ADMIN name the same host and\n' +
        '    database — on Windows, `localhost` is IPv6 and `127.0.0.1` is not.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (app.ok && !app.account) {
    console.log(
      owner.account
        ? '  ✗ The API cannot see this account, though the owner connection can.\n\n' +
          '    That is RLS or a missing grant rather than a missing row. Run:\n' +
          '      npm run db:rls\n'
        : '  ✗ No such account. Create or reset it:\n' +
          '      set PLATFORM_PASSWORD=choose-something-long\n' +
          `      npm run platform:user -- ${email} "Your Name"\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (app.account && !app.account.isActive) {
    console.log(
      '  ✗ The account is deactivated, so login refuses whatever the password is.\n\n' +
        '    Re-running platform:user reactivates it as well as setting the password.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (!password) {
    console.log(
      '  The account exists and is active, so a refusal is the password.\n\n' +
        '    To check the exact one you are typing:\n' +
        '      set PLATFORM_PASSWORD=whatever-you-are-typing\n' +
        `      npm run platform:check -- ${email}\n`,
    );
    return;
  }

  const { verify } = require('@node-rs/argon2');
  const ok = await verify(app.account.passwordHash, password).catch(() => false);

  console.log(
    ok
      ? '  ✓ That password IS correct for this account.\n\n' +
        '    So the credential is not the problem. Check next:\n' +
        '      - Is the API running, and is it this backend? Its boot log names\n' +
        '        the database it connected to.\n' +
        '      - Are you on /platform rather than the staff login? They are two\n' +
        '        different sign-ins and the staff one will never accept this.\n' +
        '      - Three attempts a minute are allowed on that route. A fourth is\n' +
        '        a 429, which reads as a refusal.\n'
      : '  ✗ That password does not match the stored hash.\n\n' +
        '    Set a new one:\n' +
        '      set PLATFORM_PASSWORD=choose-something-long\n' +
        `      npm run platform:user -- ${email} "Your Name"\n`,
  );
  if (!ok) process.exitCode = 1;
})().catch((err) => {
  console.error(`\nFailed: ${err.message}\n`);
  process.exitCode = 1;
});
