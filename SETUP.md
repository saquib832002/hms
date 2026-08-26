# Running it on your machine

First-time setup, against the PostgreSQL you already have installed on Windows.
Roughly ten minutes, most of it `npm install`.

---

## Before anything: what you were running

`http://localhost:3000/api/health` answered, and that was misleading. It was
`backend/server.js` — an Express stub predating the project that opened its own
connection to `SaweraDB` and ran `SELECT NOW()`. It shared a port with the real
API and nothing else. `package.json` pointed `npm run dev` at it, so the NestJS
application had never actually started.

It has been deleted, along with the `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`
lines in `.env` that only it read. The correct health check is:

```
http://localhost:3000/api/v1/health   →   {"status":"ok","database":"up"}
```

Note `/api/v1/`. If you get `{"ok":true,"time":...}` instead, an old `node`
process is still holding the port — kill it and start again.

---

## 1. Create the database

The project gets a database of its own on your existing server, so nothing here
can touch `SaweraDB`. From **SQL Shell (psql)** or pgAdmin's query tool:

```sql
CREATE DATABASE hms_db;
```

From PowerShell instead, if `psql` is on your PATH:

```powershell
psql -U postgres -c "CREATE DATABASE hms_db;"
```

`backend/.env` is already pointed at it:

```
DATABASE_URL="postgresql://postgres:root@localhost:5432/hms_db?schema=public"
```

Change `root` if that isn't your `postgres` password. A password containing
`@ : / ?` must be percent-encoded — `p@ss` becomes `p%40ss`.

> Do not create the tables by hand, and do not point this at `SaweraDB`.
> Prisma owns this schema; step 2 creates all 24 tables from
> `prisma/schema.prisma`, and it expects the database to be empty.

---

## 2. Install, create the tables, load dummy data

```powershell
cd C:\Najmus\ReactApp\hospital-management-system\backend
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run db:rls
npm run seed
```

What each step does, because the middle three are the ones you asked about:

| Command | Effect |
|---|---|
| `prisma generate` | Builds the typed client from the schema. No database contact. |
| `prisma migrate dev --name init` | **Creates the tables.** Writes `prisma/migrations/<timestamp>_init/migration.sql`, applies it, and records it in `_prisma_migrations`. |
| `npm run db:rls` | Creates the `hms_app` role and the Row-Level Security policies. **Prisma cannot express these**, so they are not in the migration and will not be recreated for you. |
| `npm run seed` | Inserts **two** dummy hospitals — St Mary's and Riverside — each with departments, staff, ~40 patients, wards, a medicine catalogue and invoices. |

`npm run db:setup` runs all three together.

> **Do not skip `db:rls`, and do not run the API as `postgres`.**
>
> RLS is what keeps one hospital out of another's records, and **a superuser
> bypasses RLS entirely** — `postgres` included. `.env` therefore has two URLs:
> `DATABASE_URL` (the `hms_app` role, used by the API) and `DATABASE_URL_ADMIN`
> (used only by migrations and the seed, which legitimately write across
> hospitals). Set a real password for `hms_app` in both the SQL file and `.env`.

The migration folder is generated on your machine and should be **committed** —
it is the record of how the schema reached this state, and how any other machine
reproduces it. Every later schema change repeats `prisma migrate dev --name
<what_changed>`; on a server you run `prisma migrate deploy`, which applies
existing migrations and never generates new ones.

Prisma will print a deprecation warning about `package.json#prisma`. Harmless on
Prisma 6 — see the note in `backend/README.md` before upgrading to 7.

### Checking the tables landed

```powershell
npx prisma studio          # browser view of every table
```

or in psql:

```sql
\c hms_db
\dt
```

24 tables, plus `_prisma_migrations`.

---

## 3. Start the API

```powershell
npm run dev
```

```
http://localhost:3000/api/v1/health   →   {"status":"ok","database":"up"}
```

`"database":"down"` means the URL, password or database name in `.env` is wrong;
the API deliberately starts anyway and reports it rather than crashing.

### Log in

Every seeded account uses `ChangeMe123!`:

Two hospitals are seeded, each with a full set of staff:

| Role | St Mary's | Riverside |
|---|---|---|
| ADMIN | `admin@demo.test` | `admin@riverside.test` |
| DOCTOR | `doctor@demo.test` | `doctor@riverside.test` |
| NURSE | `nurse@demo.test` | `nurse@riverside.test` |
| RECEPTIONIST | `reception@demo.test` | `reception@riverside.test` |
| PHARMACIST | `pharmacy@demo.test` | `pharmacy@riverside.test` |
| BILLING_STAFF | `billing@demo.test` | `billing@riverside.test` |

Sign in as `doctor@demo.test` and then `doctor@riverside.test` and you should
see two entirely separate hospitals — different patients, wards and invoices,
from one database.

Email is unique **per hospital**, so the same address can exist at both. Login
resolves an unambiguous address on its own; if one exists at two hospitals, send
`"hospital": "riverside"` (the tenant slug) with the login request. It refuses to
guess rather than telling an attacker where an address is registered.

---

## 4. Start the web app

A second terminal — the API must stay running:

```powershell
cd C:\Najmus\ReactApp\hospital-management-system\web
npm install
npm run dev
```

`http://localhost:3001` — port 3001 deliberately, since the API holds 3000.

There is no API URL to configure. The web app calls `/api/v1/...` relative, and
`next.config.mjs` proxies that to `http://localhost:3000`. That proxy is
load-bearing, not a convenience: the refresh token is an httpOnly cookie with
`SameSite=Strict`, and a browser on `localhost:3001` will not send it to
`localhost:3000`. Without the rewrite, silent refresh fails and every page
reload bounces you to the login screen. Override with `API_ORIGIN` if the API
ever moves.

Log in as `reception@demo.test`. The navigation is built from your role, so each
account shows a different application.

**This is the first time the web app has run against a live API.** Every screen
is covered by unit tests and none has rendered against real data. Expect to find
things here.

---

## 5. Mobile (optional)

```powershell
cd C:\Najmus\ReactApp\hospital-management-system\mobile
npm install
npx expo start
```

A phone cannot resolve `localhost` — that means the phone itself. Find your
machine's LAN address with `ipconfig` (the IPv4 under your active adapter, e.g.
`192.168.1.24`) and set it in **`mobile/app.json`**, under `expo.extra`:

```json
{
  "expo": {
    "extra": { "apiOrigin": "http://192.168.1.24:3000" }
  }
}
```

Origin only — no `/api/v1`; the client appends that itself. It currently reads
`http://192.168.1.10:3000`, a placeholder that is almost certainly not your
machine. Then add the same
origin to `CORS_ORIGINS` in `backend/.env` and restart the API. Phone and
computer must share a network, and Windows Firewall will prompt for Node on the
first connection — allow it on private networks.

**Mobile has never run on hardware.** The offline outbox, the biometric lock and
the 15-minute idle timeout are all unexercised outside unit tests.

---

## Deploying a change after this

You only repeat what the change touched:

| Changed | Do |
|---|---|
| Any `.ts` file | Nothing. `npm run dev` watches and reloads. |
| `prisma/schema.prisma` | `npx prisma migrate dev --name <what_changed>` — regenerates the client and applies the change. |
| `.env` | Restart the API; it reads env only at boot. |
| `package.json` | `npm install`. |

For a production build: `npm run build` then `npm run start:prod`. Note that
`validateEnv` refuses to boot with `NODE_ENV=production` while the JWT secrets
still contain `dev-only` — generate real ones with `openssl rand -hex 32`.

---

## If it does not work

**`P1000: Authentication failed`** — the password in `DATABASE_URL` is wrong, or
needs percent-encoding.

**`P1001: Can't reach database server`** — PostgreSQL isn't running. Check
`services.msc` for `postgresql-x64-*`, or that it is on port 5432.

**`P1003: Database does not exist`** — step 1 was skipped.

**`Environment variable not found: DATABASE_URL`** — you are not in `backend/`,
or the file is named `.env.txt` (Windows hides known extensions; check with
`dir` in the folder).

**`localhost:3001` says "This site can't be reached"** — nothing is listening.
Almost always `npm install` hasn't been run in `web/`, so `npm run dev` had no
`next` binary to start and exited immediately. Check for `web/node_modules`, run
`npm install` there, and read the output of `npm run dev` — it should end with
`✓ Ready in ...`. The API on 3000 running does not mean 3001 is running; they
are two separate servers in two separate terminals.

**Port 3000 in use** — the old stub, most likely:

```powershell
netstat -ano | findstr :3000
taskkill /PID <pid> /F
```

**`prisma migrate dev` wants to reset the database** — it found tables it has no
migration for. On a fresh `hms_db` that shouldn't happen; if you created tables
by hand in step 1, drop and recreate the database.

---

## The rule that still applies

From `CLAUDE.md`: **dummy data only, locally.** This setup — a password of
`root`, dev JWT secrets in git, an unencrypted local database — is fine for
seeded fake patients and is not suitable for one real one. The moment actual
patient data is involved, even a small pilot, it moves to BAA-covered hosting.
