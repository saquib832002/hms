# Upgrading a live deployment

One pass, start to finish, for the accumulated changes since the first
deployment. Follow it in order. `DEPLOY.md` is the *first* install; this is
every one after it.

---

## The whole thing on one screen

Two accounts are involved and their commands are **not** interchangeable — see
"Two users" below. Every block in this file is labelled with which one.

```
0.  Windows      confirm everything is committed AND pushed
1.  admin        dump the database, and prove the dump restores
2.  hms/admin    replay the migrations on a copy            ← recommended
3.  hms          add the new environment variables, test mail
4.  admin+hms    stop → pull → install → generate → migrate → rls → build → start
5.  hms          verify: health, pending-migration warning, one screen, one login
6.  admin        rollback, if it comes to that
```

Nothing carries state between blocks. Every block re-derives what it needs, so
it is safe to open a new terminal, take a break, or come back tomorrow.

---

## 0. What makes this one different

The first deployment created an empty database, so nothing could be lost.
**This one runs the accumulated migrations against real rows.**

How many is a question only the database can answer, and it is worth knowing
before you start rather than watching them go past:

```bash
# ── as hms ──
cd /opt/hms/app/backend && node prisma/admin-cli.js migrate status
```

That lists every migration not yet applied. Run it again at the end of §4 and
it should say the database is up to date.

**Every Prisma CLI command here goes through `admin-cli.js`, never `npx prisma`
directly.** The CLI reads only `DATABASE_URL`, which is `hms_app` — the
application role, deliberately unable to run DDL and not necessarily even able
to authenticate for this. Bare `npx prisma migrate …` fails with

```
P1000: Authentication failed … for `hms_app`
```

which reads as a wrong password and is a wrong *role*. The wrapper swaps in
`DATABASE_URL_ADMIN` for the duration of one call. `npx prisma generate` is the
one exception and is fine, because it reads the schema file and opens no
connection.

Three of the four ways this can go wrong are avoidable and are what §1–§3 are
for:

1. **A migration fails halfway.** Postgres runs each in a transaction, so a
   failure rolls that one back — but Prisma marks it *failed* and refuses to
   proceed until you tell it what happened. §6 covers the recovery.
2. **Most of them create tables carrying `tenantId`, and a migration gives
   none of them an RLS policy.** A new table without one is readable across
   hospitals by anything reaching the database as `hms_app`. `npm run db:rls`
   is what applies them and it is **not optional** — see §4, step 6.
3. **The generated Prisma client is rebuilt separately from the database.**
   `npm ci` does not run `prisma generate` and neither does `nest build`. Skip
   it and the API queries columns the client does not know about, or believes in
   columns the database does not have. This project has three incident reports
   that were all this one command.
4. **Something is broken in a way no test can see.** Every first live run in
   this project has found one. §5 is the looking.

### Two users, and the commands are not interchangeable

| | what it does |
|---|---|
| **your admin user** (the one you `ssh` in as) | anything with `sudo`: systemd, nginx, `psql` as postgres, `createdb`, `pg_dump` |
| **`hms`** (the service account) | anything under `/opt/hms/app`: `git pull`, `npm ci`, `prisma generate`, migrations, `db:rls`, builds |

Switch with `sudo -iu hms`, and leave with `exit`. If a prompt says
`[sudo] password for hms:` you are in the wrong account for that command —
`hms` has no sudo and that is deliberate.

---

## 1. Back up, and prove the backup restores

A dump you have never restored is a hope, not a backup. This is the only step
in this file that cannot be repeated later.

Run as **admin**:

```bash
sudo -u postgres pg_dump --format=custom --file=/tmp/hms-pre-upgrade.dump hms_db
ls -lh /tmp/hms-pre-upgrade.dump
```

Now prove it. Restore into a scratch database and count something:

```bash
# ── as admin ──
# Owned by hms_owner, NOT postgres. On PostgreSQL 15+ a non-owner gets no
# CREATE on schema `public`, and the migrations would fail with
#   P3018 … permission denied for schema public
sudo -u postgres createdb --owner=hms_owner hms_db_rehearsal
sudo -u postgres psql -d hms_db_rehearsal -c 'ALTER SCHEMA public OWNER TO hms_owner'

sudo -u postgres pg_restore --dbname=hms_db_rehearsal --no-owner --role=hms_owner \
  /tmp/hms-pre-upgrade.dump

sudo -u postgres psql -d hms_db_rehearsal -c \
  'select (select count(*) from tenants) as tenants,
          (select count(*) from users)   as users,
          (select count(*) from patients) as patients'
```

Those three numbers must match production. Check:

```bash
# ── as admin ──
sudo -u postgres psql -d hms_db -c \
  'select (select count(*) from tenants) as tenants,
          (select count(*) from users)   as users,
          (select count(*) from patients) as patients'
```

If they match, you have a backup **and** a copy to rehearse on. If they do not,
stop here — nothing below is safe.

Copy the dump off the box as well. A backup on the same disk as the database
survives a bad migration and nothing else:

```bash
# from your Windows machine
scp you@your-server:/tmp/hms-pre-upgrade.dump .
```

---

## 2. Replay the migrations on the copy

Recommended, not required. It converts "the migrations failed on production" into
"the migrations failed on a throwaway database", which is the same information
at a fraction of the cost.

### 2a. Prove both sets of credentials first

Two roles connect, and the split is the whole of tenant isolation:

| `.env` key | role | used by |
|---|---|---|
| `DATABASE_URL` | `hms_app` | the running API. Non-superuser, so RLS applies to it. |
| `DATABASE_URL_ADMIN` | `hms_owner` | migrations, `db:rls`, `db:constraints`, the seed. |

If either is wrong you find out several steps later as a `P1000`, which reads
like a wrong password and is sometimes a wrong *role*. Check both now, and note
which name the error gives you:

```bash
# ── as hms ──
cd /opt/hms/app/backend && npm run db:env
```

It connects as each, and where one fails it separates the four causes, because
the fix differs for each and they all present as the same P1000:

- **the wrong role** — a bare `npx prisma …` hands `hms_app` a migration to run;
- **a duplicate definition** of the key in `.env`. This is the nastiest:
  **dotenv keeps the first assignment and systemd's `EnvironmentFile` keeps the
  last**, so the running API and every script in this directory read the same
  file and disagree about the password. It is the usual explanation for "the
  site works but this check fails";
- **a password containing `@`, `:`, `/`, `#`, `?` or `[]`** — these end a
  component of a URL, so unencoded they reparse the string into a different
  user, host or database. Percent-encode them (`@` → `%40`);
- **a genuinely wrong password.**

It prints the password's length and never the password, so the output is safe
to paste.

Reset whichever failed, as **admin** — changing a Postgres role needs sudo,
which `hms` deliberately does not have:

```bash
# ── as admin ──
sudo -u postgres psql -c "ALTER ROLE hms_app   WITH PASSWORD 'pick-a-real-one'"
sudo -u postgres psql -c "ALTER ROLE hms_owner WITH PASSWORD 'pick-another'"
```

Then put the same values into `.env` **as `hms`**, and re-run the check above:

```bash
# ── as hms ──
sudo -iu hms          # if you left
nano /opt/hms/app/backend/.env
```

Type the passwords you just set. Do not paste a placeholder — an earlier
version of this file contained `hms_owner:PASSWORD@` in a command that
otherwise looked ready to run, and it was pasted verbatim.

If you changed `DATABASE_URL`, the running API is still on the old value until
it restarts, which §4 does anyway.

> `hms_app` is created by `npm run db:rls` with the password `admin` if the role
> does not already exist — a development default that should not survive onto a
> production box. If the check above passes with `admin` in the URL, change it
> here while you are in the file.

### 2b. Get the newest code onto the server

Everything below uses scripts that arrive with this pull. Do it before, not
during.

```bash
# ── as hms ──
cd /opt/hms/app
git pull
git log --oneline -1                 # note this commit; §6 rolls back to it
cd backend && npm ci
cd ../web  && npm ci
ls -l ../backend/prisma/rehearse-env.js     # must exist now
```

### 2c. Run the migrations against the copy

`rehearse-env.js` derives the copy's two connection strings from the real ones
in `.env`, so there is nothing to type and no way to aim it at production by
accident. **Re-run the `eval` at the top of every block** — shell variables do
not survive `exit`, a second terminal, or a break.

```bash
# ── as hms ──
cd /opt/hms/app/backend
eval "$(node prisma/rehearse-env.js)"
echo "$REHEARSE_APP"          # must end in hms_db_rehearsal — if blank, the eval failed
```

If that echoes nothing, the script is not there: your `git pull` in 2b did not
run, or ran in the wrong directory. Nothing below will work until it prints.

```bash
# ── as hms ──
cd /opt/hms/app/backend
eval "$(node prisma/rehearse-env.js)"

npx prisma generate                                    # no database involved

DATABASE_URL_ADMIN="$REHEARSE_ADMIN" npm run db:migrate
DATABASE_URL_ADMIN="$REHEARSE_ADMIN" npm run db:rls
DATABASE_URL_ADMIN="$REHEARSE_ADMIN" npm run db:rls:verify
DATABASE_URL_ADMIN="$REHEARSE_ADMIN" npm run db:constraints
```

Only `DATABASE_URL_ADMIN` is overridden, and that is the whole point: all three
of those are schema changes and run as the owner. `admin-cli.js` substitutes it
for `DATABASE_URL` inside the one call, so `hms_app` is never asked to do DDL.

`db:migrate` should end `All migrations have been successfully applied`.
`db:rls` prints every table it secured and self-checks isolation in both
directions — read its summary rather than assuming it. `db:constraints`
verifies its own two indexes exist and fails if they do not.

Then boot the API against the copy and open one screen:

```bash
# ── as hms ──
cd /opt/hms/app/backend
eval "$(node prisma/rehearse-env.js)"
npm run build
DATABASE_URL="$REHEARSE_APP" DATABASE_URL_ADMIN="$REHEARSE_ADMIN" \
  PORT=3100 node dist/main
```

In a second terminal:

```bash
# ── as hms ──
curl -s localhost:3100/api/v1/health
```

`Ctrl-C` the API when you are done. **Nothing about this touched production** —
different database, different port, and the live `hms-api` never stopped.

Drop the copy once you are satisfied:

```bash
# ── as admin ──
sudo -u postgres dropdb hms_db_rehearsal
```

---

## 3. The new environment variables

Add to `/opt/hms/app/backend/.env`, as **hms**. The API boots without them;
what it loses is password-reset email and the links that offer it.

```bash
# The public origin of the web app. Used to build reset links.
#
# Configured, never taken from the request's Host header: a link built from a
# header is one an attacker aims at their own server by sending
# `Host: evil.example`, and the victim clicking it hands over a live token.
WEB_URL="https://hms.example.com"

# smtp delivers; log writes to the API log and delivers nothing; unset sends
# nothing and hides the reset links.
#
# ⚠ In production, `log` counts as unavailable and the links stay hidden —
#   telling somebody to read a server log they cannot see is worse than not
#   offering the link. So production is smtp, or nothing.
MAIL_TRANSPORT="smtp"
MAIL_FROM="OneCare HMS <no-reply@example.com>"
SMTP_HOST="smtp.example.com"
SMTP_PORT=587
SMTP_SECURE="false"          # true ONLY on 465. On 587 this must be false.
SMTP_USER="no-reply@example.com"
SMTP_PASS="…"

PASSWORD_RESET_TTL_MINUTES=30
PLATFORM_RESET_TTL_MINUTES=15
PLATFORM_RESET_GRANT_COOLDOWN_MINUTES=60
```

Two things to check while you are in the file:

**`NODE_ENV=production` refuses to start on development secrets.**
`validateEnv` rejects a `JWT_ACCESS_SECRET` shorter than 32 characters or
containing `dev-only`. Generate real ones with `openssl rand -hex 32`, twice,
and they must differ from each other. Changing them signs everybody out — a
real cost on an upgrade, worth paying only if the current values were ever
development ones.

**`CORS_ORIGINS` must list the public origin**, or every browser call fails
with nothing worth reading in the console.

Then test mail before you trust it, and before restarting anything:

```bash
# ── as hms ──
cd /opt/hms/app/backend && npm run mail:test -- you@example.com
```

It authenticates, sends, prints the server's queue id, and reports what the
sending domain publishes for SPF, DKIM and DMARC. **Accepted is not
delivered.** If the queue id appears and the message does not, the problem is
downstream of this system and the next place to look is your mail host's
delivery log for that id — not the API.

---

## 4. The upgrade

Take the site down. It is a few minutes, and it avoids serving a request
against a half-migrated schema.

**Step 1 — a fresh dump.** The one from §1 is hours old by now, and those hours
are real appointments.

```bash
# ── as admin ──
sudo -u postgres pg_dump --format=custom --file=/tmp/hms-now.dump hms_db
ls -lh /tmp/hms-now.dump
```

**Step 2 — stop both services.**

```bash
# ── as admin ──
sudo systemctl stop hms-web hms-api
```

**Step 3 — get the code.** Skip if you already pulled in §2b; run
`git log --oneline -1` to check.

```bash
# ── as hms ──
cd /opt/hms/app
git pull
git log --oneline -1
```

**Step 4 — install.** `package.json` changed on both sides (`nodemailer` is
new), so `npm ci` on each.

```bash
# ── as hms ──
cd /opt/hms/app/backend && npm ci
cd /opt/hms/app/web     && npm ci
```

**Step 5 — regenerate the Prisma client.** Separate command, and the one most
often skipped.

```bash
# ── as hms ──
cd /opt/hms/app/backend && npx prisma generate
```

**Step 6 — migrate, then apply RLS.** In this order, and do not stop after the
first.

```bash
# ── as hms ──
cd /opt/hms/app/backend
npm run db:migrate
npm run db:rls
npm run db:rls:verify        # proves the previous line actually covered everything
npm run db:constraints
```

If `db:rls:verify` reports `Missing script`, this pull predates it. The same
check runs as plain SQL and needs nothing from the repo — it returns **only the
broken tables**, so no rows is the passing result:

```bash
# ── as admin ──
sudo -u postgres psql -d hms_db <<'SQL'
select c.relname                as table_without_isolation,
       c.relrowsecurity         as rls_enabled,
       c.relforcerowsecurity    as rls_forced,
       (p.policyname is not null) as has_policy
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p
       on p.schemaname = 'public' and p.tablename = c.relname
      and p.policyname = 'tenant_isolation'
where n.nspname = 'public' and c.relkind = 'r'
  and exists (select 1 from information_schema.columns col
              where col.table_schema = 'public'
                and col.table_name   = c.relname
                and col.column_name  = 'tenantId')
  and (p.policyname is null or not c.relrowsecurity or not c.relforcerowsecurity)
order by 1;
SQL
```

`(0 rows)` means every table carrying `tenantId` is scoped, enabled and forced.
Anything listed is readable across hospitals right now, and `npm run db:rls` is
the fix. Verified against a real PostgreSQL 18.4 on tables missing a policy,
missing `FORCE`, correct, and global — it lists exactly the first two.

**`Database schema is up to date` is not the same claim as isolated.**
`migrate deploy` creates tables and cannot express a policy, so a database can
be fully migrated and have ten tables readable across hospitals — and nothing
in the migration output says so, because the step that was skipped is the one
with no output. `db:rls:verify` reads `pg_policies` and `pg_class` and fails on
any table carrying `tenantId` without a policy, without `ENABLE`, or without
`FORCE`. It derives that expectation from the column rather than from a list,
so a table nobody remembered still gets checked.

`db:rls` is idempotent: it drops and recreates the policy on every table it
knows about, so running it is always correct and never needs deciding about.
Most of these migrations create tenant-scoped tables, two create platform
tables carrying the *inverted* policy, and a migration gives none of them a
policy. Read its output — it lists what it secured and proves isolation in both
directions against a row it inserts and rolls back.

**Step 7 — build.** Remove `.next` first: the brand colours are baked into the
CSS at build time from `tailwind.config.ts`, and a cached build keeps the old
palette.

```bash
# ── as hms ──
cd /opt/hms/app/backend && npm run build
cd /opt/hms/app/web && rm -rf .next && npm run build
```

**Step 8 — start.**

```bash
# ── as admin ──
sudo systemctl start hms-api
sleep 5
sudo systemctl status hms-api --no-pager
sudo systemctl start hms-web
sudo systemctl status hms-web --no-pager
```

---

## 5. Verify, in this order

Stop at the first thing that is wrong. Each step rules out a different cause, so
a later one tells you little if an earlier one failed.

**1 — the API is up and the database is behind nothing.**

```bash
# ── as hms or admin ──
curl -s localhost:3000/api/v1/health
```

Expect `status: "ok"`, `database: "up"`, `passwordResetAvailable: true` and
`passwordResetDelivery: "smtp"`.

**2 — no pending-migration warning in the boot log.** `PrismaService` compares
the migrations on disk against `_prisma_migrations` at start and names any that
are missing. It warns rather than refusing to boot, so this will not stop the
API — you have to look.

```bash
# ── as admin ──
sudo journalctl -u hms-api --since "10 minutes ago" | grep -i "migration\|Mail:\|ERROR"
```

`Mail: SMTP verified` means the server accepted the API's credentials at boot.
A verification failure here is the single most useful line in this whole
upgrade, and nothing else reports it.

**3 — the web app renders and the brand is right.** Open the site. The wordmark
should read **OneCare HMS** in three colours — `One` blue, `Care` near-black,
`HMS` red. All-black means step 7's `rm -rf .next` did not happen.

**4 — one real login, on one real hospital.** Then open a screen that reads
patient rows — the patients list, or a doctor's queue. This is the step that
exercises RLS against real data, and it is the one no test in the repo can do.

**5 — the reset link is offered and works.** "Forgot your password?" should
appear on both the hospital login and `/platform`. Request one, read the mail,
set a password, sign in with it. If the link is absent, `passwordResetDelivery`
in step 1 was not `smtp`.

**6 — the vendor console still signs in.**

```bash
# ── as hms ──
cd /opt/hms/app/backend && npm run platform:check
```

---

## 6. If it goes wrong

**A migration failed.** Prisma marks it failed and refuses to run anything
else. Postgres already rolled that migration back, so the database is
consistent — you are telling Prisma what it cannot know:

```bash
# ── as hms ──
cd /opt/hms/app/backend
node prisma/admin-cli.js migrate status                    # which one
node prisma/admin-cli.js migrate resolve --rolled-back "20260929120000_password_reset_tokens"
```

Substitute the name `status` reported. Then fix the cause and re-run
`npm run db:migrate`. Do **not** use `--applied` — that tells Prisma the work
was done when it was not, and every later migration then runs against a schema
that is missing a piece.

**`db:rls` failed with `must be able to SET ROLE "hms_definer"`** (or
`permission denied to grant role "hms_definer"`). Two SECURITY DEFINER
functions are handed to `hms_definer` so login can resolve an email to a tenant
before any tenant is in scope, and `ALTER FUNCTION … OWNER TO` requires the
connecting role to be able to *become* that role — which is stronger than
membership, and is what `hms_owner` is missing. Grant it once as a superuser:

```bash
# ── as admin ──
sudo -u postgres psql -d hms_db <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_definer') THEN
    CREATE ROLE hms_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT hms_definer TO hms_owner;
SQL
```

Then re-run `npm run db:rls` as `hms`. It is safe whether or not the failed run
left the role behind, and it works against the older copy of
`tenant-isolation.sql` as well as the current one — verified against a real
PostgreSQL 18.4 in both states.

`hms_definer` is NOLOGIN, owns nothing but those two functions, and is named in
exactly one `FOR SELECT` policy on `users`. It is deliberately **not** a
BYPASSRLS role: that would exempt it from every table in the database to solve
a problem about one.

**Anything else — restore.** The dump from §4 step 1 is the one to use; it is
the newest.

```bash
# ── as admin ──
sudo systemctl stop hms-web hms-api
sudo -u postgres dropdb hms_db
sudo -u postgres createdb --owner=hms_owner hms_db
sudo -u postgres psql -d hms_db -c 'ALTER SCHEMA public OWNER TO hms_owner'
sudo -u postgres pg_restore --dbname=hms_db --no-owner --role=hms_owner /tmp/hms-now.dump
```

Then put the code back to where it was — the commit you noted in §4 step 3 —
and rebuild:

```bash
# ── as hms ──
cd /opt/hms/app
git log --oneline -5                 # find the commit from before the pull
git checkout <that-commit>
cd backend && npm ci && npx prisma generate && npm run build
cd ../web  && npm ci && rm -rf .next && npm run build
```

```bash
# ── as admin ──
sudo systemctl start hms-api hms-web
```

**Run `npm run db:rls` after any restore**, as `hms`, before starting the
services. `pg_restore` carries the policies and the table grants, but the
`hms_app` and `hms_definer` roles are *cluster*-level and are not in the dump —
they survive a `dropdb`, which is why this usually looks fine, and they are
granted `CONNECT` on a database by name, which the new database does not have.
The symptom is a `P1000` from the API that reads as a wrong password. `db:rls`
is idempotent, creates each role only if it is missing, and re-grants
everything, so it is always safe to run and there is no case where skipping it
helps.

---

## 7. What this does not deploy, and what is still open

**The mobile app is separate.** It ships as an AAB through the Play Console —
[`DEPLOY-ANDROID.md`](DEPLOY-ANDROID.md). Nothing here affects an installed
phone app, and an old app against the new API is fine: no endpoint was removed
in this release.

**The Android package id is unchanged** (`com.sawera.myhospital*`) despite the
rename to OneCare. Changing an `applicationId` does not rename an app, it
publishes a second one, and every existing install stops receiving updates. The
URL scheme moved to `onecare*`, which nothing depends on.

**Things this release leaves genuinely open**, each recorded at more length in
[`CLAUDE.md`](CLAUDE.md):

- **No email address is ever verified.** An account created with a typo has a
  reset path that silently goes to somebody else's mailbox. Self-service reset
  makes that reachable by anybody rather than only by an administrator, and it
  is the gap most worth closing before real customers.
- **The vendor console's emailed recovery is the weakest link by
  construction.** A mailbox is now sufficient to take a console account, and a
  console account can open a break-glass grant against any hospital. The
  hour-long cooling-off delays the part that reaches patient data; it does not
  prevent it. TOTP on `PlatformUser` is the real answer and does not exist.
- **The reset notification goes to every *other* console account**, so a
  one-person vendor gets none. It is logged and nothing else.
- **Nothing sweeps expired reset tokens.** Expiry is checked per request so a
  dead link never works, but the table only grows.
- **Neither client has ever rendered against production.** The web app has run
  against a live API in development only; the mobile app has never run on a
  handset at all.
