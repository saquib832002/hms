# Hospital Management System — Project Context

Decisions carried over from planning conversations. Read this before making architectural changes.

## Stack

```
Next.js (Web)  ─┐
                 ├──► NestJS API (single backend) ──► PostgreSQL 16
React Native ────┘         + Prisma ORM
(Expo, Mobile)
```

- **Database: PostgreSQL** — chosen over MySQL deliberately. Rationale: native Row-Level Security, JSONB, stricter constraints, and no `0000-00-00`-style permissive dates. Migrating MySQL→Postgres later would mean paying twice — once for the data move, again to retrofit the RLS-based access control that was the whole point.
- **Backend: NestJS + Prisma** — one API serving both web and mobile. Business logic, RBAC, and audit logging are written once, here.
- **Web: Next.js** with shadcn/ui.
- **Mobile: React Native / Expo** — points at the dev machine's LAN IP (e.g. `http://192.168.1.x:3000`) for on-device testing.
- **Local dev: Docker Compose** for Postgres — `docker-compose.yml` still defines Postgres 16 (`hms_db` / `hms_admin`) and is the reproducible path. On this machine the app is instead pointed at an **already-installed local PostgreSQL**, in a database named `hms_db` of its own, which is why `DATABASE_URL` reads `postgres@localhost/hms_db`. The database is never shared with anything else on that server. Whichever is used, Prisma owns the schema and `prisma migrate` is the only thing that creates tables. See [`SETUP.md`](SETUP.md).

## Non-negotiable architecture rules

1. **No direct frontend→database access.** Every client goes through the NestJS API. No BaaS-style auto-generated data APIs.
2. **RBAC is enforced server-side.** Frontend menus hide things for usability; they are never the security boundary. Assume any client can call any endpoint directly.
3. **Audit logging lives in one global place**, not scattered through endpoints. Every PHI access logged consistently: who, what, when, where (`AuditLog` model). Implemented as a NestJS **interceptor**, not middleware — middleware runs before guards and so has no authenticated user to log. Failures are logged as well as successes, but **not in the interceptor** — a denied request never reaches one. Successes: `AuditInterceptor`. Failures: `AllExceptionsFilter`. See "What the live run found" below; this is the one rule that was wrong in practice for six phases.
4. **Business rules belong in the backend** (e.g. "a prescription can't be edited after it's dispensed"), never duplicated in web + mobile.
5. **Required NestJS middleware:** auth (JWT validation), audit logging, rate limiting (esp. login + patient lookup), error handling that never leaks a stack trace containing PHI.
6. **Dummy data only, locally.** The moment real patient data is involved — even a small pilot — it moves to BAA-covered hosting. Local dev is unrestricted; production with real PHI is not.
7. **HL7/FHIR is deferred.** Needed only when integrating with labs, clearinghouses, pharmacies, or other hospitals. Not an MVP concern, but don't architect in a way that forecloses it.

## UI philosophy

**Role-based UI, not one giant menu.** Each role sees only its own navigation, built after login from its role. This mirrors backend RBAC exactly and satisfies HIPAA minimum-necessary-access — a receptionist shouldn't *see* clinical notes, not merely be blocked from editing them.

**Web = desktop application feel.** This is an internal operational tool (think Epic, Linear, a banking back-office), not a marketing site:

- Persistent sidebar navigation — staff live here for 8-hour shifts
- Dense, data-table-heavy layouts optimised for scanning many records
- Multi-panel views (list left, detail right) without full page reloads
- Keyboard shortcuts and fast global search — power users repeat actions hundreds of times daily
- Minimal scrolling per screen

**Mobile = curated task subset, not feature parity.** Aim for *task* parity per role, not feature parity. Mobile is for quick lookups, on-the-go actions (bedside vitals, approving a prescription between rounds), notifications, and simple entry. Billing reconciliation, report generation, bulk entry, and multi-panel history review stay web-only.

**Exception:** any public patient-facing page (book an appointment, hospital info) stays light and marketing-style. The dense treatment is for internal staff tools only.

## Current state

**All six phases complete.** The backend has been verified end-to-end against a real PostgreSQL database — see "What the live run found" below, which is where the two most serious bugs in the project surfaced. Mobile serves doctors, nurses, pharmacists and admins but **has never run on a device**, and the web app has never rendered against a live API. See [`PLAN.md`](PLAN.md) for phasing and the per-app READMEs to run them.

- `docker-compose.yml` — Postgres 16, db `hms_db`, user `hms_admin`, port 5432
- `backend/` — NestJS 11 + Prisma 6. Auth (rotating refresh tokens, Argon2, login lockout), `RolesGuard`, global audit interceptor, PHI-safe exception filter, rate limiting, seed script. Feature modules: patients, doctors, appointments, medical-records, prescriptions, me/queue, wards, admissions, vitals, medications, medicines, pharmacy, billing, users, departments, admin, notifications, audit. 348 tests, no DB required.
- `web/` — Next.js 15 App Router + Tailwind. Login, role-derived shell, ⌘K search, reception (check-in, booking, registration with duplicate detection, patients), doctor (queue, records, prescriptions), audit browser, nurse ward board (admit/transfer/discharge/drug chart), vitals history, medication round, pharmacy dispensing and inventory, billing invoices/payments/aging, admin dashboard/users/departments, forced password change, 15s live refresh. 74 tests.
- `mobile/` — Expo/React Native. Doctor: queue, patient summary, prescribe. Nurse: ward board, bedside vitals, medication round. Pharmacist: read-only queue and stock alerts. Admin: read-only aggregate overview. Refresh token in expo-secure-store, 15-min idle biometric lock, **durable offline outbox** with idempotent replay. 91 tests. **Never executed on hardware — first device run is the real review.**

### Multi-tenancy: the database enforces it, not the queries

The system serves many hospitals from one database. Every model holding
patient-derived data carries `tenantId`, and every one of those tables has a
Postgres RLS policy keyed on it. Design and rationale: [`docs/adr-001-multi-tenancy.md`](docs/adr-001-multi-tenancy.md).

The application also filters by tenant — but that is not what makes it safe. A
forgotten `where` returns **zero rows instead of another hospital's records**,
because the policy, not the query, decides what is visible. Verified against a
live database: an unfiltered `patient.count()` returns 40 where the owner sees 80.

Four things that are easy to get wrong, all of them load-bearing:

1. **The API must not connect as a superuser.** Superusers bypass RLS entirely — `FORCE` does not stop them. The app connects as `hms_app`; migrations and the seed use `DATABASE_URL_ADMIN`.
2. **`SET LOCAL`, never `SET`.** Plain `SET` persists for the life of the connection, so on a pool the next request — different user, different hospital — inherits it. `PrismaService.forTenant` uses `set_config(..., true)` inside a transaction.
3. **`nullif` around `current_setting`.** After a `SET LOCAL` transaction commits the value is `''`, and `''::int` throws on the *next* query to reuse that connection.
4. **The tenant comes from the user's row, never from the client.** `JwtStrategy` already re-reads the user on every request, so this is free and authoritative; the token's `tenantId` claim is only a tripwire.

**The clinic day is per-hospital, and it is behaviour rather than preference.**
`Tenant` carries `timezone`, `slotMinutes`, `clinicStartHour` and
`clinicEndHour`. Together they generate the booking grid: which appointment
times exist, how long each is, and what "today" means on a queue. A hospital
left on another's timezone gets a clinic day that ends before its staff arrive
and a booking page offering only past slots — which presents as a bug in
booking, not as a wrong setting. Resolved per request by `ClinicSettingsService`;
`isOnGrid` is checked on booking as well as when generating the picker, because
the API is the boundary and an off-grid appointment is invisible in the
availability view it would have to be cancelled from.

Timezones must be `Area/Location`. `Intl` accepts `CST`, which means both US
Central and China Standard, and as a fixed offset it ignores daylight saving —
a clinic set to it drifts an hour twice a year against the people standing in it.

`AuditLog.tenantId` is deliberately nullable — an anonymous failed login belongs
to no hospital, and that row is one of the most useful in the table. Its policy
allows a NULL insert and still shows no hospital another's rows.

### One person, several roles, one worn at a time

In a small hospital the owner is often also the treating doctor. Two accounts
for one human is the alternative, and it breaks the audit trail — "what did Dr
Smith do today" cannot be answered when two logins are the same person.

So a user holds several roles (`UserRoleAssignment`) and acts as exactly ONE.
The union is never granted: an ADMIN+DOCTOR holding both at once would make the
admin surface clinical, retiring minimum-necessary and invalidating
`access-matrix.spec.ts`, which describes routes in terms of a single role.

`User.role` remains the *default* — where they land at sign-in. Switching goes
through `POST /auth/switch-role`, which re-checks the assignment server-side and
is audited, so `AuditLog.actorRole` reads "acting as ADMIN" for everything after.

Two consequences that are easy to miss:

- **`doctorId` is withheld unless acting as DOCTOR.** It is a capability, not an identifier — `PrescriptionsService` reads it to decide whether the caller may prescribe at all. Left set while acting as ADMIN, the administrative role could issue prescriptions.
- **The last-admin check counts who *holds* ADMIN**, not whose default is ADMIN. An owner who defaults to DOCTOR still administers the hospital; counting defaults would block a safe change, and in the mirror case strip the last real administrator while the count looked healthy.

The token's role claim is a *request*, not a grant — `JwtStrategy` resolves it
against the assignments read on that request, so a stale or forged claim falls
back to something the user still holds.

### Access control is three layers, not one

1. **Route** — `@Roles()` + `RolesGuard`. May this role call this endpoint?
2. **Resource** — service-layer query scoping. May this user see *this row*? A guard cannot answer this.
3. **Response** — `toPatientResponse(patient, role)`. Same route, different body per role. Never return a Prisma model from a controller.

Layer 3 is what makes minimum-necessary real. `patient-response.spec.ts` asserts on the *absence* of fields, because a test that only checks the doctor sees allergies would still pass if reception saw them too.

### The vendor can reach the system, and it is not an admin

Support needs a way in. The trap is making that way a role: adding
`SUPER_ADMIN` to `UserRole` would silently widen every existing
`@Roles(ADMIN)` decision the moment a set comparison saw a new value, and the
new value would be the most powerful one in the system.

So platform staff live outside the tenant model entirely — `PlatformUser`, its
own login, its own token audience. `PlatformGuard` deliberately **does not set
`req.user`**, which is what makes the separation structural rather than
remembered: `RolesGuard` admits nobody without a `UserRole`, `TenantInterceptor`
opens no transaction, and a vendor token cannot reach a clinical route even if
someone points it at one. `access-matrix.spec.ts` asserts the absence of
`@Roles()` on every `/platform` route, so the day someone reaches for it, the
build says no.

`@Public()` was not reused for this. It means *unauthenticated* — login, refresh,
health — and the assertion that exactly four routes are public is worth more
than the saved file. `@PlatformRoute()` is its own key.

**Access is time-boxed and reasoned, not standing.** A `BreakGlassGrant` names
one hospital, carries a written reason of at least 12 characters, and expires in
at most 8 hours. Revocation is checked *per request*, not at grant time —
otherwise "revoke" quietly means "revoke when the access token expires".

**What a grant buys is aggregates and configuration — never a patient row.**
Row counts, clinic settings, denial counts: enough to answer "why is this
hospital's booking grid empty", which is nearly every real support question.
Reading actual records would need a BAA conversation and per-incident consent,
so it is absent rather than half-built.

**Every platform action is written to that hospital's own audit log**, not a
vendor-side one. A hospital must be able to answer "who from the vendor was in
our data, when, and why" from its own records; a log the vendor keeps and they
must request is not the same assurance. `actorRole` stays null — inventing one
would make a vendor action indistinguishable from a staff action in reports.

**The vendor tables carry the *inverse* RLS policy**, and this is the part worth
re-reading before changing: `USING (app_current_tenant() IS NULL)`. Visible only
when no hospital is in scope. `platform_users` holds hashes for accounts that
can open a grant against any hospital, and `break_glass_grants` would tell one
hospital about another's. Neither should have a `where` clause as the only thing
in front of it. `break_glass_grants` *has* a `tenantId`, so the generic policy
would apply cleanly and be wrong — hence a third category, `PLATFORM_MODELS`,
rather than forcing it into scoped or global.

The SQL proves both directions against a row it inserts and rolls back. A policy
that denies everyone looks airtight and leaves the platform API unable to
authenticate anybody — the same shape as the login chicken-and-egg that shipped
once already.

### A lost audit write is a lost security event

`AuditService.record()` is still non-blocking — a nurse must be able to save
vitals while the audit table is unwell — but it is no longer a floating promise.
Entries go into a bounded queue drained by a single loop, a failed insert is
retried with capped backoff, and anything that still will not write is appended
to `backend/var/audit-spill.jsonl` rather than dropped. Shutdown drains the
queue; Nest's shutdown hooks were already enabled.

**Overflow spills, it never drops**, and `OverflowAction` has no `'drop'` member
so the branch cannot be written. An attacker who can make audit writes fail must
not thereby be able to make them disappear — that matters more since denials
started flowing through here.

**The spill file is JSONL, one object per line.** A JSON array would be corrupt
the moment the process died mid-append, which is exactly when the file matters.
`npm run audit:replay` loads it back, is safe to run twice, and refuses to
archive a file containing lines it could not read.

**This is more durable, not durable.** A `kill -9` still loses whatever is in
memory — milliseconds' worth. Closing that window means a write-ahead log, which
doubles the I/O on every request to protect against a case where, on one
machine, the disk dies with the database. Stated plainly because "we added a
queue" is the kind of change that gets remembered as "audit writes are safe now".

**No-log-no-look was considered and not built.** Refusing to serve PHI that
cannot be logged is defensible for reads and indefensible for clinical writes.
Splitting the two is a real decision, so it is absent rather than half-built
behind an unused flag.

The bug found while building it is the familiar shape: `drain()` returned early
when a drain was already running, so `onApplicationShutdown` awaited a resolved
no-op and then spilled entries that were about to be written fine. A clean
SIGTERM produced a spill file needing manual replay while the code read as
though it drained. Holding the promise, rather than a boolean flag, is what
makes "wait for the drain" mean it.

### Notifications carry no PHI

Push content is server-decided and every possible string is a constant in `notification-payload.ts`. `buildPushMessage` takes a kind and numeric ids — no string parameter — so a caller cannot inject a patient name. A lock screen is unauthenticated and unaudited; the app fetches detail after unlock, and that read *is* audited.

### Offline writes are idempotent, not just queued

Bedside writes go into a durable outbox (`mobile/lib/outbox.ts`) and are replayed when signal returns. The dangerous failure is not a lost request — it is one that *succeeded* and whose response was lost, which the device cannot distinguish from a failure. Every entry carries a `clientRef` UUID generated before the first attempt and reused on every retry; `Vital.clientRef` and `MedicationAdministration.clientRef` are unique, so a replay returns the original row instead of duplicating an observation or a dose.

### An endpoint with no caller is an unfinished feature

Phase 3 first shipped `POST /admissions`, `PATCH /admissions/:id/discharge` and `POST /admissions/:id/medication-schedule` — all tested and correct, and callable by no client. A patient could not be admitted except by seeding, and a newly admitted patient's drug chart stayed empty forever. `endpoint-coverage.spec.ts` now fails the build on any route with no caller unless it is listed with a reason.

**A weak version of that test is worse than it looks.** The first one grepped the client source for each fixed path fragment, so `PATCH /users/:id/roles` passed on the words "users" and "roles" appearing in unrelated places — segments did not have to be adjacent, ordered, in the same URL, or even in the same file, and the HTTP verb was ignored entirely. It matches on `(method, path)` structurally now, and the day that changed it found six endpoints passing on coincidence, five of them real missing UI. Three call styles all count as callers, because all three reach the API: `api()`/`fetch()`, the mobile outbox's `{ path, method }` objects, and `<a href>` navigation to `/api/v1/...`. Missing any one of them manufactures false orphans, which is how an exemption list quietly grows to paper over a broken extractor.

**Exemptions are split in two, and the split is the point.** `INTENTIONALLY_UNCALLED` is design decisions; `KNOWN_GAPS` is missing UI. One list holding both means a reader skims "fine, ignore these" and the real holes vanish into it. A test fails if a `KNOWN_GAPS` entry is not also written down in [`PLAN.md`](PLAN.md), so nothing can be parked there quietly, and another fails the moment an exempted route gains a real caller — the list has to shrink on its own or it rots into claims nobody rechecks.

### A prescription is a record, not a projection

`PrescriptionItem.medicineName` stays as free text forever — the catalogue link is an *added* nullable `medicineId`, not a replacement. `PLAN.md` said it would become a FK; that would let a catalogue rename silently rewrite what a doctor prescribed months ago. See [`backend/prisma/MIGRATION-PHASE-4.md`](backend/prisma/MIGRATION-PHASE-4.md).

Consequence: items whose text does not match the catalogue cannot be class-checked for allergies or dispensed against stock. They are flagged, not silently treated as safe, and mapped through the pharmacy UI.

### Money is never a float

Postgres holds `Decimal(10,2)`, application arithmetic happens in integer minor units (`billing/money.ts`), and the API sends and receives strings. `0.1 + 0.2 === 0.30000000000000004`; on one line that is invisible, across thousands of payments it is a dispute a finance clerk cannot explain. `money.ts` refuses to coerce — `parseFloat("12abc")` returning `12` as a payment amount is the failure it guards.

Overpayment is rejected rather than absorbed: a credit balance needs refunds and credit notes to be real, and swallowing the excess loses the patient's money silently.

### Billing must not learn clinical facts

Invoice lines are typed by billing staff or picked from service presets — never generated from prescriptions or dispensing. A line reading "Amoxicillin 500mg × 21" would route a medication history to billing past the role-shaped patient response. If auto-generation is ever added, the description must be a tariff code.

Insurance fields go the other way: billing and reception get them, clinicians do not. Minimum-necessary cuts both directions.

### Admin is operational, not clinical — and that had drifted

The rule has been stated since Phase 1. When Phase 6 added a test asserting it directly (`access-matrix.spec.ts`, "gives admin no clinical READ endpoint at all"), it immediately found four violations that had accumulated quietly: the ward board (open to admin since Phase 3), the dispensing queue, prescription detail, and the medication round — all of which name patients.

Admin now holds **no clinical GET at all**. Bed-management *writes* remain, because that is how a mis-admission gets corrected and an admin without them has no route but a database console; each is audited. Reports are aggregates with no patient rows and no clinical breakdown.

A stated rule with no test is a rule that drifts.

### What the live run found

The backend has now run against a real PostgreSQL instance: schema applied, seed executed, API booted, all six roles logged in, role-shaped responses and money-as-strings confirmed against actual rows. Most of it worked on the first attempt. The things that did not are the point of this section — and all three were in the audit and rate-limiting layer, the part with no user-visible behaviour to notice when it is wrong.

**Three bugs, all invisible to 513 unit tests, and not one of them a wrong function.** Each was a wrong assumption about how the parts fit together — the class of bug that only a running system reports.

**1. Failure auditing was unreachable code.** `AuditInterceptor` logged both outcomes via `tap({ next, error })`. The live trail showed 30 SUCCESS rows and zero FAILURE rows after deliberately triggering five 403s, a 401 and three 429s. Guards run *before* interceptors, so a rejection means `intercept()` is never called and there is no observable to attach an error handler to. The interceptor's own doc comment cited that exact ordering rule as the reason it wasn't middleware — and then depended on the opposite of it one method down.

This was the most serious defect in the project. "A receptionist walking sequential patient IDs produces nothing but 403s" was the stated reason for logging failures, and that was precisely the case being dropped. An audit trail that records only permitted access is not an audit trail; it is a usage log, and it would have passed a review by reading.

Failures now come from `AllExceptionsFilter`, which runs for every rejection regardless of where it originated. `failure-audit.spec.ts` pins the behaviour and asserts the interceptor holds no failure branch, so a future tidy-up cannot quietly reinstate it.

**2. The login rate limit throttled the hospital, not the attacker.** Bucketed per IP, so the sixth staff member logging in from the same building inside a minute got a 429 — while an attacker still had the full budget per IP for a single account. `AppThrottlerGuard` now buckets login on IP + email, leaving everything else on IP.

The first fix attempt failed instructively: a route-level `LoginThrottlerGuard` added with `@UseGuards` did nothing, because the *global* `ThrottlerGuard` reads the same `@Throttle` metadata and still bound first. Overriding a globally-registered guard means replacing it, not adding beside it.

**3. Denials were recorded without saying what was reached for.** Fixing (1) surfaced this: the new FAILURE rows for clinical routes all read `target=-`. Both the interceptor and the filter carried their own copy of a target extractor that read `req.params.id` — but nested clinical routes are declared `patients/:patientId/records`, so `params.id` is undefined on exactly the endpoints where "which patient" matters. The unit test missed it by passing `params: { id: '1' }`, a shape the router never produces for those routes; a fixture that doesn't match reality tests the fixture.

Both copies are now one shared `resolveAuditTarget`, keyed on param name rather than path, and `audit-target.spec.ts` derives its cases by parsing route paths out of the controllers. That test found four more unmapped routes beyond the one that prompted it, and it fails on any future `:someId` route that resolves to nothing.

**The lesson worth keeping:** the static tests in this repo (`access-matrix`, `endpoint-coverage`) each caught real violations the day they were written, and they remain the best tooling here. But every one asserts a property of *code*. Neither could see a property of the *framework's runtime ordering*. A test suite that has never run the thing it tests measures the author's model of the system, and the model was wrong in two places.

### Known issues

- The backend has run against a real Postgres; **neither client has.** The web app has never rendered against a live API, mobile has never run on hardware, and `docker compose` + `prisma migrate` remain unexercised — the live run used a hand-built database and a WASM Prisma client to work around a blocked binary download. Both clients are still the largest unknown.
- The login throttle buckets on IP + email, so password spraying across many accounts is limited only by the general 120/min ceiling. A per-IP failure counter is the missing piece.
- Audit writes now retry and spill to disk instead of vanishing, but the queue is **in-process**: a `kill -9` loses what is in memory, and a spill file needs someone to notice and run `npm run audit:replay`. Nothing alerts on `spilled > 0` — it is reported in the shutdown log and on platform diagnostics, both of which require somebody to look. A real broker is still the answer for a multi-instance deployment.
- `scripts/audit-replay.js` duplicates `parseSpill` in plain JS so recovery does not depend on the TypeScript build; a test pins the two together, but it pins the rules, not the implementation.
- Postgres RLS policies (defence in depth behind the API) not yet applied — Phase 1. This is also the foundation multi-tenancy depends on: see [`docs/adr-001-multi-tenancy.md`](docs/adr-001-multi-tenancy.md), which specifies the policies and was verified against a live PostgreSQL 14 before being written.
- `mobile/lib/types.ts` duplicates `web/lib/types.ts`; a drift test enforces they match. Extract to a shared package once Metro `watchFolders` can be verified on a device.
- **A doctor cannot retract a prescription.** `PATCH /prescriptions/:id/cancel` exists, is tested, and no client calls it — and `schedule-medication-sheet.tsx` already refuses to chart a cancelled prescription, so the UI reasons about a state it gives nobody a way to reach. The most serious of five endpoints with no way in; all five are tabulated in [`PLAN.md`](PLAN.md).
- The medicine catalogue is seed-only: no UI adds (`POST /medicines`) or corrects (`PATCH /medicines/:id`) an entry, which is exactly what the `drugClass = OTHER` trap below needs in order to be fixable. Doctor profiles are likewise frozen after creation (`PATCH /doctors/:id`).
- No refunds or credit notes, so an invoice with payments cannot be voided and an overpayment cannot be taken at all.
- A backfilled catalogue with `drugClass = OTHER` produces allergy checks that run, report nothing, and look healthy — worse than the Phase 1 heuristic. The migration doc covers it; nothing in the UI flags it.
- The platform API has **never run** — not against the live database, not once. The grant rules are unit-tested and the RLS policy self-checks at apply time, but `PlatformGuard` refusing a hospital token, and the inverted policy hiding `platform_users` from a real request, are both unverified. Given that the last live run found three bugs no unit test could see, assume this has one.
- The platform API has no console. It is curl-only by design (the hospital clients must never call it — `endpoint-coverage.spec.ts` fails the build if they mention `/platform`), but "no UI" also means nobody has clicked through the grant lifecycle.
- A platform account can open a grant against any hospital on its own authority. Two-person approval — `createdById` differing from `platformUserId` — is modelled but not enforced; the field exists for it.
- Prisma prints a deprecation warning about `package.json#prisma`. Harmless on v6; the move to `prisma.config.ts` also stops `.env` auto-loading, so the Prisma 7 upgrade needs care.
