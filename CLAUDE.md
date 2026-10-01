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

**A hidden link is not an unreachable screen, and that mattered.** The menu was
the only thing shaping which role saw which route, and a menu holds until the
first URL is typed. It stopped holding on a shared machine: a doctor's session
ended at `/queue`, leaving `?next=/queue` in the address bar, and the
administrator who signed in next was sent there. `GET /me/queue` came back 403 —
the API refusing exactly as designed — but the screen was broken and the
hospital's audit log gained a **denied clinical access by an administrator**.
Nothing leaked; the trail is what suffered. Denial rows are supposed to mean
someone reached for data they should not have, and they are worth much less once
the app manufactures them by accident.

So `canReach(role, path)` is derived from the nav table rather than declared
beside it, the `(app)` layout bounces a role to its own landing screen, and
`?next=` is validated against the role that *arrived* rather than the one that
left. Three properties are load-bearing and each has a test: an unknown path
stays a 404 rather than becoming a silent redirect (otherwise every typo reads
as a refusal and real broken links disappear); the check survives a query string
and a trailing slash, since `?next=` carries both; and **every `page.tsx` must
appear in the nav table for at least one role** — a page nobody has a menu entry
for would be reachable by everybody, with the guard waving it through while
looking like it was checking.

Still not the security boundary. The API is, and assumes any client can call any
endpoint. This only stops the app from asking for what its own role cannot have.

**Web = desktop application feel.** This is an internal operational tool (think Epic, Linear, a banking back-office), not a marketing site:

- Persistent sidebar navigation — staff live here for 8-hour shifts
- Dense, data-table-heavy layouts optimised for scanning many records
- Multi-panel views (list left, detail right) without full page reloads
- Keyboard shortcuts and fast global search — power users repeat actions hundreds of times daily
- Minimal scrolling per screen

**Build every feature on both clients, in the same change.** This is a
standing instruction from the product owner and it overrides the curation
argument below wherever the two conflict.

The rule exists because the alternative kept failing in one direction. Reception
was locked out of mobile for six phases behind a comment that turned out to be
false. `POST /appointments/:id/invoice` shipped to the phone and not the web, so
a receptionist at a desk could not bill a patient they had just checked in.
Dispensing was web-only on the reasoning that it happens "at the counter" —
which is exactly where somebody is holding a phone. Every one of those was
discovered by a user, not a test, because a screen that was never built looks
identical to one that is working.

So: a new endpoint gets a caller on **both** clients in the change that
introduces it. `endpoint-coverage.spec.ts` enforces this — `WEB_ONLY` and
`MOBILE_ONLY` still exist, but an entry in either is now a decision that has to
be argued for at the moment it is made, not a default. The list of things that
genuinely stay on one client is short and each carries its reason: creating
accounts with a temporary password, the full audit browser, invoice aging, bulk
entry.

**A role's menu is the unit of parity, and nothing was checking it.** Reported
by the product owner: a doctor on the phone had Queue and Ward Requests and
nothing else — no patient list, no way to open a record, no results — while the
web gave the same role five items from the beginning.

`endpoint-coverage.spec.ts` was green throughout, and could not have been
otherwise. It compares which *API routes* each client calls, and every route
involved was called somewhere in the mobile app: `GET /patients` by reception's
lookup, `GET /patients/:id/lab-orders` by the patient screen. What was missing
was a **tab**, and a missing tab is invisible to a test that asks about routes.
Third time the same shape — a screen that was never built looks identical to one
that is working.

Worse, the screen behind the missing tab was reception's and only reception's:
`patients.tsx` had no route to the patient record at all, every action leading
to registration or booking. Giving the other roles the tab without that would
have handed a doctor a search box over a record they still could not open.

`screen-parity.spec.ts` compares the web nav table against the phone's tabs
role by role. `KNOWN_GAPS` holds what is genuinely still missing, kept apart
from anything deliberate for the reason `PARITY_GAPS` is kept apart from
`INTENTIONALLY_UNCALLED`, and a gap removed from the list without the screen
being built fails immediately.

**Mobile = curated task subset, not feature parity.** Aim for *task* parity per role, not feature parity. Mobile is for quick lookups, on-the-go actions (bedside vitals, approving a prescription between rounds), notifications, and simple entry. Billing reconciliation, report generation, bulk entry, and multi-panel history review stay web-only.

**The curation argument runs in both directions, and it failed going the other
way too.** The medication round was *web-read-only* for six phases, on the
argument that signing for a dose belongs at the bedside and a desktop button
labelled "given" invites signing for something not yet done. The header said
*Sign for doses on the mobile app* — a dead end for a nurse at a ward terminal
who has not been issued a phone, and for the ward round pushed alongside a
computer-on-wheels, which is how most hospitals that own one actually record it.

Same shape as reception locked out of mobile, and dispensing kept off the web
because it happens "at the counter": a plausible story about where work happens,
standing in for the fact that nobody built the other half.

`endpoint-coverage.spec.ts` could not see it. Both clients call
`GET /medications/round/:wardId`, so the round read as covered; what differed
was that only one could *write*. `PATCH /medications/doses/:id` sat in
`MOBILE_ONLY` claiming "the web round posts against the schedule", and the web
round posted nothing at all. **A false reason in an exemption list is worse than
no list**, because it reads as a decision somebody made and gets skimmed past.

The safeguard the original rule wanted is kept and is the better version of it:
anything other than "given" demands a written reason, and the sheet restates
the patient, bed and medicine at the moment of signing. Withholding the screen
never made the round safer — it made it unrecorded.

**Every role gets the app; no role gets every screen.** That distinction had been lost: reception and billing were refused at mobile login for six phases, behind a comment claiming the backend "would refuse every clinical call anyway" — untrue, reception has its own endpoints and always did. The real reason was that nobody had built the screens, and the absence had acquired a rationale. It also failed the target market, where a small clinic's receptionist may have a phone and no desktop, and where check-in is *better* on a phone because you are standing next to the person you are checking in. The security argument pointed the other way too: reception sees the least PHI in the system, doctors and nurses the most, and it was reception that was excluded. `role-screens.test.ts` now fails the build if a role in `UserRole` has no tab — a curated subset is a decision, an empty app is an omission, and only one of them should be possible.

**Mobile admin is read-only with three deliberate exceptions**, and the line
between them and the rest is worth stating because "the phone is for looking,
the desk is for doing" is a tidy rule that fails in specific places.

- **A doctor's consultation fee.** One number that blocks *somebody else's*
  work right now: reception's checkout refuses for an unpriced doctor, and the
  receptionist discovers it standing in front of a patient. Making the owner
  find a laptop to unblock a queue is the wrong trade, and in a small clinic
  the owner is often the doctor being priced, holding a phone.
- **Clinic settings** — currency, timezone, slot length, opening hours. A
  five-field form, and currency is the first thing a new tenant changes: a
  hospital in India seeing pounds on every invoice has a broken product until
  it is fixed, and a laptop requirement makes that a bad first hour.

- **Role assignment** — which roles a person may act as, and which they sign in
  as. The owner-doctor case is the reason multi-role exists, and it is most
  often set up by the owner, who is the person least likely to be at a desk.
  Granting a role is also reversible and immediately visible, unlike the
  account operations beside it.

What stays on the web is unchanged and is not an omission: creating accounts,
resetting passwords, deactivating staff, departments, the audit browser,
invoice aging, and the full revenue table. Creating an account with a temporary
password is not a one-handed task — the password has to be read out or written
down — and getting a deactivation wrong locks someone out mid-shift. The audit
browser is scanning and filtering, which is the thing a phone is worst at.

Both mobile writes go through the same `@Roles(ADMIN)` routes as the web ones
and are audited identically. The phone is an affordance on the boundary, never
a second one.

**Exception:** any public patient-facing page (book an appointment, hospital info) stays light and marketing-style. The dense treatment is for internal staff tools only.

## Current state

**All six phases complete, plus diagnostics.** The backend has been verified end-to-end against a real PostgreSQL database — see "What the live run found" below, which is where the two most serious bugs in the project surfaced. Mobile serves doctors, nurses, pharmacists and admins but **has never run on a device**, and the web app has never rendered against a live API. See [`PLAN.md`](PLAN.md) for phasing and the per-app READMEs to run them.

- `docker-compose.yml` — Postgres 16, db `hms_db`, user `hms_admin`, port 5432
- `backend/` — NestJS 11 + Prisma 6. Auth (rotating refresh tokens, Argon2, login lockout), `RolesGuard`, global audit interceptor, PHI-safe exception filter, rate limiting, seed script. Feature modules: patients, doctors, appointments, medical-records, prescriptions, me/queue, wards, admissions, vitals, medications, medicines, pharmacy, **lab**, billing, users, departments, admin, notifications, audit. No DB required for any test.
- `web/` — Next.js 15 App Router + Tailwind. Login, role-derived shell, ⌘K search, reception (check-in, booking, registration with duplicate detection, patients), doctor (queue, records, prescriptions), audit browser, nurse ward board (admit/transfer/discharge/drug chart), vitals history, medication round, pharmacy dispensing and inventory, billing invoices/payments/aging, admin dashboard/users/departments, lab worklist/result entry/incoming referrals/till/catalogue and the doctor's results view, forced password change, 15s live refresh.
- `mobile/` — Expo/React Native, **SDK 53** (React 19, RN 0.79). **All seven roles.** Doctor: queue, patient summary, prescribe. Nurse: ward board, bedside vitals, medication round. Pharmacist: read-only queue and stock alerts. Reception: today's schedule with check-in, patient search, registration with duplicate detection, booking against the tenant's slot grid. Billing: outstanding invoices and taking a payment. Admin: read-only aggregate overview. Lab: worklist, specimen collection, result entry with the critical-value stop, incoming referrals, till. Refresh token in expo-secure-store, 15-min idle biometric lock, **durable offline outbox** with idempotent replay. API host is derived from the Expo dev server rather than a hand-set IP. **Reception, billing and laboratory screens have never run on hardware.**

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

**One request, one connection — and for a while it was two.**

`TenantInterceptor` wraps every authenticated request in an interactive
transaction, which holds a pool connection for the whole request. Reading a
*global* model went to the base client instead, so the request asked the same
pool for a second connection while still holding the first — and `tenants` is
read for the hospital's timezone on nearly every request.

With Prisma's default pool (about 2×CPUs + 1) that is a self-deadlock, not
slowness. Once that many requests are in flight, each holds one connection and
waits for another nobody can release; they stall until the pool timeout, the
15-second auto-refresh on the ward board and queues fires them again, and the
page never loads. Reported as "switching to nurse takes more than two minutes".

The proxy now routes `GLOBAL_MODELS` through the request's transaction too.
That is safe because those tables carry no policy — `app.tenant_id` does not
change what they return — so it is the same rows on the connection already
held. `unscoped` remains for code that genuinely runs outside a request: login,
the platform API, public signup, provisioning, the cross-tenant referral write,
and the audit drain loop. `connection-budget.spec.ts` fails the build on any
new `unscoped` use outside those.

No query here was slow, and no test that runs one request at a time could see
it — which is the same lesson the live run taught about framework ordering.

**The mirror image of that bug also shipped, and reads identically in the
logs.** A push notification is fire-and-forget — `void this.send(...)`, so a
push service having a bad day cannot fail a check-in — so it runs *after* the
response has gone and after the transaction has committed, while
`this.prisma.device` was still proxied onto it. Reported as *"Transaction
already closed: A query cannot be executed on a committed transaction"* on the
first real check-in.

Routing global models through the request's transaction is right for everything
that runs *inside* a request and exactly wrong for anything that outlives one,
which is why the audit drain loop was already `unscoped`. Notifications are the
same class and now are too — safe as well as necessary, since `devices` carries
no `tenantId` and no policy and the lookup is keyed on `userId`. Awaiting the
send instead would have fixed the error by destroying the property the method
exists for.

`connection-budget.spec.ts` now checks both directions: a second connection
opened *during* a request, and a proxied query executed *after* one. The second
check passed on its first run with the bug still in place — the declaration
regex matched `void this.send(` rather than the method — so it was verified by
reintroducing the fault and watching it fail. A guard nobody has seen fail
asserts nothing, and this repo has learned that twice already.

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

**A clinical profile attaches to an account, and for six phases it could not.**
`Doctor` rows were only ever created inside `UsersService.create()`, as a side
effect of making a *new* user. So an owner-doctor — the exact case this design
exists for — ticked DOCTOR for themselves and was told to create a doctor
profile, which meant a second email and a second password for one human. The
rule was stated in this file and in three doc comments and was contradicted by
the only code path that could satisfy it; nothing asserted the capability end to
end, and a stated rule with no test is a rule that drifts. `POST
/users/:id/doctor-profile` closes it, both role screens ask for a specialisation
at the moment DOCTOR is ticked, and `owner-doctor.spec.ts` asserts that method
creates no account, no password and no email — because the tempting repair is to
quietly make a second person under a friendlier name.

Two consequences that are easy to miss:

- **`doctorId` is withheld unless acting as DOCTOR.** It is a capability, not an identifier — `PrescriptionsService` reads it to decide whether the caller may prescribe at all. Left set while acting as ADMIN, the administrative role could issue prescriptions.
- **The last-admin check counts who *holds* ADMIN**, not whose default is ADMIN. An owner who defaults to DOCTOR still administers the hospital; counting defaults would block a safe change, and in the mirror case strip the last real administrator while the count looked healthy.

The token's role claim is a *request*, not a grant — `JwtStrategy` resolves it
against the assignments read on that request, so a stale or forged claim falls
back to something the user still holds.

### One email, two hospitals, and the refusal that read as correct

Email is unique **per hospital**, so one person can hold accounts at two — the
owner-doctor case one level up, and anybody the vendor onboards using an address
already in the platform. `findLoginCandidate` refuses to guess between two
candidates and returns the same `Invalid email or password` as a wrong password,
because "which hospital did you mean" is an oracle telling an attacker where an
address is registered.

That refusal is right. **The way out of it did not exist.** `LoginDto.hospital`
has been accepted since login was written, its own comment reads *"Required in
practice for anyone with accounts at two"*, and `findLoginCandidate` said
resolving it was "the UI's job" — while both clients called
`signIn(email, password)` and nothing between the form and the fetch carried a
slug. Reported as *"newly created tenant's password is not working"*: the
password was never checked, and the temporary password was fine.

**Sixth instance of a setting with no route in, and the quietest.** The medicine
catalogue, doctor profiles, wards, drug-chart items and
`acceptsExternalLabOrders` each produced a 404 or a refusal that read as broken.
This one produces *Invalid email or password*, which reads as **correct** — so
there is nothing to report except a password that does not work, and nobody
looks at the login code.

**The reason is logged and never returned.** `LoginRefusal` distinguishes
`no-such-address`, `ambiguous`, `no-such-hospital`, `not-at-that-hospital` and
`row-not-readable`; `login` writes it to the server log with the candidate count
and throws the identical message. That last one is worth its own name because it
is nobody's fault: it means `app_login_lookup` found a row the scoped read could
not, which is the disagreement between the SECURITY DEFINER function and the
`users` policy that took login down completely once.

**The field appears after any failure, never after the ambiguous one.** A third
box on every sign-in is clutter on the most-used screen, and revealing it exactly
when the address really is at two hospitals would leak by the **shape of the
form** precisely what the wording refuses to say — a version of the leak that
looks like an improvement in review. So a wrong password reveals it too.
`login-ambiguity.spec.ts` asserts both halves, and was verified by adding a
friendlier second wording and a form that keys on the error text, and watching
three assertions fail.

### A forgotten password had three answers and one of them did not exist

Reported from use: *"I forgot the password on the web or app. There is no way to
reset the password."* Half right, and the half that was wrong is the dangerous
one — it looked fine from the inside.

An administrator could reset any member of staff from Admin → Users, and always
could. What had no route anywhere was **the administrator themselves**.
`POST /users/:id/reset-password` is `@Roles(ADMIN)`, so they could not reset
themselves; nobody else in the hospital held the role; and break-glass
deliberately buys the vendor aggregates and configuration rather than the
ability to write to `users`. A small clinic has exactly one administrator — the
owner-doctor this whole multi-role design exists for — so forgetting that
password locked the hospital out of the product **permanently**, with the only
exit a database console.

Ninth instance of the family, and the first where the missing route stranded a
whole customer rather than a feature.

**Four paths now, and which one applies is decided by who is available.**

- **Staff → their administrator.** Unchanged, web-only: a temporary password has to be read out or written down.
- **Administrator → the vendor**, under a break-glass grant. `POST /platform/tenants/:id/users/:userId/reset-password`, the only write the platform API makes into a hospital's `users` table. It refuses anybody not holding ADMIN — not because resetting a nurse would be more dangerous but because their own administrator already can, and **a power with no case behind it gets used for something else eventually**.
- **Anybody → themselves**, by email. The path that needs nobody.
- **`npm run password:reset`** — the floor under all three, needing no mail transport, no vendor account and no working API, because it is what recovers a deployment where one of those is the broken thing.

**The console screen mattered as much as the route.** Break-glass had been
modelled since the platform API was written and was **curl-only** — and
curl-only is how a capability quietly stops being one. Shipping the reset
behind an unreachable grant would have been the same bug wearing a fix.

**`requireActiveGrant` hard-coded the diagnostics route into its denial row.**
True while diagnostics was its only caller, a lie the moment a second arrived —
a refused password reset would have been written into the hospital's log as a
refused diagnostics read. The whole value of those rows is that a hospital can
ask what the vendor reached for, and an answer naming the wrong thing is worse
than none.

#### The response is identical whatever happened, and that is the whole design

`POST /auth/forgot-password` returns one sentence for an address with an
account, one without, a deactivated account, a suspended hospital, and an SMTP
server that refused the message. Anything else turns a public endpoint into a
way to ask whether a named person works at a hospital — the enumeration concern
that already shapes the signup form and the partner-code lookup, and a sharper
one here because the answer is about an individual. `password-reset.spec.ts`
asserts it as *"the only thing this method returns is `same`"* rather than by
comparing strings, because the failure to catch is a fifth branch with a
friendlier message.

**Timing is deliberately not equalised, and saying so is more honest than
pretending.** A hit does real work a miss does not. Closing that properly means
a constant-time path or a queue; the 3/min throttle is what makes the remaining
signal too expensive to harvest.

**One email, even when the address is at two hospitals — and that is not
inconsistent with login refusing to guess.** The sign-in form answers *whoever
is typing*; this answers *the mailbox*. Telling the owner of an address which
hospitals it is registered at reveals nothing they do not already know, so the
message lists both with a link for each. It is the only place in the product
where that ambiguity resolves without the person already knowing the hospital
code, which is exactly what somebody locked out does not have.

**A token is 32 random bytes, stored only as a sha256 hash, single use, thirty
minutes** — the same construction as `RefreshToken`, deliberately, because that
one was hard to get right and a second scheme beside it would be the one nobody
re-reads. `consumedAt` is a column rather than a delete: a token presented twice
is either a double click or a replay, and a deleted row makes both
indistinguishable from one that never existed.

**Strength is checked before the token is spent.** Getting the rules wrong is
the commonest thing that happens on that form, and burning the link over an
eleven-character password sends somebody back to the sign-in screen to start
again — which is how a recovery flow earns a reputation for not working.

**Consuming one link kills every other outstanding link for that person, and so
does any other password change.** Somebody who clicked "forgot password" three
times has three live tokens in their mailbox; an administrator resetting them
afterwards left two of them working. Anybody holding an earlier email takes the
account straight back, past a reset performed precisely because something was
wrong. `UsersService.resetPassword` and `changeOwnPassword` both close them —
through the **proxy**, not `unscoped`, because both run inside a request that is
already holding a pool connection and a second one there is the self-deadlock
this project shipped once.

**`PasswordResetToken` carries no `tenantId`, and could not.** It is read on an
unauthenticated request where `app.tenant_id` is unset, so a row under the
generic policy would be invisible to the only request that ever needs it — every
valid link would read as expired. The same shape as the login chicken-and-egg
that took sign-in down completely. It holds a user id, a hash and two
timestamps; the hospital is reached through `user`, which is where the tenant is
supposed to come from anyway.

**The link is built from configuration, never from the `Host` header.** A reset
URL assembled from a header is one an attacker aims at their own server by
sending `Host: evil.example`, and the victim clicking it hands over a live
token.

#### Nothing sent email, and the transport says so rather than pretending

`MailService` is the first outbound channel here apart from push. Three
decisions are load-bearing:

- **`send` reports delivery rather than returning void.** Every caller is a flow
  that is worthless if the message does not arrive, and the reset flow cannot
  tell the user either way — so the reason has to be logged or it is lost
  entirely.
- **`nodemailer` is loaded dynamically.** A static import makes an uninstalled
  dependency a compile failure across the whole API: the ward board goes down
  because nobody ran `npm install` for a mail library. Same shape as one
  top-level `expo-notifications` import taking the entire phone app down.
- **The `log` transport reports `delivered: false`.** It writes the whole
  message, link included, so a developer can follow the flow — and it does not
  claim success, because a transport that printed to a console and returned
  success would make every caller believe mail works here.

**The boot log says what will happen, and the login screens ask before
offering.** `GET /health` carries `passwordResetAvailable`, and both clients
render "Forgot your password?" only on `true`. A link into a form that says a
link is on its way and sends nothing is the failure this file records a dozen
times, arriving at the one screen where the reader is already stuck. It is safe
to expose: it describes the installation, not a person or a hospital.

**The ask is on both clients; spending the token is web-only and that is a
decision rather than a gap.** A reset URL has to be one canonical address that
works in any mail client on any device, and a deep link into an app the
recipient may not have installed is not that. Giving the phone a second way to
spend a token — pasting it into a box — would mean two paths to the most
security-sensitive write in the product, the second existing only to avoid a
browser that is already open. What *had* to be on both is the ask: a nurse who
is locked out is holding a phone, and sending her to find a desktop to type her
own email address into is *"sign for doses on the mobile app"* pointing the
other way.

#### An unlock is not a reset, and only one of them changes what you know

Five wrong attempts locks an account for fifteen minutes, and the only way an
administrator could end that early was `resetPassword` — which also invalidates
a password the person very likely still remembers. Somebody who mistyped theirs
five times before coffee was handed a temporary password, a forced change, and
every session on their phone signed out, to fix a typo.

`POST /users/:id/unlock` clears the counter and nothing else. **Sessions are
deliberately not revoked**, for the same reason the password is not: nothing
about a mistyped password suggests an existing session is somebody else's.
Where there *is* reason to suspect the account, `resetPassword` is the action
and it still does both. Its own audit action rather than a flag on the reset,
because `USER_PASSWORD_RESET` means a credential changed and rolling a typo
correction into it makes the rows that matter harder to find among the ones that
do not.

**It is the fourth mobile admin write**, and it belongs beside the other three
on the same test: one tap that unblocks *somebody else's* work right now, with
nothing to read out. Resetting a password stays on the web and that line has not
moved.

#### The vendor's own password could not be changed from inside the product

`create-platform-user.js` upserts, so it has always doubled as a reset — and it
was the *only* way a vendor password could change. That makes the single most
powerful credential on the deployment one that needs shell access to rotate,
which means in practice it never gets rotated. `POST /platform/password` closes
it, on the guarded controller rather than beside login so it inherits
`PlatformGuard` instead of needing a decorator somebody could forget.

Nothing is revoked afterwards because there is nothing to revoke: platform
sign-in issues a 30-minute access token and no refresh token. Stated because the
hospital-side `changeOwnPassword` does revoke, and the difference reads as a
mistake until you know why.

#### The vendor console has emailed recovery, against the advice written above it

This file and `create-platform-user.js` both said there should be **no** "forgot
password" for vendor staff: a reset link emailed to a vendor address is a way
into every hospital on the deployment, guarded by one mailbox, and recovery
should stay a person with database access.

Asked for anyway by the product owner, and that is a legitimate call rather than
one to be argued out of — a recovery path that needs a shell is one that fails
at weekends, and "ask the person with the database password" does not scale past
the first colleague. The argument above is not repealed; it is **answered**, and
these three are the answer:

1. **Break-glass waits an hour.** `PlatformUser.passwordResetAt` is stamped by
   the emailed path only, and `openGrant` refuses until it lapses. The console
   keeps working — tenants, applications, subscriptions, modules — and reaching
   *inside* a hospital does not. This is the only one of the three that
   interrupts the attack rather than narrowing or reporting it: a compromised
   mailbox followed immediately by a grant into patient data is the whole
   threat, and a reset is rare and planned where a grant minutes after one is
   not.
2. **Every other console account is emailed**, on the request and again on
   completion. Unlike detection built on logs this needs nobody to be looking.
   When there are no other accounts it logs that fact, because "somebody else
   finds out" is then not operating and whoever set the deployment up should
   know the mailbox is the whole of the security.
3. **Fifteen minutes, not thirty.** Half the window in which a link sitting in
   a mailbox is a working credential.

None of the three stops an attacker who owns the mailbox. Together the window is
short, the reach is limited while it is open, and other people find out. That is
a real trade, not a claim of safety, and `PLATFORM_RESET_GRANT_COOLDOWN_MINUTES`
exists because the cost of (1) lands on a real engineer at 3am and somebody may
reasonably decide against it.

**The cooling-off does not apply to `platform:user`.** That path already needs
the database owner's credentials, so there is nothing weaker to compensate for —
and an engineer who reset their own password at a shell must not then be locked
out of the reason they did it. `passwordResetAt` stays null there, deliberately.

**The token table is its own model, not a nullable column on the hospital one.**
`PasswordResetToken` has a foreign key to `users`, and a `PlatformUser` is
emphatically not a `User`. One table serving both means a nullable FK on each
side and a row valid with neither set — exactly the shape that lets a hospital
token be mistaken for a vendor one somewhere downstream.
`PlatformPasswordResetToken` carries the **inverted** RLS policy with the rest
of the platform tables, rather than being global like its hospital counterpart:
that one hangs off a hospital user and holds nothing a hospital could not learn
about itself, and this one names accounts that can reach every hospital.

**The routes are unauthenticated and are deliberately not `@Public()`.** They
carry `@PlatformRoute()` like every other vendor endpoint. `@Public()` is the
hospital API's key and `access-matrix.spec.ts` asserts its exact set, which is
valuable precisely because the list stays short enough to read — folding vendor
endpoints in would turn "these seven are open to the world" into a sentence
nobody could trust. `GET /platform/capabilities` answers whether the link should
be offered, rather than the console reading the hospital `GET /health`, because
the console may call nothing but `/platform`.

**The first guard for the cooling-off asserted nothing, and was caught the way
the other three were.** It was a string match — does `openGrant` mention
`passwordResetAt` and `ForbiddenException` — and it **passed with the condition
replaced by `if (false)`**. Fourth time in this repo. The decision moved into
`grantCooldownMinutes` in `break-glass.ts` so a test can call it with arguments
and assert behaviour instead of text; the string check that remains only
establishes that `openGrant` reaches it. Same reasoning as `resolveTreatingScope`
and `course-quantity.ts`, arrived at by the same route.

**A live token is taken out of the address bar on arrival.** The link lands on
`/platform?reset=…` and the console reads it once, then `history.replaceState`s
it away. A reset token left in `window.location` ends up in browser history, in
a screenshot of a support call, and in the `Referer` of anything the page loads
afterwards — single-use and short-lived are not reasons to leave it on display.

**Nothing here retrieves a password, and nothing ever will.** Passwords exist
only as Argon2 hashes, so a reset is the only possible answer; a system that
could email somebody their existing password would be one storing it in a form
it must not.

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

### Customers arrive by application, and are provisioned by the vendor

Public signup is `POST /public/signup` — the fifth `@Public()` route and the
first that writes. It creates a `TenantApplication` and nothing else: no
`Tenant`, no `User`, no slug reserved. Every consequential decision happens at
approval, under a platform login, after a human has read it.

**An application is not an inactive tenant.** Letting signup create a `Tenant`
with `isActive = false` would put row creation in `tenants` — the table all
tenancy keys on — in the hands of anyone on the internet, and `slug` is unique,
so a script could squat every plausible hospital name. It also conflates two
different facts: "these people asked" and "this hospital exists". A rejected
application has to stay on record without ever having been a hospital.

**The form cannot be used to learn anything.** It gives the same answer whether
or not that email has applied before, and it does not check slug availability
live — both would turn a public endpoint into a way to enumerate the vendor's
customers and prospects. Duplicates surface in the reviewer's queue instead, and
a slug collision is reported at approval where a human can pick another.

**Nobody could find the form, on either client.** Reported by the product owner:
*"we should have an option for the public user to apply for a tenant"* — which
already existed, as `POST /public/signup` and `web/app/signup/page.tsx`, and was
reachable only by typing a URL nobody had been given. **Eighth instance of a
capability with no route in, and the widest in consequence**: a hospital that
wanted to buy the product could not ask.

The mobile half sat in `endpoint-coverage.spec.ts`'s single-client list saying
*"signing up is done by somebody who is not yet a customer and has no reason to
have installed a staff app"* — the **fourth false reason** found in that list,
and the same shape as the three before it. The app is on a public store. A clinic
owner who finds it, installs it and opens it is precisely the customer this file
describes as the target market, and they met a sign-in form with no way in.

Both clients now link it from the login screen, below the password field —
everybody who opens that screen on an ordinary day already has an account, so it
must not compete with signing in. The label is **Apply for an account** rather
than *Register*, because "register" on a login screen promises self-service and
this creates a `TenantApplication` a human reads: no hospital, no account, no
slug reserved until approval. The exemption is deleted rather than reworded, so
the guard now fails if either caller disappears.

**The slug field was labelled "Preferred web address", which was false rather
than merely unclear.** Asked what that field was for, the product owner guessed
it might be the name another hospital recognises them by — which is exactly
right, and the label was not saying it. The slug appears in **no URL anywhere**
in this product: there are no per-hospital subdomains and no tenant path
segment, checked against every use rather than assumed. What it actually is, in
the only two places anybody meets it, is the **code a partner pharmacy or
laboratory identifies this hospital by** (partnerships start offline precisely
because a browsable directory is the enumeration problem this form avoids) and
**what staff type at sign-in when they hold accounts at two hospitals**. Both
clients now call it *Short code for your hospital* and name both uses. A label
somebody has to ask about is a label that has failed, and this one was inviting
the reader to expect a website.

On mobile it is a sibling of `LoginScreen` rather than a route, and that is
forced: `AuthGate` renders above the navigator so no deep link can land past the
lock, which means nothing under `app/` renders while there is no user — a
`signup` route would have been unreachable to exactly the person it exists for.

**The application asks what they run, and the answer is a request.** Asked for by
the product owner: *"ask the customer which module they want — whether they want
the pharmacy, the entire hospital, or the lab and clinic."*
`TenantApplication.requestedModules` holds it, and it is advisory in exactly the
way `requestedSlug` is: **the vendor still sets `Tenant.modules` at approval**,
because what a hospital was *sold* is a commercial fact a human decides after
reading the application, and a public endpoint that decided its own entitlements
would make the approval step theatre.

What it buys is that the reviewer's picker **opens on the customer's answer
rather than on all five**. It defaulted to everything, so approving a pharmacy
silently handed it the wards and the clinic unless somebody noticed and corrected
it by hand every time — and a default nobody adjusted is the commonest way a
hospital ends up with a menu of screens it never bought. Still fully editable,
which is the point rather than a caveat: somebody who asked for everything and is
being sold a pilot gets the pilot.

**Empty means "did not say", and is deliberately not all five.** The column is
not backfilled and existing applications keep `[]`, because defaulting historic
rows would put an answer into the record nobody gave and the reviewer would meet
it as a customer's choice. At the *picker* an empty set falls back to all five —
"did not say" must not silently become "wants nothing", which would provision a
hospital with no screens at all over an optional question somebody skipped. The
console shows *Asked for* only when they actually answered.

**Bundles, not five checkboxes, and the set is what travels.** `TenantModule` is
the vendor's vocabulary — "Wards" means nothing to a clinic owner deciding
whether to try the product, and a public form is the one screen here read by
somebody with no account and no training. So `SIGNUP_BUNDLES` offers *"A
pharmacy only"*, *"A clinic with a laboratory"*, *"A hospital — everything"*, and
the module set is derived at submit. The **bundle id never leaves the client**: a
plan name in the data model is precisely what `Tenant.modules` is a set to avoid,
and the backend would then have to keep translating it forever, including for a
bundle nobody sells any more. It lives in `types.ts` because that file is already
duplicated byte-for-byte into `mobile/lib/types.ts` with a drift test — so the two
clients cannot disagree about what "a pharmacy" includes, which they otherwise
would silently, and the person meeting the difference would be a reviewer looking
at a set that did not match the words the applicant was shown.

**The temporary password is returned exactly once.** Approval creates the tenant
and its first ADMIN in one transaction — a tenant with no admin is a hospital
nobody can sign into that is also holding the slug, so the retry collides with
the wreckage of the first attempt. `mustChangePassword` is set, which is one
reason `SubscriptionGuard` exempts the password-change route.

### A lapsed subscription is read-only. It is never a lockout

`SubscriptionGuard` refuses writes for a hospital whose subscription has lapsed
and lets every read through unconditionally. Not login, not GETs, not the
password change a forced user needs, and not the platform routes the vendor
restores access with — that last one would be a deadlock with no way out.

The commercial instinct is to deny access until somebody pays. Here that means a
clinician cannot open a patient's allergy list because a card expired, and the
people harmed are not the people who owe the money. It is the same argument
`consultation-billing.spec.ts` already enforces one level down — software must
not refuse care over an unpaid balance — and holding that line for a patient's
bill while abandoning it for the vendor's would be incoherent.

Blocking writes is real leverage and it is safe: a hospital that cannot book
tomorrow's appointments calls within the hour, and nobody already in the
building is endangered by it.

**`PAST_DUE` restricts nothing on its own.** Chasing an invoice and restricting
a hospital are different decisions taken at different times; collapsing them
means the first overdue day silently becomes the restriction with no human
having decided it should. **A NULL end date is not an expired one** — open-ended
is the normal shape of an invoiced hospital contract, and defaulting an absence
to "cut them off" turns a data-entry gap into an outage.

The guard keys on the HTTP method rather than a list of routes, because a route
list rots: the first write somebody forgets to add keeps working after a
hospital has been suspended, and nothing would say so. Both clients warn a
fortnight ahead — being surprised by a restriction is most of the harm.

### A hospital only sees what it was sold, and that is a set rather than a plan

A standalone laboratory is a real customer of this product, and so is a
pharmacy. Neither manages doctors, admits patients or runs a ward — and showing
them those screens is not a harmless extra. It is a menu of things that do not
work, a role list offering staff who have nothing to do, and a first hour spent
finding out which half of the product is theirs.

`Tenant.modules` is a `TenantModule[]` — CLINIC, WARDS, PHARMACY, LABORATORY,
BILLING — and defaults to all five, so every hospital that predates this keeps
exactly the product it already had.

**An array, not a plan name.** A plan is a commercial fact that changes for
reasons this system does not model: a discount, a pilot, a clinic that bought
the laboratory a year after the practice. The question the code always asks is
"does this hospital have the laboratory", and a set answers it without anybody
adding an enum member the day somebody sells a new combination. Five booleans
would be five places to forget and a sixth migration for the sixth module.

**Patients, staff, settings and the audit log carry no module.** Every tenant
needs somebody to serve, somebody to serve them, and a record of who did what —
a module nobody can turn off is not a module, it is the product. An empty array
is legal and means exactly that floor, which is a real state during onboarding
rather than a broken one. `module-coverage.spec.ts` asserts the always-on
directories stay undecorated, because gating staff accounts would leave a
lab-only tenant unable to register the person whose blood they are about to
take — the feature working against the customer it exists for.

**`ModuleGuard` refuses the route outright — reads included — and
`SubscriptionGuard` still never refuses a read.** The two guards look alike and
the difference between them is the most important thing in this section.

This guard originally copied the subscription rule wholesale, including its
read pass-through. The result was reported from use: *"I set a tenant to
pharmacy-only and he can still see all those modules."* Menus were hidden by the
client, records were reachable by URL, and the restriction was real only in the
UI — the exact failure `canReach` was written to stop one layer up.

The reversal is safe because a module is not a subscription:

- **A lapsed subscription is automatic, common, and about money.** A card
  expires overnight, and the person harmed by a hidden allergy list is a
  clinician rather than whoever owes the invoice. Reads must never be refused
  for it, and still are not — `module-coverage.spec.ts` pins that half in place
  precisely because the tempting tidy-up is to make the two guards match.
- **A module is what the hospital was sold.** Set by a human at the vendor,
  changed rarely, behind a confirmation that states how many records are about
  to become unreachable — and undone by one click of the same console. A
  pharmacy that never bought the clinic has no appointments to hide, and a
  screen it can never use is furniture.

So the guard keys on nothing at all: no verb check, because there is no read to
let through, and a verb check reintroduced here would quietly turn the boundary
back into a menu. Its absence is asserted rather than trusted.

**Nothing is deleted, and both clients say so.** A module handed back brings its
records with it, which is what makes refusing the read defensible rather than
destructive.

What is never refused is the floor: patients, staff accounts, clinic settings,
the audit log and printing carry no module at all. A hospital reduced to nothing
still has its patient list, its people, and the record of who did what.

`documents` is deliberately ungated for that reason. It renders a prescription,
an invoice and a lab report from three different modules, and gating it on any
one would be wrong for the other two.

The class-level `@RequiresModule()` is the only thing that has to be remembered,
and `module-coverage.spec.ts` fails the build on any controller in a module's
directory without one — **the guard cannot see what it was never told about**,
which is the same shape as `endpoint-coverage.spec.ts`. A route list would rot
the same way.

**Roles follow modules, and that includes reception.** A tenant without the
laboratory is not offered LAB_TECHNICIAN, because the alternative is an account
created, able to sign in, and met with a menu of nothing — the mirror of the bug
where a role existed everywhere except where it could be granted.

RECEPTIONIST was always-on beside ADMIN at first, on the reasoning that every
business has somebody at the door. True, and the wrong noun: reception *in this
product* is the appointment book, the check-in queue and the doctors list, which
is the clinic. At a standalone pharmacy the person at the counter is the
pharmacist. It now requires CLINIC, and **ADMIN is the only always-on role** —
a tenant nobody can administer needs the vendor for every staff change.

**The server refuses the role, not just the picker.** `assignableRoles` shipped
in the backend with **no caller at all**: both clients narrowed their lists and
`POST /users` accepted anything, so the narrowing was a suggestion one curl
wide. `UsersService.refuseUnsoldRoles` now runs on create and on assignment, and
names the missing module rather than the role, because the module is the part an
administrator can act on. Only *newly granted* roles are checked — somebody who
already holds one whose module has gone keeps it, since a commercial change must
not strip a member of staff mid-shift as a side effect.

`ROLE_REQUIRES` exists in all three projects for the reason `types.ts` and
`course-quantity.ts` do, and `module-coverage.spec.ts` now compares the three:
a role one client offers, another hides, and the server refuses is worse than
any single copy being wrong, because the person who has to explain it is an
administrator who clicked the same button on a different device.

**Modules and the subscription are separate on purpose.** One is what they
bought, the other is whether they have paid. Collapsing them would mean an
overdue invoice silently taking a module away and a payment silently giving one
back — two different decisions, taken by two different people, at two different
times. Both stop writes; only the module takes the screen away.

**The vendor sets them at approval and afterwards**, and this is the sixth time
in this project that a setting has had to be given a route a human can reach.
`acceptsExternalLabOrders` shipped as a column the lookup read and no screen
could write, so adding a partner laboratory was refused correctly and
unexplainably; before that, seed-only wards, a seed-only medicine catalogue,
doctor profiles creatable only as a side effect of a new account, and
drug-chart items no screen could schedule. `module-coverage.spec.ts` now asserts
the console *sends* the field on all three paths — approval, direct creation and
change — for the reason `settings-reachable.spec.ts` settled on after three
attempts: reading a setting and being able to change it are different
capabilities, and a test that conflates them signs off a console that can list
what a hospital has and never alter it.

`PATCH /platform/tenants/:id/modules` takes **the complete set, never a delta**.
Two vendor staff with the console open would otherwise apply two half-changes
to a row neither of them read. The response carries `strandedRecords` — how much
the hospital already holds in what was just removed — because "removing the
laboratory" and "removing the laboratory from a hospital with 4,200 results in
it" are different acts and only one should happen without a conversation. The
count exists only in the response, so the confirmation is before and the count
is after; the console leaves the drawer open on success rather than throwing
away the one thing worth reading.

The change is written into **that hospital's own audit log**, not a vendor-side
one, for the same reason break-glass access is: the morning their staff find a
menu item gone, somebody there will ask what changed, and that answer belongs
in their records.

**A hospital can read its own plan**, on the clinic settings screen beside its
code. Read-only — an administrator who could change it would be selling
themselves the laboratory — but showing nothing was a real gap: a module
removed this morning and a module never bought look identical from inside,
because the menu simply omits the screens and the 403 that names the module
only arrives if somebody finds a way to attempt a write. It is also the only
place either party can confirm, during the telephone call, that a change the
vendor just made actually reached them.

#### The menu and the guard disagreed, and the user met the difference

Refusing reads made a second fault visible immediately. `Today's Queue` carried
no module tag, and it calls `GET /me/queue`, which lives under `src/me/` and is
gated on CLINIC. So at a pharmacy-only tenant a doctor signed in, was landed on
the queue *because it was the first item in their own menu*, and met a 403 as
the first thing they saw.

The guard was right and the menu was wrong, which is the worst arrangement of
the two: a refusal the user did nothing to cause, on a screen the app itself
chose to open. Neither existing test could see it — `endpoint-coverage` knew
`/me/queue` had a caller, `module-coverage` knew the controller was decorated,
and **nothing compared the client's idea of which module a screen belongs to
against the server's**.

`nav-modules.spec.ts` does that now: it resolves each nav href to its
`page.tsx`, reads the API paths out of it, maps each to the controller that owns
it by longest base, and fails on any item untagged for a module its role does
not already imply. It found `/pharmacy/supply` at the same time — the
pharmacist's ward-supply queue, which is WARDS work behind a PHARMACY tag.

**A nav item declares only what its role does not already guarantee.** A
PHARMACIST cannot exist without PHARMACY, so a pharmacy screen in their menu
needs no tag; `Ward Supply` needs WARDS, which reads oddly on a pharmacy screen
and is exactly right — what that screen needs is a ward to ask.

**Three screens are on the floor and reach past it, so they degrade instead.**
The patient record is every tenant's, and its Records and Prescriptions tabs are
the clinic while Tests is the laboratory; clinic settings is every tenant's, and
its tax block is billing; a hospital always sees its own takings, and the
doctors card beside them is the clinic. Each part hides itself, and each is
listed with its reason in a test that fails when the reason goes stale.

The extractor strips comments first. Without that it reported three screens as
untagged because their header comments *mention* sibling routes — and a false
positive there is not harmless, because it is answered by adding an exemption,
and an exemption list that has absorbed a broken extractor is how real gaps
disappear. That has happened here before.

**A role can now be left with no screen at all**, and that produced an endless
spinner. `landingFor` falls back to `/patients`, which `canReach` refuses for a
role with no Patients item, so the layout redirected, was refused, and
redirected again. Only reachable by a grandfathered account — roles follow
modules when granted, and somebody already holding one keeps it — which makes it
rare and makes the person least able to guess what happened the one who hits it.
`hasAnyScreen` detects it and the layout says which module the role needs and
that nothing has been deleted.

#### The column existed, the model did not, and nothing enforced anything

`Tenant.modules` shipped as a hand-written migration that added the column, a
`TenantModule` enum, a guard that read it, a vendor console that set it, and
three clients that narrowed their menus by it — and **no field on `model
Tenant`**. Every part of the feature was present except the one line joining the
database to the code.

The report was *"I set a tenant to pharmacy-only and they can still do
everything"*, and the path from cause to symptom is worth keeping:
`prisma generate` builds the client from the model, so the generated client had
no `modules`; `SESSION_USER_INCLUDE` selects it, so every login would have
thrown; and the only file that failed to compile was `platform.service.ts`, four
files away from the omission. A watching dev server holds the last good build
when compilation fails — so the running API was the one from before modules
existed. Enforcing nothing, looking healthy.

**Everything downstream fails open, and that is deliberate.** `navFor`,
`canReach` and `assignableRoles` all read an absent module list as "do not
narrow", because a blank menu for every member of staff is worse than a wide one
when a build is stale. The cost is exactly what happened: a missing field
disables the *restriction* rather than the feature, silently and completely.

`schema-drift.spec.ts` closes it in the direction that fails quietly — for every
`ADD COLUMN` in every migration, the model that owns the table must declare a
field for it. The reverse needs no test: a model field with no column throws on
the first query. `prisma migrate diff` is the proper tool and needs the schema
engine binary, whose download is blocked on this machine, which is why all
twelve migrations here are hand-written; this is the check that survives that
constraint — text against text, no engine, no database.

Seventh instance of the family, and the most embarrassing: not a refusal with no
route out, but a route out with nothing behind it.

### The vendor console shares a deployment, and that cost something

`endpoint-coverage.spec.ts` used to fail the build if `/platform` appeared
anywhere in `web/` or `mobile/`. That was right while the console was curl-only
and stopped being expressible when the console was built at
`web/app/(platform)`.

What is unchanged is the security boundary, which was always the server:
`PlatformUser` has its own login and token audience, `PlatformGuard`
deliberately sets no `req.user`, and `RolesGuard` admits nobody without a
`UserRole` — so a hospital token cannot reach a vendor route however it is
pointed. What was given up is defence in depth: platform code now ships in the
same build a receptionist loads. Next.js chunks route groups separately so in
practice it is not in their bundle, and "in practice" is doing work in that
sentence.

Two assertions replace the ban. Only `web/app/(platform)` and
`web/lib/platform*` may name the vendor API — any other file in `web/` fails,
and mobile keeps the outright ban. And the console may call **nothing but**
`/platform`, so a vendor screen reading clinical data fails at the moment it is
written rather than when it 401s in somebody's browser.

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

**"Some client calls it" is a weaker claim than it reads as.** The test asked
whether *a* client called a route, which is the wrong question when two clients
serve the same role. `POST /appointments/:id/invoice` was wired into the mobile
schedule screen and never into the web check-in screen — so a receptionist at
the desk, which is most of them for most of the day, had no way to bill a
patient they had just checked in. Coverage was green the whole time, because
mobile counted. A user found it; no test could.

Web and mobile call sets are now compared separately. `WEB_ONLY` and
`MOBILE_ONLY` hold deliberate single-client routes, each with its reason —
mobile is a curated subset, so a blanket "both clients call everything" would be
false and would get silenced by exempting half the API. `PARITY_GAPS` holds real
holes and is kept apart from both for the same reason `KNOWN_GAPS` is kept apart
from `INTENTIONALLY_UNCALLED`. The test fails on any *new* single-client route,
so the decision gets made when it is introduced rather than discovered months
later by the person it inconveniences.

**Exemptions are split in two, and the split is the point.** `INTENTIONALLY_UNCALLED` is design decisions; `KNOWN_GAPS` is missing UI. One list holding both means a reader skims "fine, ignore these" and the real holes vanish into it. A test fails if a `KNOWN_GAPS` entry is not also written down in [`PLAN.md`](PLAN.md), so nothing can be parked there quietly, and another fails the moment an exempted route gains a real caller — the list has to shrink on its own or it rots into claims nobody rechecks.

### A prescription can be filled somewhere else, and the copy is the point

Every prescription used to land in this hospital's dispensing queue, because
there was nowhere else for one to go. That is wrong twice over: a clinic with no
pharmacy grows a queue nobody works, and a patient using the chemist near home
still reads as waiting at a counter they will never visit.
`Prescription.destination` is IN_HOUSE, EXTERNAL or PARTNER, and
`Tenant.hasPharmacy` removes the question entirely for a clinic that has none.

**A destination is a filter, never a refusal.** The queue shows IN_HOUSE only;
`prepareDispense` and `dispense` do not look at the destination at all. If the
patient changes their mind and walks up to the counter, the pharmacist hands it
over. `referral.spec.ts` asserts the absence of that check, because a routing
note hardening into "computer says no" is the same failure the payment gate and
the subscription guard both refuse.

**Sending to another tenant transmits a copy. It does not share a row.** This is
the first feature that deliberately moves patient data across the isolation
boundary, and there were two ways to build it. The rejected one was a policy
exception making a prescription tagged for hospital B visible to B — one line of
SQL, after which `tenantId = app_current_tenant()` is no longer the whole truth
and every future reader of that policy has to know about the carve-out. Instead
a `PrescriptionReferral` snapshot is written **into the receiving tenant's
scope**, owned by them, protected by their own policy like any other row of
theirs. That is also how real e-prescribing works: you send a message, you do
not grant database access. The write enters the destination's scope inside one
transaction, exactly as provisioning had to after its first live run.

**It is a snapshot, and that is deliberate.** Medicines are copied as text at
the moment of sending. A later edit at the prescribing hospital must not
silently change what another company is about to hand a patient — the same
reasoning that keeps `DispenseLine.unitPrice` and `PrescriptionItem.medicineName`
as captured values. `PrescriptionReferralItem` carries no `medicineId`, because
the receiving pharmacy has its own catalogue and mapping is a human job at the
counter.

**What crosses is the patient's name and date of birth, the medicines, and the
prescriber.** No diagnosis, no notes, and **no allergies** — minimum-necessary
applies at least as strongly across a company boundary as across a role one,
since the receiving hospital is bound by none of this one's policies. The
consequence is stated rather than hidden: `allergyChecked` is false on every
referral and both clients say *no allergy check was run*, because an empty
warning panel reads as "nothing found" and that is the most dangerous available
misreading. `NEVER_TRANSMITTED` is data so a test can assert on it.

**Nobody can browse the directory.** A dropdown of every hospital running a
pharmacy would turn the vendor's customer base into something any administrator
can read — the enumeration concern that already shapes the public signup form.
Partnerships start offline: the pharmacy gives out a code, the hospital types it,
and the lookup answers only for tenants that have set
`acceptsExternalPrescriptions`. "No such code", "they have no pharmacy" and
"they have not opted in" are one identical refusal, for the same reason login
does not separate "no such account" from "wrong password".

**The handshake is two-sided, and hiding half of it made the feature look
absent.** The receiving pharmacy sets `acceptsExternalPrescriptions`; the
sending hospital adds them under Partner pharmacies. Neither alone does
anything — which is correct, and was invisible. Both prescribing screens
omitted the partner option entirely when the list was empty, so an
administrator who switched on the receiving side saw two choices and nothing
saying the setup was half finished. Worse, there was nowhere in either client
to read your *own* code, so the one thing the other hospital needs could not be
found: the settings screen said "the code your provider gave you", and the
provider had never given one.

A hidden option is indistinguishable from a feature that does not exist, and a
user cannot debug what the UI declines to mention. The option is now shown
disabled with the missing half named.

**A hospital's own code is shown unconditionally**, at the top of clinic
settings on both clients — not beside the setting that consumes it, which is
where it was put first and was wrong twice. Nobody can decide whether to accept
external prescriptions without seeing what they would be handing out, and the
code identifies them to support regardless of pharmacies. It is safe to show:
the enumeration concern is about *listing* hospitals, never about one knowing
its own name.

It is also the only place the string appears at all. The vendor picks the slug
at approval, nothing conveys it to the customer, and the login form has no
hospital field — so the approval screen labels it *their code* rather than as an
internal identifier, and says it can be read again later, since unlike the
temporary password it is not secret and not one-shot.

**Removing a partner is reversible, and for a while it was not.** Remove is a
soft delete and has to be — prescriptions already sent carry
`routedToTenantId`, and "where did this go" is asked precisely when a
partnership has ended. But the unique index covers inactive rows too while the
list shows only active ones, so re-adding a removed partner was refused as
*already one of your partners*, naming a row the administrator could not see
and had no way to reach. The only exit was a database console.

Adding now reactivates an inactive row and takes the label from the new
attempt. The tempting repair — hard-delete on remove — makes the symptom go
away and silently breaks every prescription already routed there, so
`referral.spec.ts` asserts both halves: that the lookup does not filter on
`isActive`, and that remove never deletes.

The bare `catch` beside it went at the same time. It reported *every* failure
as a conflict, so a dropped connection during an add would have sent somebody
looking for a partner row that was never written.

**A dispensing screen states the quantity, and states when it cannot.** A line
reading `Amoxicillin 500mg · 2 · 7` made a pharmacist infer that "2" meant
twice a day and then multiply — mental arithmetic at a counter, which is where
dispensing errors come from. `dispense-quantity.ts` turns the three free-text
fields into words and a total, on the server, so both clients show one number.

The three inputs are not equally trustworthy and the code says so. A bare "2"
in the *frequency* field is read as a rate, because that is the field it was
typed into, and the reading is printed next to the doctor's original text so a
pharmacist can disagree with it. `500mg` is a strength, not a count — how many
capsules make a dose is a property of the product on the shelf, which this
system does not model — so the answer there is in **doses**, which is exact,
rather than in tablets, which would be a fabrication that happens to be right
for the common case. PRN, "as directed" and open-ended durations produce no
total at all, and the screen says *quantity not calculated* rather than leaving
a blank, because a blank and a considered refusal look identical.

**In-app links must be `Link`, never `<a href>`.** The access token is held in
memory only, so a raw anchor to an internal route is a full document load that
drops it: the app remounts, the next call 401s, and the user is bounced to the
login screen reading it as a session timeout. Nothing in review looks wrong —
it is ordinary markup — and it only fires when somebody clicks that one link,
mid-task. It escaped twice on the pharmacy screens. `client-nav.spec.ts` now
fails the build on any internal `<a href>`, allowing `/api/v1/...` because
those are downloads that must leave the SPA.

**There is no fulfilment notification, and that is a real gap rather than an
oversight.** The prescribing doctor learns that it was sent, not that it was
collected. Reporting back would mean the receiving hospital writing into the
sending one's rows, which doubles the blast radius of this feature for a
convenience — so it is absent and written down here instead of half-built.

### Being someone's doctor is a window, not a day — and an admission counts

Prescribing and record-writing both required an appointment with you **today**.
That is not how medicine works, and it was two separate failures wearing one
rule.

**A patient rings a fortnight later** about the same problem, or needs another
month of the same tablets. Ordinary practice, and there was no path through the
system at all. It also broke a screen that had already shipped: the patients
list offers Prescribe for anybody, so a doctor could search, write the whole
prescription, and be refused at submit — the API and the UI disagreeing about
what was allowed, which is the shape of failure a user finds and no test does.

**An admitted patient has no appointment**, so a doctor could not prescribe for
or write about somebody in a bed in their own hospital. Worse than it sounds:
`POST /admissions/:id/medication-schedule` builds the drug chart *from* a
prescription, so a newly admitted patient's chart could only ever be filled
from an outpatient visit, and a ward round that started a new drug had nowhere
to put it. Ward cover means the check is not restricted to the admitting
doctor — the doctor on the ward at 3am is routinely not the one who admitted.

So `resolveTreatingScope` accepts an attended appointment within
`PRESCRIBING_WINDOW_DAYS` (90) **or** an open admission. Deliberately not "any
patient this doctor has ever seen": that is a list rather than a relationship,
and somebody seen once three years ago is not under this doctor's care.
SCHEDULED is not an attended status, because a diary entry would otherwise be
enough to reach any patient in the hospital.

**Widening the rule changed nothing until the web app offered a way in.** The
API accepted a repeat the moment `resolveTreatingScope` shipped, and the web
patient record had no button to write one: the only entry to the prescription
sheet was *Cancel & rewrite* on an existing prescription, and everything else
went through today's queue. Mobile already had a standing "Write prescription"
on the patient screen — so this was the parity gap running the *other* way,
and `endpoint-coverage.spec.ts` could not see it because both clients call
`POST /prescriptions`. What differed was which patients a client could reach
the sheet *from*, which no current test expresses.

Both tabs now offer it, prescriptions and records together, for the same
reason the backend rules moved together.

**A repeat is written because of what came before, so the sheet shows it.**
Both prescribing screens now list this patient's earlier prescriptions inline,
collapsed, with a *Use these* action that copies the lines in. Distinct from
the shortcut chips above them, which are what *this doctor* writes most often
across everybody; this is what *this patient* was actually given. It grants no
new access — the same read the Prescriptions tab already had — but a doctor who
must close the sheet, read a tab, remember four lines and reopen will retype
from memory, and memory is where dosing errors come from. Cancelled ones are
shown rather than filtered: "we stopped that" is exactly the context being
looked for, and hiding it reads as never prescribed.

**Both rules moved together, in one file, on purpose.** Widening only
prescribing would have let a doctor issue a medication and given them no way to
record why — worse than either restriction alone. The two copies had already
started drifting in wording; `treating-scope.spec.ts` now fails if either
service grows its own `appointment.findFirst` or its own window.

**Permitting is wider than linking.** A prescription or record attaches to an
appointment only when that appointment is *today*. A repeat written six weeks
later is not part of the consultation it followed from — attaching it there
would put it on that visit's record and, since `Invoice.appointmentId` is
unique and billing reads the link, on that visit's bill. A late note filed
under an old appointment would also backdate a clinical document.

Nothing about billing changed: a repeat attaches to no appointment, so it
raises no invoice. Charging for phone advice needs a remote-consultation
encounter that can be billed like any other, which is not built.

### A prescription is a record, not a projection

`PrescriptionItem.medicineName` stays as free text forever — the catalogue link is an *added* nullable `medicineId`, not a replacement. `PLAN.md` said it would become a FK; that would let a catalogue rename silently rewrite what a doctor prescribed months ago. See [`backend/prisma/MIGRATION-PHASE-4.md`](backend/prisma/MIGRATION-PHASE-4.md).

Consequence: items whose text does not match the catalogue cannot be class-checked for allergies or dispensed against stock. They are flagged, not silently treated as safe, and mapped through the pharmacy UI.

### Tax is a named rate per item, not a percentage in settings

A single "tax %" setting is wrong in both places this product is aimed at, and
wrong in opposite directions. An Indian pharmacy stocks items at 5%, 12% and
18% at once, while healthcare *services* are largely exempt — so a consultation
carries no GST and the medicines dispensed at the same visit do. A US clinic
has no national rate at all: it is state plus county plus city, and
prescription drugs are exempt in most states while OTC usually is not.

The shape common to both is a named rate chosen per thing sold. `TaxRate` is
per tenant, `Medicine.taxRateId` points at one, and anything unassigned takes
the tenant's default. A hospital that charges no tax defines none, every line
resolves to zero, and its invoices are byte-for-byte what they were before this
existed — which is the state most clinics stay in, and the case this had to
stay cheap for.

**`taxEnabled` is an explicit switch, off by default.** Not "are any rates
defined" — a hospital builds its rate table, checks it, and turns it on when
ready, rather than the first rate it creates silently taxing every sale. It
also gives the screens something to gate on, so a clinic that charges no tax
never sees a tax control at all.

**Consultations carry their own rate, separate from the medicine default.**
`Tenant.consultationTaxRateId`, and null means untaxed — which is the correct
answer in India, where healthcare services are largely exempt while the
medicines dispensed at the same visit are not. One rate covering both would be
wrong for whichever was configured second, and which one that is would depend
on the order somebody happened to set them up in.

**Every active rate applies to every sale. There is no default.**

The first design made one rate the default and the others inapplicable unless
an item named them. A hospital entering CGST 6% and SGST 6% as two rows
therefore had *one* of them charged — half the tax, on an invoice that looked
entirely plausible, until somebody reconciled a return. The arithmetic was
right and the model was wrong, which is the hardest kind of wrong to see.

So the Tax Rates screen is a list of the taxes this business charges, and they
all apply, added never compounded, each printing as its own invoice line. The
screen states the combined rate so the consequence of adding a row is visible
where the row is added.

An item may still name one rate, for the cases that genuinely differ — 5% and
12% medicines in the same pharmacy. **To make something untaxed, point it at a
0% rate**, which is why rates carry names: exempt and zero-rated are different
on a statutory invoice and identical to the arithmetic.

The same rule covers consultations. `Tenant.consultationTaxRateId` names one
rate when a hospital wants a specific one; left null, every active rate applies
— it previously meant "untaxed", which is why a hospital that had enabled a
consultation rate saw no tax on the invoice.

**A rate has named parts, and they add rather than compound.** India charges
CGST 6% + SGST 6% on the same taxable value — 12% GST is not 6% applied and
then 6% on the result. The United States is the same shape: state plus county
plus city, each on the shelf price. So `TaxRateComponent` rows sum to
`TaxRate.rateBasisPoints`, which stays authoritative — the sale arithmetic
never reasons about parts, and a flat rate has none.

Compounding is absent rather than half-built. It is rare, it needs an explicit
ordering, and a silent guess about which rate compounds on which shows up as an
unexplainable few pence on every invoice.

**The parts are apportioned from the line's tax, never computed separately.**
Rounding each component independently leaves them disagreeing with the tax line
above them — 12% of 1.05 split 6/6 gives 0.54 + 0.54 against a total of 1.05 —
and an invoice whose components do not sum to its own tax line is one an
auditor rejects. `apportionTax` floors each part and hands the leftover pennies
to the largest remainders, ties by position so two runs of a report cannot
disagree.

**The split is captured on the invoice line** as `taxBreakdown`, alongside the
rate and its name. An Indian statutory invoice is invalid without CGST and SGST
shown separately, and it must still reprint correctly next year after somebody
has restructured the rate it used. The rolled-up medicine line billing staff
see carries no breakdown: several rates may be inside it, and merging their
components would print a split belonging to no single rate.

**Basis points, not percentages.** 1250 is 12.5%. An integer, because a rate is
compared, stored and summed, and 0.125 as a float is the trap `money.ts`
already refuses. The DTO and a CHECK constraint both cap it at 100%: the
realistic mistake is typing 12000 meaning 120%, and a basket multiplied out by
that is enormous, confident and wrong.

**`pricesIncludeTax` is behaviour, not a display preference.** In India the MRP
printed on a box includes GST and is the number the patient expects to pay, so
the tax is extracted from it. In the United States the shelf price is net and
tax is added at the till. Both are "the price is 10.00" and they mean different
amounts of money, so the mode is resolved per sale and the *result* is captured
on the line.

**`net + tax === gross`, exactly, always.** In inclusive mode the net is
computed and the tax is then derived **by subtraction** rather than calculated
independently. Calculating both and hoping they agree leaves a penny adrift on
amounts that do not divide cleanly — which is most of them — and an invoice
whose total does not equal the sum of its own lines is one a finance clerk
cannot explain. Invoice totals are summed from the already-rounded lines for
the same reason: with two rates present, tax on the basket total is a different
number from the sum of the line taxes, and it is the one that cannot be
reconciled against what is printed.

**The rate is captured on the invoice line**, name included —
`taxRateBasisPoints`, `taxRateName`, `taxAmount` — exactly like `unitPrice` and
`medicineName`. Raising a rate from 5% to 12% next year must not restate what a
patient was charged today, and an old invoice must stay readable after the rate
it used has been renamed or retired.

Configuration is web-only, like departments and staff accounts: an accounting
decision taken once with the figures to hand, not a one-handed task. Mobile
deliberately does not hold the rate table — the server computes the tax and
sends the amounts, so a phone shows what was charged without carrying the rules
that produced it.

### Money is never a float

Postgres holds `Decimal(10,2)`, application arithmetic happens in integer minor units (`billing/money.ts`), and the API sends and receives strings. `0.1 + 0.2 === 0.30000000000000004`; on one line that is invisible, across thousands of payments it is a dispute a finance clerk cannot explain. `money.ts` refuses to coerce — `parseFloat("12abc")` returning `12` as a payment amount is the failure it guards.

Overpayment is rejected rather than absorbed: a credit balance needs refunds and credit notes to be real, and swallowing the excess loses the patient's money silently.

### Payment happens at check-in, before the doctor

For six phases the flow stopped dead at `COMPLETED`. A doctor finished a
consultation, the patient walked out, and nothing told anyone to charge them —
there was not even a field recording what a doctor charges.

**Reception raises the invoice at check-in**, one tap, fee prefilled:
`POST /appointments/:id/invoice`. The patient arrives, pays at the desk, and
then waits to be seen.

This was built the other way round first — billable only once `COMPLETED` —
which is the insurance-led model and wrong for the clinics this is aimed at.
Billing after the consultation means chasing someone who has already left the
building. Billable statuses are now `CHECKED_IN`, `IN_PROGRESS`, `COMPLETED`:
not `SCHEDULED`, because a patient who has not arrived may never arrive, and not
`CANCELLED`/`NO_SHOW`, which are revenue invented from an empty chair.

Still a deliberate tap rather than automatic on check-in. Free follow-ups, staff
patients and written-off visits are ordinary, and each auto-invoiced one would
need voiding — an audit trail full of corrections is worse than one tap by the
person the patient is standing in front of.

**Paying is offered, never required, and must not become required.** Nothing in
the clinical path checks whether an invoice exists or is settled: a doctor sees
the patient regardless, and the charge can be raised or collected afterwards —
which is why `COMPLETED` stays billable. That is a safety position rather than
an omission. A payment gate reads as tidy and fails at the only moment it
matters: the patient who deteriorated in the waiting room, the one whose card
was declined, the one the clinic chose to treat for nothing. Refusing care over
an unpaid balance is not a decision software should make on a clinic's behalf.
`consultation-billing.spec.ts` asserts the *absence* of such a gate across the
four clinical services, because adding one looks like an improvement to anyone
who has not thought it through.

**The fee is per-doctor** (`Doctor.consultationFee`), and **no fee is not zero**.
Blank means checkout refuses and names the doctor; zero means the consultation
is genuinely free. Collapsing them would make a forgotten price look like a
decision, and the first anyone would know is a month of unbilled work. Admins
set it on the doctors screen — which finally gives `PATCH /doctors/:id` a
caller, six phases after it was written.

**`Invoice.appointmentId` is UNIQUE**, so billing the same consultation twice is
impossible rather than discouraged — including two receptionists tapping at
once. Same argument as the appointment slot indexes: the constraint is the
guarantee, the service check is only for the message.

**The route lives on `AppointmentsController`, not `BillingController`.**
`access-matrix.spec.ts` asserts every billing route is exactly
`[ADMIN, BILLING_STAFF]` and calls that the cleanest role boundary in the
system; adding reception there to save an import would have traded a real
guarantee for a file location. Checkout is an appointment action anyway.

**Who collects is a role-assignment question, not a code one.** Reception can
raise the charge and read the amount back. Whether they may also take the money
depends on whether that clinic also gives them `BILLING_STAFF` — which the
multi-role work already supports, and which is exactly right for a small
practice where reception *is* billing.

### Billing must not learn clinical facts — restated once the pharmacy started billing

The rule for six phases was: invoice lines are typed by billing staff or picked
from service presets, **never generated from prescriptions or dispensing**,
because a line reading "Amoxicillin 500mg × 21" routes a medication history to
billing past the role-shaped patient response.

That rule could not survive a pharmacy that charges for what it sells. A receipt
which does not name what was bought is not a receipt, and in most places not a
lawful one. But the rule was not wrong — it was aimed at the wrong noun. It was
written to stop a *consultation* invoice leaking a *diagnosis* to a general
billing clerk. The pharmacist who sold the amoxicillin already knows about the
amoxicillin.

**The rule now: a drug name may appear on an invoice, and may never appear in a
response to BILLING_STAFF.** Enforced in `invoice-response.ts` at layer 3 —
same route, different body per role, exactly what `toPatientResponse` does for
patients. Billing staff get medicine lines collapsed into `PHARM · Medicines
(n items)` with a total and no `medicineId`; the pharmacist who sold them and
the admin who reconciles both sets of books get the itemisation.
`invoice-response.spec.ts` asserts on the *absence* of every drug name in the
serialised body, not field by field — a later `originalDescription` "for
reference" must fail.

**The dishonest version was available and refused.** Generating the lines from a
`Sale` object rather than "from dispensing" would have left the old sentence
standing in this file and `consultation-billing.spec.ts` green, while the thing
they described quietly stopped being true. Same move the consultation ledger
invited, refused for the same reason: a safety net somebody has stepped around
is worse than none, because the next reader believes it.

Insurance fields go the other way: billing and reception get them, clinicians do not. Minimum-necessary cuts both directions.

Consultation billing was the first auto-generated line, and it follows the tariff-code rule to the letter: `CONS · Consultation`, with **no doctor name**. In a hospital with an oncology department, "Consultation — Dr Chen" tells billing which department the patient attended, which is a clinical fact reaching a role `toPatientResponse` withholds it from. `consultation-billing.spec.ts` asserts the description is a constant and that no template literal can ever be interpolated into it. `pharmacySummaryDescription` is held to the same standard: built from a count and nothing else, because "PHARM · Antibiotics (2)" is a therapeutic class on a bill — the identical leak in tidier clothing.

### The pharmacy is a department or a business, and the tenant says which

`Tenant.pharmacyBilling` is one setting, because three questions follow from it
and they must not be able to disagree: whose invoice a dispense lands on, who
may take the payment, and whose takings it counts towards.

- **SEPARATE (default).** Medicines are charged on their own `PHARMACY` invoice,
  paid at the pharmacy counter through `/pharmacy/invoices/:id/payments`, and
  reported apart from the hospital's takings. Billing staff never see these
  invoices — `visibleInvoiceKinds` scopes the list by role, so the two ledgers
  are disjoint rather than filtered views of one.
- **COMBINED.** Medicines are appended to the patient's open hospital invoice so
  there is one balance to settle. A *settled* invoice is never reopened — a
  second one is raised instead, because appending to a paid invoice is the
  balance-reappears loop the credit-note work was written to close.

SEPARATE is the default deliberately: it is the mode where drug names cannot
reach a role with no clinical business, so a hospital that wants one bill opts
in, which is the right way round for a decision with that consequence.

**The routes live on `PharmacyTillController`, not on `BillingController`.**
Adding `PHARMACIST` to `@Roles(BILLING_STAFF, ADMIN)` was three characters and
would have cost the cleanest role boundary in the system — `access-matrix.spec.ts`
asserts every `/billing` route is exactly `[ADMIN, BILLING_STAFF]` and names it.
The *service* is shared, because the payment arithmetic, the refund-versus-credit
distinction and the overpayment refusal were hard to get right once. Keeping the
two apart is done at the resource layer, inside `BillingService`, which is where
a guard structurally cannot reach.

**A dispense that never left the counter is reversed, not refunded.** The
patient could not pay, or changed their mind, and the medicine is still on the
pharmacist's side. Nothing physically happened, so nothing should be recorded
as having happened: `POST /pharmacy/dispense-events/:id/reverse` returns stock
to the **exact batches** it came from, un-dispenses the prescription items,
recomputes the prescription's status, and voids the invoice — all in one
transaction, because a half-done reversal is the worst outcome available here.

Stock goes back to `DispenseLine.batchId` rather than to "the medicine".
Returning units to whichever batch is nearest expiry would quietly move stock
between batches, and the batch number is what a recall is traced by.

The status is **derived**, not set to ISSUED: a prescription dispensed in two
goes with only the second reversed is PARTIALLY_DISPENSED, and assuming
otherwise would put a half-filled prescription back in the queue as though
nothing had been handed over.

**Two refusals, both load-bearing.** The caller must affirm the medicine did
not leave the premises — that is the only fact distinguishing this from a
return, and nothing in the data can tell them apart, so it is recorded as a
decision a person made, like the allergy override. And it refuses once money
has been taken: voiding a paid invoice would make a payment vanish from the
day's takings with nothing to explain the gap. Refund first, then reverse.

**A pharmacy refund does not restock.** Money returns; the medicine does not go
back on the shelf. Dispensed medicine has left the pharmacy's control and in
most jurisdictions cannot lawfully be resold, so an automatic re-increment would
be a regulatory problem wearing the shape of a convenience — and it would
overstate the number the whole dispensing flow trusts. Putting a returned box
back into saleable stock is a deliberate act: `POST /pharmacy/stock`, with its
own trail. Voiding is likewise absent from the pharmacy path: the sale
physically happened, so the correction is a refund and a credit.

**A missing price is fixed where it is found.** "Not priced" on the dispensing
screen was a dead end: the pharmacist had to abandon the sheet, price the
medicine in Inventory and start the dispense again, with a patient at the
counter. In practice the medicine went out unpriced and the loss surfaced a
month later in a report. Both dispensing screens now set the price inline
through the same `PATCH /medicines/:id` the catalogue editor uses — a shortcut
to a capability PHARMACIST already held, not a new permission. An unmapped item
still cannot be priced, because there is no catalogue row to put the price on;
mapping is the fix there and the screen says so.

That change made `PATCH /medicines/:id` stop being web-only, and
`endpoint-coverage.spec.ts` failed on the stale exemption the same minute —
which is the behaviour that list exists for.

**Referrals are a queue *and* a history.** `GET /pharmacy/referrals` takes
`?status=waiting|dispensed|declined|all`, and both clients segment on it. The
list was waiting-only, so a referral vanished the moment it was handed over and
"which patients did the other hospital send us, and what happened to them"
could not be answered although every row records it. Third time this shape has
appeared — the pharmacy invoice list hid every settled invoice, the refund
screen could not find a paid one. Filtering a list to the open items is the
natural thing to build and it is wrong every time, because the question people
bring to a screen is usually about something that has already finished. The
outcome is sent as data rather than implied by which tab returned the row, and
Dispense/Decline only render on the waiting tab.

**The pharmacy has its own numbers, because the questions differ.**
`GET /pharmacy/dashboard` reports sales, billed, tax, collected, refunded and
reversals over today, seven rolling days and the hospital's month, plus what is
unpaid at the counter all-time. An owner asks what the clinic collected; a
pharmacist asks what left the shelf, what came back, and whether anything went
out unpriced — and in SEPARATE mode the admin dashboard deliberately keeps the
shop's trade *beside* the hospital's, so a pharmacist looking there sees either
nothing of their own or their figures mixed with consultations.

Every figure is gross with its reversal beside it and the net derived, the same
rule the finance report was rewritten to follow. Sales are counted from
dispense events rather than invoices, because a handover with no price still
leaves the shelf — `unpricedSales` is the number nothing else surfaces daily,
and it is how a month of unbilled stock happens. Reversals are counted apart
from sales rather than subtracted: a reversal means the medicine never left, so
doing both would double-count something that did not happen. Outstanding is
deliberately not windowed — an unpaid sale from last week is still money owed
today.

Web gets all three windows side by side; mobile shows today only, above the
queue. Comparing three periods is a reconciliation task that wants a desk, and
one card is what a pharmacist standing at the till actually reads.

**A charge that was never raised can now be raised, and could not be.**
`chargeOrder` raises nothing when every line is unpriced — right, because a
test with no price is performed and not billed. Both order screens warned about
it and the notice said *"the charge can be raised afterwards"*. There was no
way to raise it afterwards: the price is captured on the order item at
ordering, so pricing the catalogue later fixed the next order and not this one,
and nothing anywhere could reach back. Reported from use as a partner referral
where the laboratory's bill arrived and no patient invoice existed at the
sending end. Seventh instance of the shape, and this time the false promise was
in a message I wrote.

`POST /lab-orders/:id/charge` re-reads today's catalogue price onto any unpriced
item and charges exactly as ordering would have — to the same payer the
accession would have chosen, so a referred order still bills the institution
under ORIGIN_PAYS. It refuses on an order that already has an invoice, because
appending to one that may have been paid is the balance-reappears loop the
credit-note work was written to close, and it refuses to report success while
raising nothing, which is how the original problem went unnoticed. It never
touches a `payableExternally` line: *not ours to charge* must not quietly
become *charge it*.

**A laboratory keeps two ledgers, and they were in one list.** Patients pay at
the counter today; hospitals that referred work are invoiced monthly and appear
as `patientId: null`. Mixed together the second is a handful of "no patient"
rows scattered through the first, and *what do referring hospitals owe us* could
not be answered. `?payer=patient|institution` splits them, named after the payer
rather than the column, because "referring hospitals" is the question somebody
arrives with.

**Billing staff see the laboratory's invoices, and never the pharmacy's.**
Reported as `GET /billing/invoices/247 → 404`: a clinic with a doctor and no
bench sends its tests out, the patient pays *there*, and the charge lands on a
LAB invoice — which the clinic's own billing staff could not open, list, take
payment on or refund. The only roles that could were ADMIN and LAB_TECHNICIAN,
and **a clinic with no bench has no technician**. So the one person whose entire
job is collecting money was the role refused, and the only exit was an
administrator or switching `labBilling` to COMBINED, which changes where the
charge lands rather than who may see it.

The wall had been copied wholesale from the pharmacy without the argument
travelling with it. There it earns its keep: a shop's counter takings are not
the hospital's debtors, an unsettled walk-in is an unreconciled till rather than
somebody to chase, and a counter sale often has no patient to chase at all. None
of that is true of a laboratory charge raised against a patient the clinic is
treating.

**Nothing clinical was widened, and that is the part to be sure of.**
`MAY_SEE_LAB_DETAIL` is a separate list and BILLING_STAFF is deliberately not on
it, so every LAB_TEST line still collapses to `LAB · 26-000412-K · Tests (2
items)` for them — a count and an accession, never a test name. The two rules
were always independent and the temptation on opening the first is to assume the
second followed; `invoice-response.spec.ts` now asserts the pair together.

**Aging said it counted hospital invoices only and had no filter at all.** This
file has claimed since the pharmacy shipped that a counter sale is not a debtor
to chase at 30, 60 and 90 days. `aging()` never filtered on `kind`, so every
unsettled walk-in has been sitting in the buckets as patient debt — a stated
rule with no test, which never held for a day. `AGEABLE_INVOICE_KINDS` is
HOSPITAL and LAB: a laboratory charge is raised against a named patient when a
doctor requests a test and goes unpaid exactly as a consultation does. It is
deliberately **not** keyed on the reader's `visibleInvoiceKinds`, because an
ADMIN legitimately sees pharmacy invoices and would drag counter sales back into
the buckets for the very person reconciling against a bank statement.

**The payment link was offered to a role that could not follow it**, in the
screen added last to close a refusal with no route out. NURSE may collect a
send-out specimen — the whole reason that segment exists — and `/lab/invoices`
is LAB_TECHNICIAN's screen, so `canReach` bounced them back to their ward board.
Both clients now show the amount as text for a role with no till and the link
only for one that has it: a nurse standing in front of the patient can still say
what is owed at the desk, which is the useful half.

**Blank is not zero, one shelf over.** `Medicine.sellingPrice` is nullable and
nullable means nobody has priced it — the medicine is still dispensed, still
leaves stock, and is simply not charged for, with the omission named back to the
pharmacist and counted on the admin dashboard beside doctors with no fee. Zero
means the hospital gives it away. Collapsing the two turns a forgotten price into
a decision nobody made, and the first anyone knows is a month of unbilled stock.
The same argument as `Doctor.consultationFee`, and it failed the same way there.

**Dispensing hands straight over to payment.** A successful dispense returns
`charge.invoiceId`, and both clients go directly to that invoice with the
payment form open — web to `/pharmacy/invoices?invoice=`, mobile to the till
tab. The pharmacist has just given the patient their medicine and is about to
take the money from the person standing there; making them find the row they
created ten seconds ago is three navigations for nothing.

**Except when something was left unpriced.** Then the sheet stays put, names
what went out uncharged, and offers the jump as a button. That notice is the
one thing on the screen the pharmacist can still act on with the patient
present, and opening a payment form on top of it buries it — which is exactly
how a month of unbilled stock happens.

It is a shortcut to the next task, never a condition on the last one. Nothing
in the flow checks whether the invoice is settled, and the medicine has gone
either way.

**Payment never gates handover.** Nothing in dispensing or the counter sale
checks whether an invoice exists or is settled. That is the same safety position
as the consultation gate `consultation-billing.spec.ts` refuses: software should
not decline medicine on a clinic's behalf.

**A number in minor units must never reach a render site.** The dispensing
sheet computed a correct total in minor units, called it `totalMinor`, and
printed it with `.toFixed(2)` — showing **3500.00 for a 35.00 basket**. Nothing
could catch it: the arithmetic was right, the types were right (a number is a
number), and the only error was which unit the value was in when it reached the
screen. Found by a pharmacist mid-dispense, in front of a patient.

Every client price calculation now goes through `web/lib/money-lines.ts` —
`lineTotalMinor`, `basketTotalMinor`, `minorToAmount` — so the conversion
exists in exactly one place and a screen cannot do it wrong. It is unit-tested,
including the specific assertion that 3500 formats as `35.00` and not
`3500.00`. The three rules being retyped on each screen were the cause; the
same reasoning as `resolveAuditTarget` and `resolveTreatingScope`.

**Unit prices carry four decimal places; totals carry two.** A tablet at 0.0725
is ordinary. Rounding the unit price to currency precision before multiplying by
30 is out by 3–10% on every line, forever, in the same direction. `pricing.ts`
rounds exactly once, on the line total, half-up because that is what a till does
— and the convention is written down because an unrecorded rounding rule gets
changed by accident.

**What was charged is captured, never recomputed.** `DispenseLine.unitPrice` and
`lineTotal` are written at the moment of sale. Reading the price back off the
catalogue at report time is one fewer column and is the `medicineName`-as-FK
trap again: repricing tomorrow silently restates what every patient was charged
last year. `StockBatch.costPrice` sits on the batch rather than the medicine for
the mirror-image reason — the same tablet costs differently from a different
supplier next month.

**Counter sales reuse `DispenseEvent`.** A `CounterSale` table beside it would
give the hospital two stock ledgers that have to be summed to answer "what left
the shelf today", and the day one of them was forgotten the count would still
look plausible. `prescriptionId` and `patientId` are nullable for the walk-in
case; `Invoice.patientId` is nullable for the same reason and only for it. A
person buying paracetamol is not under the hospital's care, and forcing a
`Patient` row would put a stranger into the list reception searches,
indistinguishable from a real patient.

**A counter sale states that nothing was checked.** With no prescription there
is no prescriber decision behind the medicine, and with no named patient there
is no allergy check at all. `allergyChecked` is returned explicitly rather than
inferred from an empty warnings array — "found nothing" and "looked at nothing"
render identically and mean opposite things. Where a patient is named the
warnings are advisory and do not block: refusing a person's own purchase against
a record they cannot see would be the software overruling them with no way to
argue.

### Admin is operational, not clinical — and that had drifted

The rule has been stated since Phase 1. When Phase 6 added a test asserting it directly (`access-matrix.spec.ts`, "gives admin no clinical READ endpoint at all"), it immediately found four violations that had accumulated quietly: the ward board (open to admin since Phase 3), the dispensing queue, prescription detail, and the medication round — all of which name patients.

Admin now holds **no clinical GET at all**. Bed-management *writes* remain, because that is how a mis-admission gets corrected and an admin without them has no route but a database console; each is audited. Reports are aggregates with no patient rows and no clinical breakdown.

A stated rule with no test is a rule that drifts.

### Takings are counted from payments, not from invoices

`GET /admin/reports/finance` answers "what did we take today, this month, and
over the last twelve" from `Payment.receivedAt`. The dashboard used to answer it
by summing `amountPaid` over invoices **issued** in the window, which is a
different question wearing the same label: it missed every payment made against
an older invoice — the normal case for anything not settled at the desk — and
counted the whole paid-to-date of a new invoice even where part arrived later.
Both errors are silent. The figure looks plausible and moves when takings move.

**Months are the hospital's.** A payment taken at 23:30 on the 31st in
Asia/Kolkata is already the 1st in UTC, so bucketing on the stored instant moves
that clinic's takings into the next month — and this is the number someone
reconciles against a bank statement. `hospitalMonthKey` and `hospitalMonthRange`
sit beside `hospitalDayRange` for the same reason it does.

**The month axis is generated, not derived from the rows.** A month nobody paid
in appears as a zero. Deriving the axis from the data is the standard way a
revenue chart ends up flattering — the quiet months are simply not drawn, and
the line only ever connects the good ones. Same argument for the payment-method
split: every method is listed even at zero, because "no card payments today" and
"the card row is missing" look identical on screen and only one of them means
the till balances.

**Pharmacy takings are reported beside the hospital's, never inside them.** In
SEPARATE mode these are two businesses, and a "collected today" that silently
adds a shop's counter trade to a clinic's is the same class of error this report
was rewritten to fix — a plausible number answering a question nobody asked.
Aging likewise counts hospital invoices only: a counter sale is paid at the
counter or it does not happen, and an unsettled one is an unreconciled till, not
a debtor to chase at 30, 60 and 90 days.

**Every takings figure carries its refunds, and screens lead with the net.**
Reported from use: reception raised 500, billing took 500, billing refunded
500. The payments ledger is signed and showed the day netting to nothing; the
admin dashboard showed 500 collected, because `collectedLastSevenDays` and the
per-person `collectionsByStaff` total both summed `Payment` rows and nothing
else. Two screens disagreeing about one day is worse than either being wrong
alone — it makes both unusable, and the person who has to explain it is a
finance clerk who did nothing wrong.

The fix is not "subtract refunds from collected", which is the opposite error.
Gross in, gross out, net derived — and the *net* is the headline, because that
is the figure billing already sees. `reports.spec.ts` asserts the exact key set
of a staff row, so a later change cannot quietly drop the pair, and asserts that
refunds are read from the `Refund` table rather than from `amountPaid` — which
is already net and would miss any refund against an invoice raised on another
day.

**Billed and collected are always reported side by side.** Payment is
deliberately not required before a consultation, so the gap between them is real
— and reporting only what was charged is how a clinic mistakes invoices raised
for money in the bank.

### Three businesses take money, and the dashboard was adding them up as one

A hospital here may run up to three things that bill: the clinic, the pharmacy
and the laboratory. `Invoice.kind` says which. Asked for by the product owner —
*"if that tenant has the laboratory bills as well as the pharmacy bills, could
you have their section on the administrator dashboard so we have a complete
picture of where the amounts are flowing"* — and the picture was not merely
missing. It was wrong.

**`GET /admin/dashboard` summed every payment and refund in the window with no
`kind` filter.** So `collectedLastSevenDays`, `netLastSevenDays` and
`outstanding` silently folded the shop's counter trade and the lab's charges
into the clinic's figures. `financeReport` had always split them correctly, and
this file claimed the rule held — *"pharmacy takings are reported beside the
hospital's, never inside them"* — with a comment thirty lines above the
offending query saying so too. A stated rule with no test is a rule that
drifts, and this one never held for the dashboard for a day.

Two more faults in the same expression, both of the shape this project keeps
recording. `outstanding` was `total - amountPaid`, ignoring `creditedAmount`, so
a credit note left a balance nobody was chasing on an owner's screen forever —
the arithmetic the send-out worklist and the pharmacy till were both written to
avoid. And it summed *signed* differences rather than flooring per invoice, so
one overpaid invoice cancelled a real debt on another and the hospital looked
square.

**`revenue-streams.ts` is one implementation and both callers use it.** The
dashboard and the finance report are read by the same person in the same minute,
and they had already disagreed in exactly this way. Two screens disagreeing
about one day is worse than either being wrong alone, because it makes both
unusable and the person who has to explain it is a finance clerk who did nothing
wrong. Same reasoning as `resolveAuditTarget`, `resolveTreatingScope` and
`course-quantity.ts`.

**`ALL` is computed over the union, not by adding the three rows.** A fourth
`InvoiceKind` would otherwise fall out of the total while every individual
figure still looked right — the failure mode that is hardest to see because
nothing on screen is obviously wrong.

**Every stream is returned even at zero**, and which ones to draw is the
client's question, answered from `hospital.modules`. A response whose keys
change with the plan is one every caller has to guard, and *"the pharmacy took
nothing today"* and *"the pharmacy row is missing"* look identical on screen
while only one of them means the till balances — the same argument as the
payment-method split.

**`chaseable` is a field because "owed" means two different things.** An
unsettled pharmacy invoice is an unreconciled till, not a debtor: a counter sale
is paid at the counter or it does not happen, it frequently has no patient to
chase, and it is deliberately absent from `AGEABLE_INVOICE_KINDS`. Both clients
label it differently rather than totting all three up under one heading, because
the alternative is somebody chasing a walk-in who left with their paracetamol a
fortnight ago. `revenue-streams.spec.ts` compares the flag against
`AGEABLE_INVOICE_KINDS` rather than keeping a second list, which is what the
aging bug below was.

**The admin aging was filtered by hand and disagreed with billing's.**
`admin.service.ts` aged `kind === HOSPITAL` while `/billing` used
`AGEABLE_INVOICE_KINDS`, which is HOSPITAL **and** LAB. So the owner's screen
and the billing clerk's screen disagreed about which debts exist, and the ones
missing from the owner's were laboratory charges raised against named patients
exactly as a consultation is.

**`finance.*` kept its key names and changed its values**, so a client that has
not been redeployed keeps working and starts telling the truth. Expect those
tiles to **drop** on any tenant that sells medicines or runs tests; the `ALL`
row is the figure that replaces them.

**Two of the guards over this were vacuous and were caught by being broken.**
The first matched `/InvoiceKind\.HOSPITAL/` in the dashboard method and **passed
with the bug restored**, because the identifier also appears in an unrelated
`?? InvoiceKind.HOSPITAL` fallback two statements away; the decision moved into
`financeBlock`, a pure function a test can hand a pharmacy row to. The second
matched `AGEABLE_INVOICE_KINDS` against the whole file and **passed with the
fault reintroduced**, because the explanatory comment I had written directly
above the fix mentions the identifier by name — so it strips comments first, the
same lesson `nav-modules.spec.ts` learned. Sixth and seventh time in this repo.
A guard nobody has watched fail asserts nothing.

**`/admin` is deliberately not in `DEGRADES_INTERNALLY`**, and the staleness
check in `nav-modules.spec.ts` is what established that rather than a judgement
call: the card hides per module, but `GET /admin/dashboard` carries no
`@RequiresModule` and returns all three streams unconditionally, so the
narrowing is entirely client-side. An entry there would have been a claim about
API coverage that is not true of this screen.

Layout is curated and the data is not. The web gets a table; the phone gets a
block per stream, because eight columns do not fit and an owner asking what the
clinic took is exactly the person holding a phone — in a small practice, often
the doctor as well.

#### One figure on that row did not move with the period, and it was the owed one

This shipped with three fixed windows — today, a rolling seven days, the
hospital's month — and an `outstanding` that was **not windowed at all**,
documented here as deliberate on the grounds that an unpaid sale from last week
is still money owed today.

That grounds is correct and the placement was wrong. Reported by the product
owner: with *Today* selected, the unpaid column showed a balance from months
earlier, and *"the customer may get confused, where is it coming from"*. Every
other number on that row moved with the period and this one did not, so the row
read as one period's figures while not being that — and nothing on screen said
which was the exception.

**Both figures, in separate columns, each saying what it is.**
`outstandingInPeriod` is of what the stream billed *in the period*, which is the
honest reading of the column it sits in: of what we charged then, this much has
not arrived. A period that billed nothing shows nothing owed, which is correct
rather than empty. `outstandingAllTime` is beside it and labelled *all time*,
because that is the figure a clinic decides whether to chase anybody on and
somebody looking at *Today* must not conclude they are square. Dropping it would
have answered the report and lost the more important number.

`finance.outstanding` on the tiles above stays all-time, deliberately: that tile
has always meant "what is this hospital owed", and narrowing it to a week would
quietly turn a debt figure into a recent-billing figure while reading
identically.

#### The period is the reader's choice, and three fixed windows could not express it

Asked for in the same breath: *"instead of this month, could the customer select
a date range, or a month and year — that will be good, to choose the data for
which they want the dashboard to display."* A clinic reconciling August cannot do
it on a card that only knows about now, and three windows is a card that only
knows about now.

So the three became **presets of a single chosen period**, and nothing was lost:
today, a rolling week and this month are still one action each and resolve
through the same `?from=&to=` the arbitrary case uses — one code path, rather
than a fast one for the common periods and a separate one for the rest.

**`resolvePeriod` is shared with lab statements rather than copied.** It was
`private async statementPeriod` on `LabService`, which was right while statements
were the only thing with a period; the alternative here was eighty-five lines of
timezone boundary arithmetic in a second service. Two implementations of "which
days does this period cover" do not produce a visible formatting difference —
they produce two screens quoting different totals for the same named period.
Fifth time this project has turned that into a module, after `resolveAuditTarget`,
`resolveTreatingScope`, `course-quantity.ts` and `matchReferralItems`.
`lab-statement.spec.ts`'s four assertions followed it rather than being loosened,
because they were about the arithmetic and not about where it lived.

**Its own endpoint, `GET /admin/reports/revenue`.** Parameters on
`/admin/dashboard` would mean refetching appointments, occupancy, bed counts,
staff and audit figures every time somebody changed a date, and a period control
that re-renders the whole screen is one people learn not to touch.

**The shared `PeriodPicker` is consumed untouched on both clients.**
`statement-period.spec.ts` pins its three presets *by name* on both, so widening
them for the admin card would change what a laboratory sees on another screen.
Today and the month selector sit beside it instead — `type="month"` on the web,
because it is a native month-and-year picker; month steppers on the phone,
because there is room for one control and *"the month before the one I am looking
at"* is the move somebody actually makes. Both derive the range from the chosen
year and month rather than from "now", so neither consults the device clock to
answer a question about August.

**The server's resolution is what gets printed.** A preset computes "today" from
the device's clock while the server resolves it in the hospital's timezone, and
those differ by a day for anybody not sitting in their own clinic. The response
carries `from`, `to` and a `label`, and both screens print that — so the
difference is correctable rather than invisible. A whole calendar month comes
back labelled *September 2026* rather than *1–30 September 2026*, since a heading
naming the 30th invites the reader to wonder about the 31st.

**Three of the four guards over this were verified by breaking them**, and one of
the three faults was the reported bug itself — un-windowing `outstandingInPeriod`
fails three assertions across two files. A fourth guard broke honestly on its
own: `reports.spec.ts` asserted the `collectedLastSevenDays` trio against
`admin.service.ts`, and those keys had moved into `financeBlock`. It now reads
both files, because the property it protects — every collected figure has a
refund and a net beside it — did not move.

#### One period for the screen, and the figures that cannot have one

The period control drove the revenue card **alone**, so the tiles above it
reported today while the card below reported August. Reported by the product
owner: *"you have applied the date range only for the below sections, streams
like clinic and laboratory. This should be common to all the dashboards — even
top sections where you have zero tests ordered today, kept today,
outstanding."* The same fault as the unpaid column one change earlier, one
level out: figures that do not move with the period, sitting among ones that
do, unlabelled.

So the screen holds one period and **every period-driven call gets the same
query string**, computed once. Two controls on one screen are two answers to
"which dates", and the reader believes whichever they looked at first.

**`financeBlock` was deleted rather than renamed.** It built
`collectedLastSevenDays` and two siblings, honest while the dashboard reported
a fixed rolling week and a false name the moment the period became a parameter.
Its three guards failed on the change rather than after it, which is what they
were for. What replaced it is no function at all —
`streamNamed(revenue, 'HOSPITAL').period`.

**The response is split, because not every figure has a period version.**
`overPeriod` moves with the dates; `rightNow` cannot. Bed occupancy is how many
beds are full *at this moment*, and "occupancy for last month" would have to
mean an average or a peak — a different figure wearing the same label. Lab queue
depths, staff counts and unpriced medicines are the same: a backlog is a backlog
or it has been cleared. Denied requests stay on a fixed 24 hours, because a
spike only means anything against a recent baseline.

Making those silently ignore the period is the reported bug. **Substituting an
average would be worse** — a plausible number answering a question nobody
asked, which is the error the finance report was rewritten to fix. So they are
separated, and both clients head that section *"Right now — whatever period is
selected above"*. `dashboard-period.spec.ts` asserts the split server-side, the
single period on both clients, and that the wording is on screen rather than
only in this file.

**Every key named for a window it no longer covers was renamed.**
`dispensesToday`, `ordersToday`, `unpricedSalesToday` became `dispenses`,
`ordersPlaced`, `unpricedSales` inside `overPeriod`, where the period is stated
once. A key named for the wrong window is what sent three incident reports in
this project to the wrong feature.

#### Who came in, who saw them, and what it came to

Also asked for: *"how many patients registered or had an appointment, and how
many patients a doctor has seen and how much total collection from those
patients."* The dashboard had appointment counts and a doctor headcount with
nothing joining them, so the question a clinic owner actually opens a dashboard
with was answerable only by reading three screens and doing arithmetic.

`patient-activity.ts` is a pure module: registrations, appointments,
attendance, and a row per doctor with patients seen, consultations, billed and
collected.

- **`patientsSeen` is a distinct count and deliberately not the sum of the
  rows.** One patient seen by two doctors is one patient in the hospital total
  and one in each row. Summing the rows gives two, and a hospital total larger
  than its own patient list is a figure nobody can explain — so the screen says
  so where it prints it.
- **SCHEDULED is not attendance**, for the reason `resolveTreatingScope`
  refuses it: a diary entry would let tomorrow's bookings inflate today's seen.
  CHECKED_IN is arrival without a consultation and counts as neither.
- **Money comes from attended appointments only.** A no-show is revenue
  invented from an empty chair.
- **A doctor who saw nobody keeps their row, at zero** — exactly who an owner
  reconciling a quiet week wants to see, and the payment-method-split argument
  again.
- **Billed sits beside collected**, because payment is never required before a
  consultation and reporting only what was charged is how a clinic mistakes
  invoices raised for money in the bank.
- **No patient name anywhere on it.** The named drill-down is
  `GET /admin/reports/consultations`, which carries
  `ADMIN_CONSULTATION_LEDGER` as its own audit action precisely so *"who looked
  up our patient list, and when"* stays answerable; the counts link there
  rather than this endpoint growing names. `reason` is the field one careless
  `include` away, and the spec asserts the word never appears in the module.

#### What left the hospital, and to whom

*"If a doctor prescribes to an outside pharmacy, we should track those
separately from our clinic. What different pharmacies outside my hospital has
that prescription gone to. Same for the tests."*

`Prescription.destination` and `LabOrder.destination` have carried the answer
since routing shipped and **nothing ever read it back** — the fifth field in
this project written and never reported. `referrals-out.ts` groups both.

- **EXTERNAL is its own row, not an unnamed partner.** It means the patient took
  it away to fill wherever they chose: no partner, no code, nothing to name. A
  row reading *Partner: (unknown)* would send somebody looking for a
  partnership that was never meant to exist — and this is usually the figure an
  owner has never seen, work walking out of the building with no further trace.
- **The partner name comes from our own records.** `PharmacyPartner.label` and
  `LabPartner.label` live in the sending hospital's scope, so naming a partner
  needs no cross-tenant read and no policy exception. The list is not filtered
  on `isActive`: removal is a soft delete precisely so *"where did this go"*
  stays answerable, and a missing label names the tenant id rather than dropping
  the row, because a count that silently disappears is worse than one labelled
  awkwardly.
- **A PARTNER row with nobody named counts as external** rather than being
  dropped, so the parts still sum to the whole. A breakdown whose rows do not
  add up to its own total is one a reader cannot use.
- **`PartnerLabCharge.partnerName` is read off the charge**, not resolved from
  the partnership — the notice captures it at accession for the reason
  `DispenseLine.unitPrice` is captured. A relabelled or removed partnership must
  not restate who charged what for work already done.
- **`payableElsewhere` is kept apart from `unpriced`, and the clients never add
  them.** Under `PATIENT_PAYS` no line is raised *on purpose*; an unpriced one
  is a real loss. Third time in this project — blank is not zero for
  `Medicine.sellingPrice` and `Doctor.consultationFee` either — and merging them
  would make every "went out uncharged" figure report the deliberate case
  forever, at which point people stop reading the figure that catches the real
  ones.
- **No drug name, no test name, no patient.** `referrals-out.spec.ts` asserts on
  the *absence*, because a test that only checked the counts were right would
  still pass if a drug name arrived beside them.

**Three guards verified by breaking them**, and a fourth caught itself: the
`overPeriod` slice assertion failed on its first run because the comment
explaining why occupancy belongs in `rightNow` mentions the word. It strips
comments before slicing now — fourth time in this repo that a guard has been
satisfied by its own documentation.

### A per-doctor report is operational; a per-department one would not be

`GET /admin/reports/doctors` gives headcount, appointments today and over seven
days, whether a consultation fee is set, and revenue billed against collected. A
doctor is staff, not a patient, and counting their appointments says nothing
about who those appointments were with.

The line to hold is the breakdown key. "Revenue by department" reads as
operations and, in a hospital with an oncology department, is a statement about
what patients attended for — the same leak `consultation-billing.spec.ts`
refuses in an invoice description, arriving somewhere nobody would question it.
`reports.spec.ts` asserts the *absence* of any patient or clinical field in
those two service methods, and pins the select down to
`appointment: { select: { doctorId: true } }` — `appointment: true` would pull a
`patientId` into a finance report as valid, unremarkable data.

Unpriced doctors are surfaced on the dashboard rather than left to be
discovered, because a doctor with no fee breaks reception's checkout and the
receptionist finds out standing in front of the patient.

### Admin sees attendance and money, never clinical content

This rule replaces "admin sees no patient identity anywhere", which held for six
phases and is no longer true. `GET /admin/reports/consultations` returns the
patients behind a count on the owner's daily activity screen: name, appointment
time, whether they attended, what they were charged, whether they paid.

That was asked for and is defensible. An owner reconciling their own clinic
needs to know a doctor's three consultations were three real people who were
billed, and every field crossing over is one reception already sees at the desk
and billing sees on an invoice. It is the same information, gathered by doctor
and day.

**What still does not cross, and why the line is there:**

- `Appointment.reason` — typed by reception at booking and routinely "chest
  pain". It sits on the same record as everything above, one careless `include`
  away, which is why the test asserts the word never appears in that method.
- Prescription contents. `prescriptionIssued` is a **boolean**: that a doctor
  prescribed something is operational; *what* they prescribed names a condition,
  and an antiretroviral or an antipsychotic on an owner's screen tells them
  something the patient told their doctor.
- Diagnoses, notes, allergies, vitals, admissions.

**The dishonest version of this change was available.** Putting the route on
`AdminController` leaves `access-matrix.spec.ts`'s "no clinical GET at all"
green, because that test keys on clinical *controllers* — the rule would have
stayed in the file saying something that had stopped being true. A safety net
you have quietly stepped around is worse than none, because the next person
reads it and believes it. So the rule was restated and asserted directly against
the one endpoint that carries identity.

`toLedgerRow` is an explicit allowlist rather than a spread of a Prisma row, and
a test pins its exact key set. A spread passes every "does it contain X" check
while silently carrying the next field somebody adds to the model.

`ADMIN_CONSULTATION_LEDGER` is its own audit action: "who looked up our patient
list, and when" must be answerable without unpicking a generic report action.

### The owner's daily view answers "who and how much", and links to who attended

`GET /admin/reports/staff-activity?date=` gives one day, one row per member of
staff: consultations and revenue per doctor, registrations and bookings per
receptionist, money taken per billing user, dispensing per pharmacist, vitals
and doses per nurse. It is the request a clinic owner actually has — reconciling
the day, and checking the numbers a doctor reports match the ones the system
recorded.

**Every count is a link.** Booked, completed and no-show open the patients
behind them — see "Admin sees attendance and money" above for exactly what
crosses. A number an owner cannot check is a number they have to take on trust,
which is the opposite of why they opened the screen. Zero is deliberately not a
link: a link that opens an empty panel teaches people the links do not work.

For records, prescriptions or a diagnosis the answer is still the one multi-role
provides: **switch to a clinical role you hold and look as that role.** The
audit log then records that they viewed clinical data while acting as a doctor —
honest, and what a regulator would ask for.

**The drill-down is the consultation ledger, not the audit log.** Rows briefly
linked to `/audit?userId=&date=`, and that was removed: the audit trail is a
list of API actions — `PATIENT_CREATE`, `APPOINTMENT_STATUS_CHANGE`,
`QUEUE_VIEW` — and an owner reading it learns what the *application* called,
not what their staff did. Engineering vocabulary behind an ordinary-looking link
makes a management screen feel like a debugging tool. The audit browser keeps
its own nav item, with the same `?userId=` and `?date=` filters, for the
compliance question it actually answers; it is simply not the natural next click
from a report.

**Reads are not counted.** `QUEUE_VIEW` and `PATIENT_SEARCH` measure how long a
screen was open, not what was done; a productivity figure built on them rewards
leaving a list up, and is the first number a member of staff would rightly
argue with. Only actions that changed something are counted, and
`reports.spec.ts` asserts no read-only action appears in `ACTIVITY_ACTIONS`.

**Refusals are not counted per person, and were removed after being built.**
Beside someone's registrations and bookings, a denial count reads as a
performance metric and is not one — most denials are a stale tab, a bookmarked
URL, or a role that changed this morning. The signal is not lost, only kept
where it means something: the dashboard's hospital-wide denied count over 24
hours, and the audit log itself. For the same reason a refused action counts
towards nothing at all, because it changed nothing.

**Check-ins, cancellations and reschedules are one figure**, because the audit
log records that an appointment's status changed and not what it changed *to*.
Splitting them means recording the new status on the audit row — worth doing if
the distinction is ever needed, and dishonest to fake by guessing.

**A person appears under every role they hold, not just their default** — the
owner-doctor again. Counting them only as an administrator would leave their
consultations attributed to nobody, and a day's takings that do not add up is
worse than a name appearing in two tables.

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

### A drug chart is a patient's, and the system only had the ward's

`GET /medications/round/:wardId` answers "what is due on this ward today". That
is the right question while handing out medicines and the wrong one everywhere
else. A nurse taking over a patient, or a doctor on a ward round, asks *what is
this person on, and what have they actually had* — and nothing in the system
answered it. There was no per-patient view of medication on either client.

**The refusal that led nowhere.** `parseFrequency` deliberately recognises a
small set of unambiguous phrasings and returns null for everything else, because
a chart that is confidently wrong under-doses a patient. Correct. Those items
came back as `unscheduled`, the sheet said *"these need a nurse to set the times
— they are deliberately not guessed at"*, and **no screen in either client could
set them**. The medicine was prescribed, absent from the chart, and explained by
a sentence in a dialog that closed.

A safe refusal that leads nowhere is not safe. It is a missing medicine with a
paragraph attached, and it is the same shape as the seed-only wards: the system
naming a precondition nobody can satisfy.

**Two empty chart rows that look identical and are opposites.** A medicine with
no doses is either one the parser could not read — which wants times set — or an
as-needed one, which must *never* be given times. Scheduling a PRN medicine
makes the round show a dose as **due**, which is precisely the misreading PRN
exists to prevent, and an overdue-looking row invites giving a medicine the
patient did not need. So `isAsNeeded` is sent as its own field and the two rows
offer different actions: **set the times**, or **record a dose as given**. PRN
has no scheduled row to find and sign, so `POST /admissions/:id/doses` creates
the dose and signs it in one action — for an as-needed medicine those are the
same event.

**Prescribed-but-not-charted is read from the prescription, not the doses.**
Building the chart from `MedicationAdministration` rows would show only
medicines that scheduled successfully — so the ones needing attention would be
the ones invisible. They are listed first, above the working chart, for the same
reason.

**Allergies are substances here, not a flag.** The ward board shows a dot
because it lists many patients and the detail belongs on a screen somebody
deliberately opened. This is that screen, and the one where a nurse is about to
give a drug. "Has allergies" without saying to what is the least useful form of
that warning at the moment it matters most.

### The API says when the database is behind the code

`prisma generate` rewrites the client from `schema.prisma`; `migrate deploy`
changes the database. They are two commands, and between them the running API
queries columns that do not exist.

That gap produced three separate incident reports here, each arriving as a 500
naming a column and each therefore reported as a bug in an unrelated feature:

- `The column tenants.taxEnabled does not exist` — the tax settings screen
- `The table public.observation_orders does not exist` — the ward board
- `The column prescription_items.quantityPrescribed does not exist` — the
  pharmacy queue

Every one was the same missing command. An error naming a column is a
consequence; it sends whoever reads it to the feature rather than to the cause.

`PrismaService` now compares the migrations on disk against `_prisma_migrations`
at boot and prints the pending ones with the exact commands. **A warning, never
a refusal to start** — a pending migration that touches one feature must not
take down the screens that work without it, which is the same reasoning that
makes a lapsed subscription read-only rather than a lockout. The check is also
wrapped, because a database that has never been migrated has no
`_prisma_migrations` table and this must not itself become a reason the API will
not boot.

### Nobody recorded how much was ordered, so nothing could be finished

Reported from use: the pharmacist hands over exactly what was prescribed and
the counter still reads *partially dispensed* — permanently, with nothing in
the application able to change it.

**There was no ordered quantity anywhere.** `PrescriptionItem` carried
`dosage`, `frequency` and `duration` as free text and a `quantityDispensed`
running total, and completion was decided by *inferring* the first number from
the last two:

```
const needed = suggestQuantity(i.frequency, i.duration);
return needed !== null && i.quantityDispensed >= needed;
```

`suggestQuantity` recognises a deliberately small set of phrasings and returns
null for everything else, which is right — guessing at a course length is how a
patient goes home with the wrong number of tablets. But **that null was read as
"not complete"**, so any duration the recogniser did not know — "as directed",
"1/52", "until the course finishes" — meant the prescription could never leave
PARTIALLY_DISPENSED however much had gone over the counter.

Third time this shape has appeared: the drug-chart items the parser refused to
schedule and no screen could set, the wards only the seed could create, and now
this. A deliberate refusal to guess is correct; a refusal with no route for a
human to supply the answer is not.

**`PrescriptionItem.quantityPrescribed` is what the prescriber ordered.** The
prescribing screens offer the arithmetic as a prefill and never apply it — a
doctor who means something other than frequency × duration should not have to
delete a number the form assumed. Completion then compares two numbers in the
same units, with no reading of anybody's shorthand in between.

**Null still means something, and it is no longer "the parser failed".** An
as-needed or ongoing course genuinely has no total. Those come back as
`unknown` rather than as zero outstanding — zero would read on the counter as
"nothing left to give", which is the opposite — and the pharmacist closes them
with `POST /pharmacy/prescriptions/:id/complete`.

**Two refusals on that route, both load-bearing.** Nothing may be *known* to be
outstanding, because closing a prescription with a line still owing twenty
tablets records a half-filled course as finished — a worse error than leaving it
open, and one the patient discovers rather than the pharmacist. And something
must actually have been dispensed, or the button takes a prescription out of the
queue with nobody having received anything.

`dispense-completion.spec.ts` asserts the old inline expression is gone, because
if it returns the sticking comes back and nothing else in the suite would say so.

### The quantity fills itself in, and the dosage had to join the sum first

Asking a prescriber to click *Use 14 for this course* is asking them to
authorise a multiplication. Both prescribing screens now fill the quantity in as
the dosage, frequency and duration are typed.

**The arithmetic had to be corrected before it could be trusted, and that was
the whole difficulty.** For six phases this was `timesPerDay × days` — the
dosage was not in the sum at all. "2 tablets, three times daily, 5 days" came
out as **15** against a real 30: half a course, in the same direction, on every
multi-unit prescription ever written here. Survivable while it was a hint
somebody clicked. Not survivable the moment a field fills itself in, because
**a prefilled field is trusted and skimmed rather than checked** — the property
that makes it worth doing is the property that makes it dangerous.

`course-quantity.ts` is `unitsPerDose × dosesPerDay × courseDays`, and it
refuses more than it answers. **A strength is not a count**: how many capsules
make 500mg is a property of the product on the shelf, which this system does not
model, and reading "500mg" as five hundred of something would be catastrophic
rather than merely wrong. A range has no single answer. A fraction is only half
a pack if the tablet is scored. In each case there is no number and the field
says which part it could not read — the same distinction `dispense-quantity.ts`
draws, and the sixth time on this project that a refusal has had to be given a
route out rather than left as a dead end.

**It stops the moment the prescriber types in the box**, and offers itself back
as *Recalculate (n)*. Their number is a decision — a spare inhaler, a split
pack, the tablets already at home — and having it silently overwritten because
they went back to fix a typo in the duration is worse than never having filled
it in. Where the sum stops working the box is **cleared rather than left
stale**: a quantity that no longer follows from the fields above it is the
number most likely to be dispensed against and least likely to be reread.

**One implementation, three byte-identical copies.** The screens compute this on
every keystroke, so it cannot be a request, and Metro resolves no shared package
without config nobody has run on a device — the constraint that already
duplicates `types.ts`. What must not happen is the counter and the prescription
sheet showing different totals for the same line, so `suggestQuantity` and the
legacy completion fallback route through the same file and
`course-quantity.spec.ts` fails the build if any copy is edited alone. The
module imports nothing, which is what keeps that possible.

The legacy fallback keeps the old dose-count reading where units cannot be
read — `units ?? doses`. Rows created under that reading must keep it;
restating what was dispensed months ago under today's rule is the
`medicineName`-as-FK trap.

### A printed document said the wrong hospital's name

`renderPrintable` built a prescription as an HTML string with
`<h1>Meridian Hospital</h1>` written into it — the demo seed's name, printed on
every tenant's prescriptions. Not cosmetic: a patient walked into a pharmacy
holding a document naming a hospital they had never attended, and a pharmacist
has no way to tell a rendering fault from a forgery. Every other surface here is
tenant-scoped by construction; the one artefact that leaves the building was a
string literal.

**`Tenant` now carries a letterhead** — address, contact, licence number, footer
and logo — and `Doctor` carries `qualifications`. Three documents share it:
prescription, invoice, consultation note. One resolver, because a prescription
and an invoice from the same visit showing different addresses is the sort of
thing nobody notices until a patient posts a cheque to a building the clinic left
two years ago.

**Server-rendered PDF, not browser print.** A prescription printed from a phone
must be byte-identical to one printed at the front desk, and "the browser will
make a PDF" varies by browser, printer driver and margin settings — a phone
cannot reliably produce a file at all. pdfkit rather than headless Chromium: 300MB
and a sandbox to keep patched, against a pure-JS renderer that draws a page
deterministically on whatever hardware the hospital already had.

**A sparse letterhead prints anyway.** Every field except the name is optional
and the document degrades rather than refusing. A hospital's first day must not
require a settings form to be completed before anybody can be given medicine.

**The logo cannot take a prescription down.** PNG and JPEG only, as a data URL,
capped and validated at the boundary and again at render — pdfkit embeds nothing
else, so an SVG reaches `doc.image()` and throws, turning "the admin picked the
wrong file" into "prescriptions cannot be printed", discovered by a doctor rather
than by the person who uploaded it. A remote URL is refused outright: fetching
one would make printing depend on a third-party host and let an administrator
point the renderer at an arbitrary address inside the hospital's network. Stored
on the row rather than in object storage, because file storage is the riskiest
item in Phase 8 and none of it exists — `ClinicSettingsService` does not select
the column, so it is read when a document prints and not on every request.

**A printed invoice obeys the same role rule as the API response.** A PDF *is* a
response, and printing `item.description` straight from the row would have handed
a billing clerk the itemised medicine list `invoice-response.ts` carefully
withholds — on a document they can file and re-read, which is worse than the leak
that rule was written to stop. The same `shapeInvoiceItems` runs in the renderer.

**A refused document has to say why, and for a long time it said nothing.**
`openDocument` rethrew, and every call site invokes it as `void
openDocument(...)` — so a correct refusal ("that report has not been authorised
yet", "nothing on that order needs a specimen") became an *unhandled promise
rejection*: a red overlay in development pointing at the `throw` inside
`fetchPdf`, and in production a tab that opened and closed with nothing said.

The reason was in hand the whole time. `fetchPdf` reads the JSON error body and
puts the server's own sentence into the error precisely so somebody can be told,
and then nothing displayed it — the API refusing correctly and unexplainably,
which is the shape this project keeps reopening.

Both helpers now resolve rather than throw, and write the message into the tab
already open on *"Preparing the document…"*, so every `void` call site gets it
without remembering to catch. `document-errors.spec.ts` asserts the catch block
holds no `throw` — scoped to the catch, because both helpers throw *internally*
so their own `try` can handle a bad response in one place; that throw is the
mechanism and letting it escape was the bug. It also asserts the message is set
with `textContent`, since a document renderer is the last place to write
unescaped HTML.

**An authenticated file cannot be fetched by a link, and one had been trying
since Phase 1.** The access token lives in memory and travels as an
`Authorization` header — deliberately not a cookie, because anything script can
read an XSS payload can read. A browser navigation sends no header, so
`<a href="/api/v1/prescriptions/:id/print">` arrived unauthenticated and the API
answered 401. Correctly, every time, for as long as that link had existed.
Nobody found it because it opens in a new tab the user then closes, and because
it *looked* implemented.

`client-nav.spec.ts` had exempted `/api/v1/...` anchors as "downloads that must
leave the SPA" — true of a genuinely public download, false of every
authenticated one, which is all of them here. The exemption is gone and the test
now fails on any anchor to the API. Both clients fetch with the header and hand
the bytes to the browser or the share sheet: `web/lib/documents.ts`,
`mobile/lib/documents.ts`.

Same shape as the three false exemption reasons before it. A safety net somebody
has stepped around is worse than none, because the next reader believes it.

**Two layout bugs were only visible by rendering a page and looking at it.** The
detail grid advanced a fixed nudge per cell rather than a line per pair, so the
patient's name printed through their date of birth; and the table's column
offsets were computed by a `reduce` that read the array it was building, so every
column started at the left margin and the medicine name overlapped the dosage.
Both typechecked and produced a valid PDF. `documents.spec.ts` asserts the output
is a real PDF and that no renderer hard-codes a hospital name, which is the bug
that started this — but neither test would have caught the overlap. Render one
and look at it.

### Observations had no way in, and one timer for the whole hospital

Two faults, and the second was invisible because of the first.

**Nothing could record an observation except a phone.** `POST /vitals` had
exactly one caller in the codebase — the mobile offline outbox — and mobile has
never run on hardware. So the vitals screen was empty for everybody since Phase
3, and said *"observations are recorded on the mobile app at the bedside; this
is the review view"*: a reasonable sentence describing a screen that could never
show anything. `endpoint-coverage` carried the reason *"the web vitals form
posts under the patient"* against that route. There was no such form and no such
route. **Third false reason found in an exemption list**, each reading as a
decision somebody made rather than a gap nobody filled.

The transcription argument behind the rule is real — numbers copied from paper
to a desktop an hour later get copied wrong — and it is not an argument for
having no way to record them. It also never covered the two commonest cases: a
ward terminal beside the bed, and an outpatient whose BP is taken at the clinic
desk before the doctor. The second was impossible in a stronger sense:
`Vital.admissionId` has always been nullable, so the model expected clinic
observations and nothing in either client could produce one.

**`OBSERVATION_INTERVAL_HOURS = 4` decided the whole hospital.** The board
applied it to somebody four hours post-operative and to somebody waiting for a
lift home, and nobody could change it — the single number deciding whether a
nurse gets chased about a deteriorating patient was a constant in a source file.

`ObservationOrder` replaces it: per patient, a new row per change so *who moved
this patient to hourly obs, and when* stays answerable. **A nurse may tighten it
and never relax it.** Watching somebody more closely because they look unwell is
the entire reason there is a nurse at the bedside and must not wait for a doctor
to be found; deciding somebody needs *less* watching is a judgement about their
condition, and getting it wrong is silent — nothing looks broken until the
patient is found deteriorated between two sets nobody was asked to take. The
default is four-hourly, unchanged, so applying this re-times nobody.

**No CONTINUOUS member, deliberately.** Continuous monitoring means the patient
is on a monitor, which is a different fact from how often somebody writes a set
down. Mapping it to a guessed interval would make the board confidently wrong
about the sickest patient on the ward. Fifteen-minutely is what a paper chart
uses and is honest about being a charting interval.

**No observations at all counts as overdue.** Somebody admitted an hour ago
whose baseline was never taken is exactly who the board should be shouting
about, and reading "no data" as "nothing to worry about" is how they stay
invisible.

**`ObservationEscalation` is a row, not a nursing note.** "I escalated at 03:40,
spoke to the on-call registrar, was told to repeat obs in an hour" is the
most-asked-for fact in an incident review and had nowhere to live. `escalatedTo`
is free text because the registrar covering a ward at 3am usually has no account
here, and demanding a user id would mean the commonest real escalation could not
be recorded at all. Raising and answering are **separate acts**: an escalation
with no response is a nurse who rang somebody and got nothing, so `respondedAt`
being null is the finding rather than missing data, and the ward board carries
the open count.

Nothing here notifies anybody. Both clients say so in as many words, because a
button that looks like it pages a doctor and does not is worse than none.

### A nurse asks. A nurse never prescribes.

A nurse who needs a medicine that is not there had no route at all. That is two
different problems wearing one sentence, and they are built as two models, two
queues, answered by two roles:

- **`SupplyRequest`** — it *is* prescribed, the ward has not physically got it.
  Logistics; a pharmacist answers. `prescriptionItemId` is required and there is
  no free-text medicine field, because a supply request that could name any drug
  is a prescription written by a nurse wearing a logistics label.
- **`MedicationRequest`** — it is not prescribed at all. Clinical; a prescriber
  answers, by writing it or declining with a reason. `medicineText` *is* free
  text, because the nurse is describing a need ("something for the nausea") and
  a catalogue picker would quietly make this a draft prescription with the
  nurse's name on it.

A single "request medication" button would route half of each to the wrong
person, and the failure it makes available is a drug supplied that nobody
prescribed.

**Neither path puts a medicine on a chart.** Prescribing is a prescriber's act
in every jurisdiction this product targets unless the nurse holds a separate
qualification the system does not model. `ward-requests.spec.ts` asserts the
*absence* of `prescription.create`, `prescriptionItem.create` and
`medicationAdministration.create` in that service — because the tempting repair
is a one-tap "approve" that builds the prescription from the nurse's text. That
reads as a convenience and is prescribing by autocomplete: the medicine, dose
and frequency originating from the person not licensed to choose them, with a
prescriber's name attached.

So a request closes against a `prescriptionId` that already exists, written
through the ordinary route, and the server checks it belongs to that patient. A
status settable without one would let the chart and the request disagree — and a
nurse who reads *prescribed* and finds nothing on the chart is worse off than one
still waiting, because they stop chasing.

**Marking a supply request supplied moves no stock.** The medicine leaves the
shelf through dispensing, where batch selection, expiry, the allergy check and
pricing all happen and are counted once. Decrementing here would give the
hospital a second stock ledger beside `DispenseEvent` — the same mistake a
`CounterSale` table would have been — and the day one was forgotten the count
would still look plausible.

**A decline carries a written reason and it is kept.** "Out of stock, ordered,
expect Thursday" changes what a ward does next; a bare refusal sends them to the
phone, which is what the queue replaces. On the clinical side it matters more:
"I asked and was told no, and here is why" is exactly what a nurse needs on
record, and a decline is a clinical decision worth reading later rather than an
absence of one.

**The prescriber's queue is every open request in the hospital**, not only their
own patients — ward cover means the doctor answering at 3am is routinely not the
one who admitted, the same reasoning that let `resolveTreatingScope` accept an
open admission. Both queues are segmented rather than filtered to the open items,
fourth time in this codebase: "did that insulin ever go up to the ward" is asked
precisely once a waiting-only list would have dropped the row.

`schedule()` also stopped creating doses one at a time. It was a `create` inside
a nested loop — a three-day chart for six four-times-daily medicines is 72 round
trips inside the request's own transaction, holding a pool connection throughout.
`createMany` with `skipDuplicates` does what the per-row P2002 catch did.

### A hospital must be able to set itself up, and could not

`Ward` and `Bed` rows were written by `prisma/seed.ts` and by nothing else.
There was no `POST /wards`, no way to add a bed, and provisioning created
neither — so every hospital that arrived through the platform, which is every
real one, had zero wards and no route to a first one but a database console.

**The cost landed two roles away from the omission.** A nurse's landing screen
is the ward board. It asked `GET /wards`, got `[]`, selected no ward, therefore
never requested a board, and sat on its loading skeleton indefinitely — no
error, no empty state, nothing on screen naming the missing precondition. It
was reported as *the ward board never loads, is the backend slow*. Nothing was
slow. The drug round failed identically, and so did both mobile screens.

Two separate faults, and both had to be fixed. The API could not create a ward;
the client could not say that none existed. Either alone leaves a hospital
stuck — an unusable screen that explains itself is at least actionable, and a
working endpoint nobody knows to call is not.

**This is the third time this exact shape has appeared**, and the recurrence is
the reason it is written down rather than just repaired. The medicine catalogue
was seed-only for six phases, so a hospital that skipped the demo seed had
nothing to receive stock against and the pharmacy did not work at all. A
`Doctor` profile could only be made as a side effect of creating a *new* user,
so an owner-doctor needed a second account. Now wards. Each was found on a real
deployment, by a user, never by a test — because **an empty table and an
unbuilt feature render identically**, and a screen that shows a spinner for
both is telling the user the more misleading of the two.

`endpoint-coverage.spec.ts` structurally cannot catch this: it asks whether
every endpoint has a caller, and there was no endpoint to find missing. So
`self-provisionable.spec.ts` asks the opposite question — for each resource a
hospital must create before the system works, does a create route exist, and is
the demo seed the only writer of it? Each entry names the role that is blocked
when it is missing, because the whole difficulty here is that the symptom
surfaces nowhere near the gap.

Ward and bed setup is web-only, on the same line as departments and staff
accounts: a hospital lays its wards out once, at a desk, before anyone uses the
system. That is a decision in `WEB_ONLY`, not a hole in `PARITY_GAPS` — the
nurse's *use* of wards was always on both clients, and only the one-off
configuration is web.

Occupancy is a count on that screen and never a patient. `access-matrix.spec.ts`
still classifies only the ward *board* as clinical, which is the line that lets
an administrator manage the furniture without learning who is lying in it.

### The lab: a result that reaches the person who asked the question

A test order does not end when the sample is run. It ends when a report reaches
the clinician who raised it, and everything in `backend/src/lab/` is shaped by
that — the worklist is not the feature, the report attached to the patient's
record is. The alternative is what this replaces: a number telephoned through,
written on paper, and lost.

Imaging sits in the same module as the bench disciplines. An ultrasound and a
full blood count are the same thing to everybody except the person performing
them — ordered, done, reported, filed — and two parallel modules would mean two
queues and two places to answer "what did we order for this patient".
`LabSpecimenType.NONE` is what makes it fit: no specimen, so the workflow skips
collection rather than leaving a queue nobody can clear.

**Nothing is a result until it is verified.** Values on a bench are not a
report. The lab sees its own work in progress; the ordering doctor sees the
order as in progress and *no values at all*, and `resultsAuthorised` is sent
explicitly rather than left to be inferred from an empty array — an unverified
result rendered as "no values" is indistinguishable from a test that found
nothing, which is the most dangerous available misreading. The PDF is stricter
still and refuses to print at all: a screen's state is visible and revocable,
and a piece of paper's is neither.

**A rejected specimen is not a cancelled order.** It means somebody has to take
blood from the patient again. Collapsing the two turns "we need another sample"
into "never mind", discovered by a doctor chasing a result that is never coming
— so REJECTED returns the order to a collectable state and the reason is
required, because the reason is the thing that gets somebody to take one.

**UNKNOWN is not NORMAL, and that is the whole of `reference-range.ts`.** A
value that could not be compared and a value that was compared and found
unremarkable render identically if you collapse them, and they mean opposite
things: one is "the lab checked" and the other is "nobody did". So a test with
no reference range produces results with no flag rather than a page of green
ticks, and a censored value — `<0.01`, which is what a troponin assay actually
reports — is compared as an interval: certain where the whole interval sits on
one side of a limit, and UNKNOWN where it straddles one. `<200` against a range
of 130–170 could be 150 or 190, and both available guesses are bad.

**Ranges are data because they belong to the laboratory, not to the analyte.**
They differ by lab, by analyser and by population. A built-in table would be
wrong somewhere on day one and stay wrong silently, and a flag computed from a
wrong range is worse than no flag because it reads as a laboratory having
checked. The range is also **captured as text on the value** at the moment of
resulting, so editing the catalogue next year cannot restate whether a patient's
result was normal at the time it was issued.

**Critical values record a telephone call and never make one.** Both clients say
so in as many words. A control that looks like it pages a doctor and does not is
worse than none, because the technician stops ringing. What exists is a stop:
the result sheet refuses to close quietly on a critical value and asks who was
told — the same shape as `ObservationEscalation`, and free text for the same
reason, since the registrar on at 3am usually has no account here.

**LAB_TECHNICIAN is its own role.** Folding it into PHARMACIST was available and
three characters cheaper; a pharmacist who can read every blood result in the
hospital is a minimum-necessary failure, and in any hospital larger than one
room these are different people. A small clinic where they are the same person
is what multi-role assignment already exists for. The lab gets demographics and
nothing clinical — not even allergies, which a pharmacist *does* get, because a
technician running a count cannot harm a patient with an allergy they do not
know about. Age and sex do cross, and are not decoration: reference ranges are
banded by both.

**A test name is a sharper leak than a drug name.** A drug implies a condition;
a test frequently *is* the question — "HIV antibody", "Beta-hCG", "Drug screen".
So LAB_TEST invoice lines are collapsed for anybody outside the lab exactly as
MEDICINE lines are, by `invoice-response.ts`, and the two collapses are
independent: a pharmacist sees medicines itemised and tests rolled up, a
technician the reverse, billing neither. `labSummaryDescription` is built from a
count and nothing else and a test pins that — "LAB · Serology (2)" is a
discipline on a bill, and the serology bench is where the tests people least want
discussed are run.

**Payment gates nothing.** No part of collection, resulting or reporting looks
at an invoice. Refusing to run a blood test because a card was declined is not a
decision software should make on a clinic's behalf, and `lab-billing.spec.ts`
asserts the absence for the same reason `consultation-billing.spec.ts` does. The
charge is raised at ordering, and voided on cancellation **only while nothing has
been collected and nothing has been paid** — once a sample exists the reagent was
used, and once money has been taken, voiding makes it vanish from the day's
takings with nothing to explain the gap.

#### The result comes back, and that is the one place this departs from prescribing

`PrescriptionReferral` is deliberately one-way: the medicine handed to the
patient is the deliverable, and making the receiving pharmacy write into the
sender's rows would double that feature's blast radius for a convenience. That
is the right trade there and is recorded as a gap.

A lab referral cannot be built that way, because **the result is the
deliverable**. So the return leg exists and is the exact mirror of the send:
`transmit()` writes a `LabReferral` into the receiving lab's scope,
`returnResult()` writes values into the ordering hospital's scope, both through
`forTenant`, and **neither needs a policy exception** —
`tenantId = app_current_tenant()` remains the whole truth on all eight tables in
both directions. The rejected design was a carve-out making a referral tagged for
hospital B visible to B: one line of SQL, after which every future reader of that
policy has to know about it.

The return leg is narrow, and the three refusals are load-bearing. It writes only
onto order items **named on that referral** — the allowlist is rebuilt from the
referral's own rows and re-checked against the request body, because the body is
the one thing the partner controls. It refuses an order the ordering hospital has
already authorised. And it refuses to report twice: a correction is a new order,
so the original stays readable.

**The partner's flags and ranges cross as they issued them** and are not
recomputed against the ordering hospital's catalogue. Their analyser has their
intervals, and re-flagging would be one organisation asserting something about a
measurement it did not make — the same rule that keeps `medicineId` off a
prescription referral item. The report is authorised on arrival under the
partner's named pathologist, because asking the receiving hospital's technician
to sign off work they did not do is a rubber stamp, and in a clinic with no lab
there is no technician to ask — which is exactly the clinic most likely to use a
partner.

**A decline is written back too.** A hospital that never learns its sample was
rejected is a hospital whose patient is waiting for a result nobody is producing,
and it lands as REJECTED — "take another sample" — rather than as a cancellation.

Partnerships are not browsable, for the reason the pharmacy directory is not: a
list of every lab on the platform is the vendor's customer base. "No such code",
"they run no lab" and "they have not opted in" are one identical refusal.

#### Referred work runs the same state machine, because the performing lab owns it

An incoming referral used to be reported in one shot: a form with values and a
typed authorising name, transmitted straight back. A local order goes ORDERED →
COLLECTED → IN_PROGRESS → RESULTED → VERIFIED, with specimen acceptance at one
end and authorisation at the other. Same laboratory, same bench, two different
workflows — reported by the product owner, who asked why.

The honest answer is that there was no reason. It was the shape the referral
feature happened to take, and it skipped the control this module is built
around: **"nothing is a result until it is verified"** held for a hospital's own
orders and not for the work it did for anybody else. That is backwards. Under
ISO 15189 the *performing* laboratory owns the examination and its release —
specimen acceptance criteria, the run, and authorisation by somebody qualified.
A referral is a send-out, not a shortcut; the reference lab accessions it into
its own system and issues an authorised report like any other.

**Accepting a referral now raises a real `LabOrder`.** `LabReferral.acceptedAt`
records the accession, `LabOrder.referralId` is unique so it cannot happen
twice, and from that point the work is indistinguishable from local work: it
sits on the worklist, takes a specimen, goes to the bench, gets resulted and
gets verified. The return leg fires **on verification**, so the two-step gate
now applies in both directions.

**A referred patient is registered, and flagged.** `LabOrder` requires a
`Patient`, and a laboratory genuinely needs one — it labels tubes and prints a
report carrying identifiers. What it must not do is put a stranger into the list
reception searches, which is the same objection that keeps a pharmacy walk-in
out of `Patient` entirely. So `Patient.isReferralOrigin` marks them and patient
search excludes them; the laboratory reaches them through its own worklist.
The alternative — making `LabOrder.patientId` nullable — was rejected because
every consumer in the lab, billing and reporting stack would have to handle a
null patient to serve one path.

**Rejecting a specimen is not declining the referral.** Decline means "we will
not do this work"; reject means "this sample is unusable, send another", and it
keeps the order alive at both ends — landing on the ordering hospital as
REJECTED rather than as a cancellation, which is the distinction that makes
somebody take more blood instead of chasing a result nobody is producing.

**The price is captured on the order item at accession, and was not.** The
first attempt at charging referred work raised nothing at all, because
`accept` created order items without `unitPrice` — `chargeOrder` reads the price
off the *item*, so every referred test looked unpriced and the charge returned
an empty invoice. Local orders had always captured it; the referral path simply
did not. Captured rather than read back off the catalogue at invoice time for
the reason `DispenseLine.unitPrice` is: repricing next year must not restate
what another hospital was charged today.

**The referring hospital is the payer, not the patient.** Accepting raised a
real order and no invoice at all, so referred work was done for nothing —
the counterpart of the unpriced dispense this codebase surfaces daily, except
silent, because no screen lists another company's debts. `chargeReferredOrder`
now runs inside the acceptance transaction, so work accepted is work billed.

The invoice carries **no patient**. A reference laboratory bills the institution
that sent the work; the patient may never learn this lab was involved and is
certainly not going to walk in and settle it. `Invoice.patientId` was already
nullable for the pharmacy walk-in, and this is the second and last reason it is
— with the referring hospital named in `notes`, because a lab invoice with a
blank patient is otherwise a debt nobody can attribute.

Referred work never joins a patient's hospital invoice, whatever
`labBilling` says. COMBINED means "one balance for this patient to settle", and
appending here would put another company's debt onto somebody's own bill.

**Accepting hands straight over to payment**, exactly as dispensing does. A
successful acceptance returns `invoiceId` and both clients go to that invoice
with the payment form open — web to `/lab/invoices?invoice=`, mobile to the till
tab. Reported from use: the invoice was raised silently, so nobody was sure it
existed or that money was owed, and the person who would have collected it had
already moved on.

**Except when something was left unpriced.** Then the screen stays put and names
what was not charged for, because that notice is the one thing the technician
can still act on and a payment form opened on top of it buries the number that
matters. The same rule the dispensing sheet follows, for the same reason.

It is a shortcut to the next task, never a condition on the last one: nothing in
acceptance or resulting checks whether the invoice is settled, and the work is
done either way.

**Never edit an applied migration; add another.** `lab_orders.doctorId` was
made optional on the model and its `ALTER COLUMN ... DROP NOT NULL` appended to
`20260906120000_referral_accession` — which had already been applied. Prisma
checksums each migration, so an edited one is never re-run by `migrate deploy`
and can fail it outright. The generated client then believed the column was
nullable while the database still refused a null, and accepting a referral died
on a null-constraint violation two files away from the edit. Split into
`20260907140000_lab_order_optional_doctor`. `schema-drift.spec.ts` now also
pairs every `DROP NOT NULL` with an optional field on the model, which is the
half of that lesson a test can see without a database.

**A code is another laboratory's vocabulary, so the match is lenient and the
mapping is strict.** Accepting compares the partner's `testCode` against this
lab's `code` trimmed and upper-cased, and reads the whole active catalogue
rather than filtering on the raw strings — normalising only the comparison
fixes nothing, because the row that should have matched is never fetched. A
catalogue holding `Fbc` against a referral sending `FBC` produced *"say which
of your tests these are"* naming a test the technician could see in their own
list, which reads as the software being broken and is exactly the sort of
refusal people learn to click through.

The refusal itself stays and is not a fallback to be softened further. Two
laboratories genuinely calling different examinations by the same three letters
is ordinary, and a fuzzy match on the *name* would accept work this bench does
not do. Where the codes disagree, both clients open a picker and a human says
which test it is; `referral-code-match.spec.ts` pins that the normaliser is
applied to the map's key as well as its lookup, because one without the other
compiles perfectly and matches nothing.

**Referrals already reported are not backfilled.** They keep `acceptedAt` null
and gain no order. Inventing an accession that never happened would put a
fabricated order into a laboratory's own record, which is the class of thing
this change exists to prevent.

#### The specimen is drawn where the patient is, and only the tube travels

A clinic with a doctor and no bench is the commonest customer for a partner
laboratory, and its flow is: the patient is in *its* waiting room, gives the
sample at *its* desk, pays *its* bill, and the tube goes by courier. Nothing
about the patient moves.

**The billing half of that was built and the specimen half was not.**
`worklist()` filtered every segment to `destination: IN_HOUSE`, on the
reasoning that work running elsewhere *"is work somebody else is doing"* —
true of the examination and false of the tube. So a PARTNER order vanished from
the only screen that could record a collection: the clinic had nowhere to say
the blood had been taken, no moment at which to print the label, and nothing to
hand the courier, while the patient stood in front of them.

A **send-out segment** holds them, and it is the one segment about the specimen
rather than the bench. `dispatch()` records the tube leaving, separately from
collection because the gap between them is real — a specimen drawn at 09:14 and
couriered at 16:00 spent the day on a bench, and a potassium from it reads
differently. It refuses before the specimen exists: telling a partner something
is on its way when it is not makes them wait for a van rather than ring to ask.

**A nurse may now collect**, which closes a listed gap and is required here
rather than merely nice: a clinic with no bench has no laboratory technician in
the building, so requiring that role left the commonest send-out arrangement
unable to record a collection at all. Same shape as the medication round moving
off *"the phone is for looking"* — withholding the screen never made the draw
safer, it made it unrecorded.

**At the other end, accession is a receipt.** Accepting a referral used to land
the order in ORDERED, so a technician was shown a *collect specimen* button for
somebody who was never in the building — and the commonest way through that is
to press it anyway, recording a draw that did not happen at a time that is
wrong. A referral whose tube has been drawn now accessions straight to
COLLECTED, carrying the **sender's** draw time rather than the moment of
receipt: time since draw is what changes how a potassium, a glucose or a
coagulation screen should be read, and using our own clock would overstate the
sample's freshness by however long the courier took. Where the sender has not
drawn it yet — the referral transmitted ahead of the tube, which is ordinary —
it stays ORDERED and the laboratory waits.

`noticeDispatch` pushes the draw and dispatch times into the partner's scope
after the fact, outside any transaction and best-effort, for the reason
`transmit` and the payable notice are. The tube is with the courier either way;
failing a dispatch that physically happened would leave the clinic unable to
record it.

**The worklist says what is owed, on the row where somebody can take it.**
The person drawing the blood is standing in front of the patient, which is the
only moment the money is easy to collect — and the row carried `invoiceId` and
nothing else, so a technician could see that *an* invoice existed and not
whether it was settled. That is the half that decides whether to ask. A settled
charge shows as **Paid**; an unsettled one is a link reading *Take payment ·
120.00 due* that opens the lab till with the payment form on that invoice.

`outstanding` is charge minus credits minus payments, never `total - paid` —
the arithmetic that made a refund reopen a balance nobody was chasing would
reappear here as a row demanding money already given back. The invoice is
selected as four columns rather than included whole, because including it puts
its *lines*, and therefore test names, onto a screen through a back door
`invoice-response.ts` shapes every other path to prevent.

**A link, never a gate**, and this screen is where somebody would add one first:
the payer is right there and refusing to draw blood until they pay looks like
ordinary shop behaviour. Nothing in collection, dispatch or resulting reads it,
and `sendout.spec.ts` asserts both halves — that the action is a navigation, and
that neither `collect` nor `dispatch` grew a refusal mentioning an invoice.

**A referred order was going in with no accession at all**, and `sendout.spec.ts`
now pins it. The line that allocates one silently failed to land when the
accession work was written — the edit missed its anchor and nothing said so,
because an order with no number is invisible until somebody tries to print a
label for it.

#### The report went back, or it did not, and nobody was told which

Reported from use: *"The partner lab received it. They made the report and
authorised it, and the transaction moved to done. But the report is not sent
back to the doctor at the hospital who sent the initial request."*

Three separate faults sat behind that sentence, and each is a shape recorded
elsewhere in this file.

**The failure was silent.** `transmitIfReferred` ended in a bare `catch { return
{ reportedBack: false } }` — no log, and the reason discarded, although
`returnResult` refuses with a written sentence precisely so somebody can be
told. The API refusing correctly and unexplainably, which is what the print
anchor and `openDocument` were both reopened for. It now returns
`reportedBackError` and logs it, because the screen is only read by whoever is
standing there and a cross-tenant write that fails at 4pm on a Friday is
otherwise gone.

**Nothing read the answer.** `reportedBack` was returned from the day the return
leg was built and **no client anywhere looked at it** — the doc comment said
"so the technician's screen can say whether the other hospital has it", and no
screen did. A false claim in a comment is the same failure as a false reason in
an exemption list: it reads as a decision somebody made, and it gets skimmed
past. The worklist row now carries `referredFrom` and `reportedBack`, and the
pair is deliberately `string | null` beside `boolean | null` rather than one
flag — null means the question does not apply, false means it applies and the
answer is no, and collapsing them would make every local order look like a
failed transmission.

**There was no route out.** The transmission fires from `verify`, and `verify`
refuses on an order that is already VERIFIED — so a report that failed to
transmit was authorised here, absent there, and unsendable by anything in the
product. Seventh instance of the family. `POST /lab/orders/:id/report-back`
closes it, on both clients, and it is safe to press twice because
`LabReferral.resultedAt` is written only after the cross-tenant transaction
commits: `resultedAt === null` means precisely that nothing landed. It is
deliberately **not** a client caller for `POST /lab/referrals/:id/result`, which
takes a body of values and exists for `verify` to invoke — giving a client a way
to post into that would step around the authorisation gate that accessioning a
referral exists to impose.

**A fourth, found while fixing the others.** The local items were mapped onto
the referral's **by array position**, across two queries with no `orderBy`.
Postgres returns rows in no particular order unless asked, so on a multi-test
referral that can write a potassium into another hospital's record under the
glucose — the worst available outcome here, and it typechecked and looked right.
The join is now on the sender's own `testCode`, which `accept` captures onto the
local item for exactly this reason, with duplicates consumed in id order and an
unmatched test refused by name rather than guessed at.

`referral-return.spec.ts` pins all four. Its first version of the "keeps the
reason" assertion **passed with the bare catch reintroduced**, because it
searched the whole file and `rejectIfReferred` underneath also calls
`reportFailure` — one method's correctness standing in for another's. It slices
the method body now. Third time in this repo that a guard has had to be verified
by putting the fault back.

**The file is the result, and only the numbers were travelling.** Reported next:
the partner authorised a report with a PDF attached and the ordering doctor saw
values and no document. For a full blood count the analytes *are* the result;
for histopathology, cytology or any imaging the attached file is, and this leg
carried values, findings, impression and methodology and nothing else. So the
one thing the referring clinician actually needed never crossed — and it
rendered as an empty report rather than a missing one, which is the more
misleading of the two.

Attachments are now **copied** into the ordering hospital's scope alongside the
values, in the same transaction: bytes, filename, sniffed type, size and
checksum. Copied rather than linked, exactly as `PrescriptionReferralItem`
copies medicine text — linking means one hospital reading a row in the
laboratory's tenant, which is the RLS carve-out this whole feature exists to
avoid. The checksum travels because "is the document I am holding the one you
issued" is the question asked when a report is disputed. `uploadedById` is null,
since the technician who attached it has no account there and inventing one
would make a partner's file indistinguishable from their own staff's in an
audit — the rule that already keeps `resultedById` null.

**Every attachment crosses, not only the signed report.** An analyser printout
beside the PDF is context a clinician can use, and deciding on their behalf that
the raw trace is internal is the sort of curation that leaves somebody
telephoning to ask for it.

**The bytes are read before the scope switches.** Inside `pushBack` the tenancy
proxy points at the *sender's* transaction and these rows are ours, so reading
there returns nothing — silently. Same ordering mistake provisioning made
against RLS on its first live run, arriving in a new place.

**The join became a module because two things now depend on it.**
`matchReferralItems` pairs local items to referral items by the sender's test
code, and both the values and the files use it. Two copies drifting would put a
potassium on one test and its report PDF on another — worse than either being
wrong alone, because both halves look plausible. Same reasoning as
`resolveAuditTarget`, `resolveTreatingScope` and `course-quantity.ts`.

**`lab-attachments.spec.ts` said "the bytes are read in exactly one method" and
went green while that stopped being true.** It scanned
`lab-attachments.service.ts` alone, so a second reader in
`lab-referral.service.ts` was invisible to it. It scans the whole module now
against a named list of readers, each with its reason — a third one fails.
Verified by adding a fake reader and watching it fail, because a file-scoped
matcher standing in for a statement about a module is the same fault the
send-out invoice guard had.

#### One statement a month, because that is what a laboratory actually sends

Reported alongside the above: *"the partner lab should also send an invoice to
the partner hospital as a collection"*.

A reference laboratory raises an invoice **per referral** — it has to, because a
charge is captured at accession against the prices in force that day — and then
posts **one statement a month**, which is what the recipient pays. Neither side
of this product had that. The laboratory had forty invoices in a list; the
hospital had forty `PartnerLabCharge` notices; and reconciling the two meant
adding a column of figures up by eye, which is how a hospital comes to pay a
statement nobody actually checked.

**Derived, never stored, and no migration.** A month that has closed is
completely determined by the invoices already in it, exactly as
`Invoice.labAccessions` is determined by its own line descriptions. A
`Statement` table would be a row to keep in step with the invoices it
duplicates, and every historical month holding a value nobody generated. The
cost is that a statement cannot be amended independently of its invoices, which
is the correct behaviour rather than a limitation — the invoices are
authoritative, and a statement disagreeing with them is the one thing worse than
no statement.

**It has no statement number, deliberately.** The obvious next field, and there
is nowhere honest to get one: a reference the issuing laboratory invents cannot
be looked up by the receiving hospital, whose records are keyed on the
partnership and the month, and one derived from a tenant id would tell one
hospital its position in the platform's sequence. What identifies a statement is
the three facts both sides already hold — **this laboratory, that hospital, that
month** — and both screens and the printed page carry exactly those, so the
telephone call works without either party quoting an identifier the other cannot
resolve.

**No test names anywhere on it, and this is where that rule matters most.** The
page is posted or emailed to another company and filed by whoever opens it. It
carries a count of tests and the two specimen numbers — everything needed to
reconcile a line and nothing about what was investigated — which is the rule
`labSummaryDescription` and `PartnerLabCharge` already follow. `_count: { select:
{ items: true } }` rather than selecting the items and counting them here, so
`testName` is never one careless spread away from the response.
**The patient is absent too**, for a stronger reason: under `ORIGIN_PAYS` the
referring hospital drew the sample and already knows whose it was, so a name buys
nothing and puts a patient onto a document that travels by post.

**Both accessions on every line.** Ours keys our own records; theirs is the only
number the recipient can match to anything of their own. A statement quoting only
the issuer's numbers is one the payer has to telephone about, which defeats the
point of sending it.

**The month is the hospital's, never UTC's.** A referral accessioned at 23:40 on
the 30th in Asia/Kolkata is already the 1st in UTC, and bucketing on the stored
instant posts it onto the wrong statement — the same argument that moved the
finance report onto `hospitalMonthKey`. `monthAnchor` is noon UTC on the 15th,
which is inside the month at every offset from UTC-12 to UTC+14; midnight on the
1st, which is the obvious thing to write, lands in the previous month for every
hospital east of Greenwich.

**A period is a range of days, and a month is one shape of it.** Reported by the
product owner: *"Some partner lab may have, as an agreement, a statement every
week or every ten days or biweekly."* That is how referral contracts are written
and `<input type="month">` expresses none of them — a laboratory on a weekly
agreement was reduced to reading four weeks of lines and adding up the ones
inside the week by eye, which is the work the statement exists to remove,
reappearing one level in.

`?from=&to=` is the general form and `?month=` stays as the shorthand for the
commonest case. Both ends always travel: the server refuses one without the
other rather than inferring "until today" or "the start of that month", because
a period on a financial document has two boundaries and neither should be
guessed on somebody's behalf. A whole calendar month asked for as a range still
prints as *September 2026*, since a page headed *1–30 September* invites the
reader to wonder about the 31st.

**Three presets, and the dates are the control rather than what hides behind
it.** The picker first offered seven days, ten days, fourteen days, this month
and last month, on the reasoning that each named cadence should be one click,
with two date boxes behind a *Custom* button. Cut by the product owner to this
month, last month and seven days, with the dates promoted — and the cut is
right twice over. Ten-daily and fortnightly are two dates either way, so a chip
for them is correct only on the one day of the cycle it was written for and
silently answers a different question on every other; and five near-identical
chips have to be *read* before they can be used, which is the opposite of what a
shortcut is for. What survives is the three whose ends move on their own: two
calendar months and the one rolling window people ask for by name.

Putting the general case behind a button was the worse half. The dates are now
always visible and a preset simply fills them in, which matters beyond tidiness:
a preset computes "today" from the *client's* clock while the server resolves
the period in the *hospital's* timezone. Those agree for anybody sitting in
their own clinic and can differ by a day for anybody who is not — and a filled-in
box that is a day out is correctable, where a hidden one is not. `This month`
alone stays `null` rather than two dates, so the commonest case never consults
the device's clock at all.

**A half-written range is held on the client, never sent.** The server's refusal
of one end without the other is right and stays; meeting it as a red API error
while somebody is still choosing the second date teaches people the screen is
broken. Both pickers lift only a complete, ordered pair out to the parent.

**The phone picks dates now, having deliberately not.** This shipped as presets
only, reasoning that *"two date pickers on a small screen is where an off-by-one
boundary comes from"*. The hazard is real; the conclusion did not follow. A
laboratory on an unusual cycle could not issue its statement from a phone at all
— the same shape as the medication round kept off the web because signing
belongs at the bedside, and reception kept off mobile behind a comment that
turned out to be false. Withholding the control never made the boundary safer,
it made the statement unissuable.

What the hazard argues against is *typing* two dates, and that is avoided rather
than accepted: a day is **tapped on a calendar**, so there is no `01/09` that
might be January, no format to get wrong, and — the part worth keeping — days
that would put the end before the start are **not tappable**, so a backwards
range has no way to exist on that screen. That is a stronger guarantee than the
web's two boxes, which is the right way round for the screen with the least room
to explain itself. The grid is seven columns of `View`s rather than
`@react-native-community/datetimepicker`: what is needed is a grid, and a native
module on an app that has never run on hardware is a dependency bought for
nothing. Same reasoning as the Code 128 encoder.

`statement-period.spec.ts` compares the two pickers — the preset set, that
`This month` resolves server-side on both, the inclusive `n - 1` window, and
that neither can send half a period or a backwards one. They cannot be
byte-identical like `types.ts`, since one draws `<input type="date">` and the
other draws a calendar, so what has to agree is the arithmetic. A statement has
no number by design, so two clients disagreeing about which days *"Last 7 days"*
covers do not produce a formatting difference — they produce two different
statements with the same name, and the disagreement surfaces as a payment that is
short. Verified by putting a fourth preset on one client and watching it fail.

**Two months cannot overlap; two ranges can.** Issue 1–15 and then 1–30 and the
same fortnight is on two statements. That is real and is not a reason to refuse
ranges — a ten-day cycle has to be expressible. It is answered where it bites:
the invoices are authoritative and each carries its own paid state, so a line
settled off the first statement shows `outstanding` of zero on the second. There
is deliberately still no record of which statements were issued, because that
row would be the thing to keep in step with the invoices it duplicates.

**`dayAnchor` was written as the mirror of `monthAnchor` and was wrong.** Noon
UTC on the 15th is 02:00 on the *16th* at UTC+14, so the range would silently
start a day late. Mid-month at noon survives ±14 hours because a month is thirty
days wide; a single day has no such slack, and copying the pattern across is
exactly the mistake it invites. There is no day anchor at all now — a boundary is
*constructed* with `zonedTimeToUtc`, and the end of a range is the start of the
day after its last, so `[start, end)` holds like every other range here. Its own
test caught it, which is the one time in this file that has happened before the
code shipped rather than after.

**A statement refuses rather than truncating.** Every query carried `take: 2000`
and nothing said when it bit: a period wide enough produced a page that looked
complete with a total short by whatever was cut — a wrong number on a financial
document that a reader cannot spot. Survivable while a period was always a
month; a range picker makes "the last two years" one click away. One row more
than the cap is fetched, so a full page is distinguishable from an overflowing
one, and the refusal names the figure and the period to narrow.

**The receiving end reads its own records arranged the same way.** The payables
screen gained a *By month* view over `PartnerLabCharge`, so the paper that
arrives can be held against rows this hospital kept independently — two sets
agreeing is the whole value of the notice, and one party's figure taken on trust
is worth much less. Marking a month settled writes every row individually
underneath, so the per-row Undo keeps working; it is still **not a payment**, and
writes no `Payment`, because takings are counted from that table and this money
never passed through a till. Settlement stays one act per side, which is what the
product owner chose: no money crosses the tenant boundary.

**The itemised statement had no reader on its first pass**, and
`endpoint-coverage.spec.ts` said so the minute it ran. The available fix was an
exemption; the right one was the missing screen, because posting a statement
nobody checked is worse than posting none. Both clients now expand a hospital's
month into its lines before it is sent.

**The dev footer called a statement a prescription.** `DEV_FOOTER` read *NOT A
VALID PRESCRIPTION* for as long as prescriptions were the only thing this
renderer produced, and it was still saying it at the foot of a page about money
addressed to another company. Only visible by rendering one and looking at it —
the third fault in this renderer found that way, after the detail grid printing a
name through a date of birth and the table starting every column at the left
margin. Both of those typechecked and produced a valid PDF too.

#### Who pays for referred work, and the referral that billed nobody

A test sent to a partner used to charge the patient **nothing** here, while the
receiving laboratory raised its invoice against this hospital on accession. So
a clinic that referred a test billed nobody and owed somebody: every partner
referral was a straight loss. `LabOrder.invoiceId` even documented it as a
decision — *"Null for a partner or external order, which this hospital does not
bill for"* — true of the invoice and false of the money.

It stayed invisible because the two halves live in two tenants. The clinic's
books showed no line and nothing missing; the lab's showed an ordinary
receivable. No screen in either hospital could have shown the pair, and no test
compared them, because no test spans two tenants' ledgers.

**`ReferralBilling` names the two arrangements, and both are ordinary.**
`ORIGIN_PAYS` is the reference-laboratory contract: the specimen travels, the
patient never learns which lab ran the test, and the lab invoices the
institution. `PATIENT_PAYS` is the requisition model — the clinic writes the
request and charges nothing, and the patient walks into the diagnostic centre
and pays at the counter.

**The difference is not only the debtor.** It decides where the patient
physically is, so the billing moment flips: under `ORIGIN_PAYS` the hospital
bills at ordering and the lab bills an institution that is not standing there;
under `PATIENT_PAYS` nothing is billed until the patient arrives, which is also
when the specimen is taken. So accepting hands over to the till only under
`ORIGIN_PAYS`. Opening a payment form for somebody who is not in the building
drops a technician out of the queue they were working, to look at a form nobody
can settle.

**It lives on the partnership, not on either tenant.** One laboratory routinely
holds a wholesale contract with a hospital group and takes walk-in referrals
from a single-doctor clinic down the road — one lab, two commercial
relationships, which a tenant-level field cannot express. It also has to be
known at *ordering* time, because that is when the sending hospital decides
whether to charge the patient; resolving it at accession would mean the
referring hospital had already billed, or already failed to, before anyone knew
which was right.

**The receiving lab declares what it will take** —
`Tenant.acceptedReferralBilling`, an array beside `acceptsExternalLabOrders` —
and the sending hospital may only pick from it. Same two-sided shape as the
pharmacy handshake, and necessary for the same reason: a lab with no
accounts-receivable function cannot carry an institutional debt however willing
it is to run the test, and one with no counter cannot take money from a patient
who was never told to come. An empty array is legal and means work accepted
under no arrangement, which is a real setup state; both clients say what that
costs rather than saving it quietly.

**`LabReferral.billing` is the snapshot**, taken at the moment of sending, and
every read at the receiving end uses it. `lab_partners` lives in the sender's
scope and is unreachable from there anyway — but the rule is the one
`DispenseLine.unitPrice` and `PrescriptionItem.medicineName` already follow: a
term renegotiated next quarter must not restate who owed what for work already
accepted.

**The handshake is re-checked at ordering, not only when the partnership was
made.** Terms change at the other end without anybody here being told, and
trusting the saved row sends the specimen anyway — discovering the disagreement
when an unexpected invoice arrives, or when neither party bills at all, which
is the original hole returning by a different route. The partner list carries
`lapsed` so both clients show the choice as unavailable *before* it is picked:
the person who meets that refusal is a doctor mid-consultation who cannot fix
it, and a refusal with no route out is the failure this project has reopened
five times.

**`payableExternally` is not `unpriced`, and merging them would make the whole
thing unobservable again.** Under `PATIENT_PAYS` this hospital raises no line
on purpose. Without a flag saying so, that is indistinguishable from a test
nobody got round to pricing, and every "went out uncharged" figure in the
system — the lab dashboard, the admin overview, the accession notice — would
report it forever, at which point people stop reading the figure that catches
the real ones. Third time here: blank is not zero for `Medicine.sellingPrice`
and for `Doctor.consultationFee`, and *not ours to charge* is not *nobody
charged*. `EXTERNAL` gets the same flag, being `PATIENT_PAYS` in all but name.

**Payment still gates nothing**, and the temptation is stronger here than
anywhere else in this system because under `PATIENT_PAYS` the payer is standing
right there and refusing to draw blood until they pay looks like ordinary shop
behaviour. It is the same gate `lab-billing.spec.ts` and
`consultation-billing.spec.ts` assert the absence of. The invoice sits
outstanding on the till like any other and the report is released on
verification regardless. `referral-billing.spec.ts` asserts the absence on the
new paths too.

**The clinic can now see both halves of the money, and could see neither.**
Two things were invisible from the sending side, and both are the same shape as
the hole above — a number that exists in one tenant and matters in two.

- **What the lab will charge us.** Under `ORIGIN_PAYS` the hospital pays whatever the partner's catalogue says, and could not read that number at any point: not when choosing where to send, not when pricing the patient, not afterwards. `GET /lab-partners/:id/catalogue` reads the partner's price list through `forTenant`, and both order sheets show their price against ours per test, warning when we are charging the patient less than the lab charges us. A price list is not patient data and the lab has already opted in to receiving work; what crosses is exactly what a printed price list carries.
- **What we owe them.** The lab's invoice lives in the lab's tenant, so the debt did not exist anywhere in the clinic's product — it arrived as a statement. `PartnerLabCharge` is a notice written **into the sending hospital's scope** on accession, owned by them, protected by their own policy, exactly as `LabReferral` and the result write-back are. No policy exception on `invoices`, which is the table least able to afford one.

**Written after the accession transaction commits, never inside it.** It enters
another tenant's scope and `TenantInterceptor` already holds a pool connection
for the request; nesting a second `forTenant` is the self-deadlock this project
already shipped once, which is why `transmit` is outside too. The cost is a
window where the work is accepted and the notice is not, and that is the right
way round — a failure here must not roll back an accession the laboratory has
committed to. `@@unique([tenantId, partnerTenantId, sourceReferralId])` makes
the retry safe, and only `P2002` is swallowed: anything wider would turn a
failure into a debt the other hospital never learns about, which is the fault
being fixed, reappearing quietly.

**It is a notice, not accounts payable.** No part-payments, no credit notes, no
aging. Settling with another company is a bank transfer and a telephone call,
and modelling half of it produces a balance that disagrees with both parties'
real books. Marking a row settled records that somebody here says it is dealt
with and is reversible, because the commonest correction is ticking the wrong
line — and it writes no `Payment`, since takings are counted from that table and
this money never passed through a till.

**The payable names a count, never a test.** A test name is frequently the
question itself, and this row is read by whoever reconciles bills — the same
rule `labSummaryDescription` follows on an invoice line.

**Contract pricing is absent rather than half-built.** A reference lab charges
an institution less than its counter price, and `LabTest.sellingPrice` is
retail. `LabOrderItem.unitPrice` is captured at accession, so a per-partner rate
can be added later without restating history — a discount field nobody could
explain would be worse than the gap. Split billing (the clinic keeps a
collection fee, the lab bills the patient) needs two invoices for one referral,
which is a different data shape rather than a third enum member. Settlement
between the two tenants stays a telephone call: making it two-sided means a
hospital writing into a lab's rows, which is the blast radius the prescription
referral was deliberately kept out of.

#### The number on the tube

Every specimen carries an accession number, and it is deliberately not
`LabOrder.id`. Three reasons, each of which has broken a real laboratory:
`id` is **global**, so two hospitals here would quote the same "order 412" for
different patients — a collision on the one identifier both parties use once
work crosses between them; it is **sequential across the platform**, which
leaks how much work every hospital does; and it has **no check character**,
while these get read aloud down bad telephone lines and typed in when a label
smudges. A transposed digit that silently resolves to *another patient's*
specimen is the worst failure available in a laboratory.

`26-000412-K` — two-digit year, six-digit sequence restarting per hospital per
year, and a check character over the digits. The check alphabet excludes `I`,
`O` and `S`: a check character that is itself misread under a smudged thermal
print defeats the point of having one. Weights alternate, because a plain sum
cannot see a transposition and transposition is the commonest way somebody
mistypes a number read to them.

**Leading zeroes are padding, not data.** Reported from use: the label read
`26-000003-G`, it was typed one zero short as `26-00003-G`, and the lookup
refused it — correct by the letter of the rule and wrong in substance, because
`00003` and `000003` are the same sequence and the check character proves it.
`G` is computed over the *padded* body, so anything that checks out after
padding cannot be a different specimen. The sequence is now padded to six before
validation, which widens what is accepted without weakening the guarantee: a
transposed digit, a wrong digit or a mistyped check character all still fail,
and those are every case the check exists for. Dropping one of a run of zeroes
is not that kind of error — it is the commonest thing a person does copying a
number by eye, and a laboratory system that refuses it is one people stop typing
into.

**The check runs before the database is asked.** A mistyped number that happens
to resolve looks exactly like a correct one, so the cheap refusal has to come
first — that is the whole reason the accession carries a check character.

**It propagates to every place it is asked about, and the billing one was missed on the first attempt.** Onto the invoice line
(`LAB · 26-000412-K · FBC Full blood count`), so a query about a charge and a
query about a result are the same query — safe on a bill in a way a test name
is not, because an accession says nothing about what was investigated, which is
why `labSummaryDescription` still refuses to name a discipline. Onto the
referral as `sourceAccession`, so both hospitals can quote one number at each
other; the receiving lab still raises **its own** accession when it accessions
the work, exactly as a reference laboratory labels an incoming specimen with
its own number and reports under it. And onto the label.

**And onto the *collapsed* invoice line, which was the gap.** The accession
reached the itemised line, and billing staff never see the itemisation —
`shapeInvoiceItems` rolls every LAB_TEST row up for them. So the one role whose
job is reconciling a charge could not tell which order a lab line belonged to.
`accessionsIn` reads the numbers back off the descriptions with the exact
pattern, and `labSummaryDescription` carries up to three of them.

The existing *"cannot interpolate anything into itself"* guard caught that
change and had to be widened deliberately, which is the point of pinning the
source rather than the output. An accession is an opaque key — no analyte, no
discipline, no patient — so it carries none of what that rule exists to keep off
a bill, and it is the one thing that makes a lab charge reconcilable. What holds
the rule shut is not the shape of the string but where it comes from:
`accessionsIn` extracts with a fixed two-digit / six-digit / check-character
pattern, so a test name cannot survive the filter. The overflow suffix was also
lifted out of the return template into its own variable, because a nested
template literal defeats the guard's matcher and it would otherwise have been
reporting a string nobody wrote.

**And onto the invoice itself, not only its lines.** The accession travelled in
each line's description, and the lines are one click *inside* an invoice — so a
till showing forty rows gave no way to tell which order any of them was for
without opening every one. `Invoice.labAccessions` is derived from the
descriptions by the same exact pattern they were written with, and appears on
the till row, the invoice header and the printed bill. Derived rather than
stored: a column would be a migration leaving every historical invoice holding
a value it never had, and would then need keeping in step with the lines it
duplicates. On the PDF it is omitted entirely when there is none, because
`detailGrid` drops null pairs and an always-present blank field on a document a
patient keeps reads as something the system failed to fill in.

**The payable carries our own order number too.**
`PartnerLabCharge.sourceAccession` is what makes that row auditable rather than
a figure: "what is this charge for" is answered from the hospital's own records
instead of by telephoning the laboratory. The receiving lab's institutional
invoice names the sender's accession beside their name for the mirror-image
reason — an invoice naming only a company is one the recipient cannot match to
anything.

**The doctor was shown the row id, and reported the number as never being
generated.** The order sheet's confirmation read `Request #{issued.id}` — the
database primary key, which appears on no label, no worklist row, no invoice
line and no report. So the person who raised the order was handed the one
identifier in the system that maps to nothing, while the accession sat in the
same response unread. It was generated at ordering all along; it was never
shown.

The row id is gone rather than demoted: two numbers against one order is worse
than the wrong one alone, because somebody quotes whichever they read first and
only one of them resolves anywhere. Both clients now lead with the accession at
the moment of ordering and carry it on the patient record, which is where a
doctor comes back to look it up. `accession.spec.ts` pins that the sheet renders
`issued.accession` and never `#{issued.id}` — and it failed on its first run
against its own explanatory comment, so it strips comments first, the same
lesson `nav-modules.spec.ts` learned.

**Allocated at ordering, and again on demand — and the second half was
missing.** The label has to be printed *before* the draw, so the number cannot
wait for collection to be recorded; that is why ordering allocates one. But the
migration deliberately does not backfill, so every order raised before this
showed *"no specimen no."* with no way anywhere in the product to obtain one.
Reported on the first look at the worklist, and the sixth time this project has
shipped a refusal nobody can satisfy. `ensureAccession` closes it: a number is
allocated the first time somebody actually needs one — at collection, and when
a label is printed — which are the two moments a physical tube comes into
existence. Both clients offer the label action on an order with no number and
label it *Get number & labels*, because a button hidden for exactly the orders
that need it is how the dead end was reachable in the first place.

**Allocation is read-then-write inside the caller's transaction, retried on the
unique index rather than locked.** Two receptionists ordering in the same second
is the only contention this ever sees; a table lock would serialise every order
in the hospital to protect against something one retry resolves. The next number
is parsed out of the last accession rather than counted — a count is wrong the
moment anything is deleted, and would silently reissue a number already printed
on a tube.

**Labels are Code 128, encoded here rather than added as a dependency.** It is
what specimen labels use: Code 39 is ~40% wider for the same data, and on a
sticker wrapped round a 13mm tube every millimetre of quiet zone counts. The two
obvious libraries each bring a rendering stack this project does not want —
`bwip-js` a PostScript interpreter, `jsbarcode` a DOM — and what is actually
needed is the bar pattern as numbers, so the PDF renderer draws rectangles and a
screen draws an SVG from one source of truth. Data Matrix, which is better on
the smallest tubes, needs Reed–Solomon and is absent rather than approximated.

**The barcode contains the accession and nothing else.** Not the name, not the
date of birth, not the tests. A specimen label is handled by couriers, sits in
open racks and ends up in clinical waste; encoding identifiers into it turns
every discarded tube into a data breach. The barcode is a key and the system
holds the record. The accession is *also* printed in readable characters under
it, because a smudged label is exactly when somebody has to type it in.

**One label per specimen, not per test.** A full blood count and a clotting
screen go in different tubes; a sodium and a potassium share one. So labels are
grouped by `LabSpecimenType`, and printing one per test would have a
phlebotomist draw four tubes where two were needed — a real harm to the patient
in the chair. `NONE` (imaging) produces no label at all.

**Labels are not gated on authorisation, unlike the report.** A label is needed
*before* any work happens and carries no result; the report gate exists because
an unauthorised result must not leave the laboratory. They are reprintable at
any time, because a label that smudged, peeled or went on the wrong tube is
answered by another label, and a print action that existed only at ordering
would mean finding a doctor to raise the order again.

**Scanning is a focused text input, and that is not a shortcut.** Bench barcode
scanners are keyboard-wedge devices: they type the characters and press Enter,
exactly as a person would. A text box *is* the driver — it works with every
scanner on the market with no configuration, no permission prompt and no
camera, and it is what a real LIS presents. Building a camera pipeline for a
desktop would be solving a problem the hardware solved thirty years ago. A scan
jumps to the segment the tube is actually in, derived from its status, and
highlights the row rather than opening it: somebody working a rack scans twenty
in a row, and a detail page to dismiss each time makes a one-handed job
two-handed.

#### A report is often a file, and the file is the result

Analytes and a narrative cover a full blood count. They do not cover what a
laboratory most often actually hands over: a signed PDF, an analyser's printout,
a histopathology report written in Word. Retyping one into a text box loses the
signature and the layout, and retyping a report is where transcription errors
come from. `LabAttachment` holds them.

**Two tables, and the split is the design.** Prisma selects every scalar column
unless a query says otherwise, so a `Bytes` column on the metadata row would
mean the query that lists filenames pulling every PDF on the order into memory —
with the mistake invisible at the call site. The bytes live in
`LabAttachmentData` behind a relation, so a blob arrives only if somebody writes
an `include`, and `lab-attachments.spec.ts` asserts that exactly one method
does. If a second one ever needs to, that is the moment to move to object
storage rather than the moment to add a second `include`.

**This is the answer to "the logo pattern must not be copied", not a violation
of it.** That warning is about a base64 blob on `Tenant`, a row read on nearly
every request. This is a blob on a row nothing reads except a download. For a
hospital running one API against one Postgres — every deployment today — a table
is the boring correct answer: one backup, one restore, one set of policies, no
credentials and no bucket to secure. It stops being right when files outgrow the
backup window, and the service boundary is where that swap would happen.

**The declared content type is used for nothing.** A file announcing itself as
`application/pdf` and containing HTML is the whole attack: store it, serve it
back with the type it claimed, and it runs on this hospital's origin. So the
type is read from the file's own leading bytes, and `.docx` is confirmed by
finding the Word part inside the ZIP rather than by the ZIP signature alone —
which every `.jar`, `.apk` and renamed archive also has. Three independent
defences, because one is a single point of failure: sniff and refuse; serve the
sniffed type; and serve anything that is not a PDF as `attachment` with
`nosniff`, so a mis-sniffed file is a download nobody can open rather than
script executing in the page.

**Images are refused deliberately.** Imaging results are a real gap, recorded
below. Accepting a JPEG here would look like closing it while storing a
radiograph in a form no radiologist can window, zoom or measure — worse than
leaving the gap open, because it would look done.

**A file obeys the authorisation gate more strictly than a screen does.** It is
withheld from everybody but the laboratory until the report is verified, it
cannot be attached to an authorised report, and it cannot be removed from one. A
screen's state is visible and revocable; a PDF somebody has already saved to a
phone is neither, and has nothing on it to say it was provisional.

Reception can print the *rendered* report and cannot download an attachment. The
rendered one is a document the system produced and gated; an arbitrary file a
technician uploaded may be an analyser dump or a working note, and nothing has
decided it is fit to hand to a patient.

#### A role that existed everywhere except where it could be granted

`LAB_TECHNICIAN` was added to `UserRole`, given a nav menu, a landing screen,
four web screens and three mobile ones, an entry in the access matrix and a
green test suite — and **no account could hold it**. Three screens across the
two clients each declared their own array of roles (`admin/users`,
`roles-sheet`, mobile `settings/staff`), none of them knew about the new one,
and `nav.test.ts` had a fourth copy so the test asserting "every role has a
menu" quietly stopped covering the newest role.

The symptom was reported two roles away from the cause: a doctor ordered a test,
the order was written correctly, and it was visible to nobody. Nothing about the
worklist was broken — there was simply no user who could open it.

**The fix is derivation, not vigilance.** `ROLE_LABEL` is a
`Record<UserRole, string>`, so adding a member to the enum is a compile error
until somebody names it, and `ALL_ROLES` is `Object.keys(ROLE_LABEL)`. Every
screen imports that. Clinical roles first and ADMIN last, because on a form for
a new member of staff the most powerful role should not be the first thing under
the cursor.

`role-lists.spec.ts` guards it: no client file outside `web/lib/nav.ts` and
`mobile/lib/nav.ts` may contain an array literal holding three or more role
names. Re-declaring one compiles perfectly and is invisible in review — a list
of six role names looks exactly like what it should be, and the failure only
appears when somebody tries to use the seventh.

`MOBILE_ROLES` is the one allowed second list and earns it: it answers a
different question — which roles the *phone* has screens for — and
`role-screens.test.ts` already fails the build if a role in it has no tab.

#### A setting nothing could set, and the refusal it produced looked legitimate

`acceptsExternalLabOrders` shipped as a column the partner lookup read and no
screen could write. So every attempt to add a partner laboratory was refused —
*"no lab is accepting orders under that code"* — correctly, unexplainably, and
with no way to clear it from anywhere in the product. Reported from use on the
first real attempt.

**Fifth time in this shape, and the first four were about rows.** The medicine
catalogue was seed-only; `Doctor` profiles could only be made as a side effect
of creating a user; wards had no create route; drug-chart items the parser
refused to schedule had no screen that could set them. `self-provisionable.spec.ts`
was written for that family. This one is about a *flag*, and it fails more
quietly: a missing endpoint produces a 404 that reads as broken, whereas a
missing switch produces a refusal that reads as correct — because it is.

`settings-reachable.spec.ts` closes it. For every field of `ClinicSettings`: the
update DTO accepts it, `updateClinicSettings` persists it, and an admin screen
*sends* it. Mobile is checked against an exemption list with reasons.

**Getting the matcher right took three attempts and each failure was
instructive.** Searching every client file passed the tax settings on mobile,
because an invoice screen reads `taxEnabled` to decide whether to draw a tax
line. Narrowing to the settings screens still passed them, because the screen
declares the whole settings shape in a type in order to display it. **Reading a
setting and being able to change it are different capabilities**, and a test
that conflates them would sign off a hospital that can see its own tax setting
and never alter it. The signal is `field: …form.field` in the PATCH body — with
the loose middle, because the numeric settings are coerced on the way out and a
stricter pattern reported four reachable settings as missing.

The three lab settings sit beside the pharmacy's three and are deliberately not
merged with them. A hospital may run one, both or neither, and a single "accept
work from other hospitals" would mean a clinic wanting to take in bloods had
also agreed to dispense other people's prescriptions.

#### A client body and its DTO were free to disagree, and did

`POST /lab-tests` returned 400 on every create. The admin form built one object
and posted it to both the create and the update route, adding `code` for the
create — one line shorter, and wrong: `isActive` belongs to `UpdateLabTestDto`
and not to `CreateLabTestDto`, because a new test is offered by definition and
there is nothing to decide. The global pipe runs with
`forbidNonWhitelisted: true`, correctly refused it, and told the user
*Bad Request Exception* and nothing else.

**Nothing in the repo compared a client body with the DTO meant to receive it,
and typechecking structurally cannot.** The client posts an object literal into
a `body` typed `unknown`; the DTO is a runtime contract made of decorators. The
two are free to drift, and the drift arrives as a 400 in a log.

`lab-dto.spec.ts` pushes the bodies the screens actually send through a
`ValidationPipe` configured exactly as `main.ts` configures it — including the
three awkward shapes that are ordinary in this module and easy to forget: a
worded reference range instead of a numeric one, an imaging test with no
specimen and no analytes, and `sellingPrice: null` meaning unpriced rather than
free. The fixtures are copied from the call sites and can go stale, which is a
real limit and still far better than the nothing that preceded it.

**The second half of the fix is that the reason is now on screen.** A validation
400 already names the field and says why; showing only `message` gives an
administrator a red box on a twenty-input form telling them something is wrong
and not which thing. `ApiError.errors` has carried that list since the patient
form needed it, and the lab sheet was not reading it — the same omission the
vitals form was reported for. The next one of these should diagnose itself.

The tempting repair was adding `isActive` to the create DTO, which would have
made the error go away and left a parameter that silently does nothing. The fix
is on the client: build the two bodies separately, because feeding two different
contracts from one literal makes them look interchangeable when they are not.

### The test suite could not run itself, and that hid two failures

`jest` ran out of memory and killed its own workers — `Zone Allocation failed`,
then a cascade of `SIGTERM` on unrelated suites, which reads as those suites
being broken and is not.

The cause is `ts-jest` **type-checking in every worker**. Each one loads the
generated Prisma client, whose `index.d.ts` is **6 MB** for this schema, and
with jest's default worker count that is several full type-checks of it in
parallel. It crossed the line when the client was regenerated with diagnostics,
attachments and modules in it; before that it was merely slow.

`isolatedModules: true` makes the transform transpile-only. **No type safety is
lost** — `npx tsc --noEmit` is the typechecker and always was; jest was doing
the same work a second time, per worker, for nothing. Peak heap per suite went
from an OOM to ~100–170 MB and the guards directory from timing out to 2m30.

**Two real failures were behind that wall**, which is the part worth
remembering. A suite that cannot run asserts nothing, and this repo had already
learned that once — `access-matrix.spec.ts` sat unrunnable behind a broken
native binding and reported four unchecked controllers the day it worked. Here
it was `audit-target.spec.ts`: the laboratory added **thirteen** id-bearing
routes and none of them resolved, so every denial on a lab route recorded
`target=-`. Exactly the defect a live run found in Phase 6, arriving again in a
new module, because nothing about adding a controller forces anybody to open
that file. The test derives its cases by parsing route paths out of the
controllers, so it caught all thirteen at once.

Keep the suite runnable. It is not a convenience.

### The icon is a red cross, and it is deliberately never on white

The app shipped for its whole life with **no icon, no splash and no adaptive
icon** — no `assets/` directory existed at all, so every build carried Expo's
default blank artwork. Not cosmetic at the point of release: Play refuses a
listing without a 512×512 icon, and a hospital asked to install a blank white
square on a ward phone has no way to tell it from anything else on the device.

**The mark is a red cross with a heartbeat cut through it, on `#0D1317`.** The
field is the part to leave alone. A red cross on a **white ground** is protected
under the Geneva Conventions and is a criminal offence to use commercially in
most countries this product is sold into — the ICRC enforces it and app stores
have removed listings over it — and the inverse, white on red, is the Swiss
flag, protected by the same instruments. Neither of those is what this is. If
somebody ever lightens the field because the icon "would pop more", that is the
moment to stop; it is a legal question wearing the clothes of a styling one.

**The heartbeat is a cut, not a line.** It is a stroke in the field colour, so it
reads as a notch taken out of the cross. A line laid *over* the cross thins as
the icon shrinks and is gone by 24px; a cut-out keeps its shape for as long as
the cross has one. It also has a consequence that is easy to get wrong later:
Android's adaptive foreground is transparent apart from the mark and is
composited over `android.adaptiveIcon.backgroundColor`, so if that value and the
artwork's field ever disagree the result is not a slightly wrong shade — it is a
visible stripe drawn across the icon on every Android home screen. `BRAND_FIELD`
in `app.config.js` and `FIELDS` in `scripts/make-icons.mjs` are the two places
that must agree, and both say so.

**Every asset is generated from one description.** `npm run icons` writes
twelve PNGs from `scripts/make-icons.mjs` — icon, adaptive foreground and splash
for each of the three environments, the notification silhouette, the Play icon
and the feature graphic. Twelve exported files that have to agree with each
other is twelve things to redo by hand the day the red changes, and the sizes
are not decorative: Android crops an adaptive icon to whatever shape the
handset maker chose, so the mark is held inside the central 72% rather than
drawn to the edge.

Three rules in that script are each a mistake somebody makes once. **The icon is
square with no transparency** — both stores mask the corners themselves, and
pre-rounded artwork is rounded twice and shows a dark crescent inside the mask.
**The adaptive foreground keeps its alpha** while the store icon must not have
any; Play refuses one with an alpha channel and iOS renders it black, so
`flatten` is keyed on the filename rather than applied to everything. And **the
notification icon is a plain white cross**, because Android discards colour and
tints the silhouette — the heartbeat cut would fill in, so it is absent by
decision rather than discovered on a device.

**Dev and staging carry a coloured band, not a coloured field.** `app.config.js`
has claimed since it was written that the three environments get "different
names and icons" so a release candidate can sit beside the app a nurse is using;
the names differed and the icons never did — a stated rule with nothing
implementing it, which is the family this file keeps reopening. Tinting the
whole field was the obvious fix and is wrong: a red cross on amber is unreadable
at 48px, and the band exists to be legible on a home screen rather than to be
pretty. The band is on the bottom edge, so it is deliberately **absent from the
adaptive foreground** — that edge is exactly what Android crops away.

**The feature graphic carries no text.** A font named in the SVG is resolved
against whatever is installed on the machine running the script, so the app's
name would set in one typeface on a laptop and another in CI, or in a fallback
that fits badly — and the store page is the one asset nobody looks at twice. The
wordmark goes on in a design tool, where somebody can see it.

### SDK 53 → 57 in one jump, and the two changes that fail silently

The phone moved from Expo SDK 53 (RN 0.79) to **SDK 57 (RN 0.86, React 19.2)**
in a single step, after a signed AAB had been produced on 53 and not before —
the order mattered, because SDK 57 removes the old-architecture fallback the
first build depended on, so upgrading first would have meant debugging a
four-major dependency jump with no way back to something known to work.

Every pin came from `node_modules/expo/bundledNativeModules.json` — the SDK's
own version map — rather than from a guess or a blog post. `expo install --fix`
is the proper tool and needs `api.expo.dev`, which is blocked on this machine;
the map ships inside the `expo` package and answers the same question offline.

**Two of the changes are the dangerous kind: a key that stops existing rather
than erroring.**

- **`splash` is not in the SDK 57 schema.** The top-level `splash` block became
  `web.splash` (a PWA concern); the app splash is now the `expo-splash-screen`
  plugin, with the same three options. Left where it was, Expo ignores it and
  the app ships with **no splash artwork** and no warning — the icon work would
  have half-disappeared with nothing naming the cause.
- **`enableProguardInReleaseBuilds` → `enableMinifyInReleaseBuilds`**, renamed
  in SDK 54 and absent from the SDK 57 reference. `expo-build-properties` does
  not reject an unknown key loudly, so the old name leaves minification and
  therefore resource shrinking **quietly off** in a build whose config reads as
  having asked for both.

Both were found by grepping SDK 57's own `@expo/config-types` for the keys this
config sets, which is the only way to tell "removed" from "still accepted" —
a changelog says a key was deprecated, the schema says whether it is still read.

`android.edgeToEdgeEnabled` went the same way and costs nothing: edge-to-edge
became mandatory, so the key was removed and the template writes it itself. The
*obligation* is unchanged and still unverified on a handset.

**What changed in code was three things and no more.** `StyleSheet.absoluteFillObject`
was removed in RN 0.85 → `absoluteFill`, in thirteen files, and
`role-screens.test.ts` asserted on the **old** name, so it was pinned to the new
one *and* to the absence of the old rather than loosened to a substring that
would pass against either. `expo-file-system`'s default export changed in SDK 54
and the functions this app uses moved to `expo-file-system/legacy` — a plain
import still resolves and returns a module without them, so it fails when a
doctor presses print rather than at build time. Nothing imported
`@react-navigation/*` directly, which is why expo-router forking React
Navigation in SDK 56 cost nothing here; had a screen imported it, the bundler
would have refused.

### Known issues

- **The per-stream revenue figures have never run against a live database.** The arithmetic is unit-tested over fixtures and all three projects typecheck, but nothing has grouped real invoices of three kinds across a real month boundary in a non-UTC timezone — which is exactly the case `resolvePeriod` and `hospitalMonthRange` exist for. No migration is involved: every figure is derived from invoices, payments and refunds that already exist, so `npm run db:rls` is not needed and nothing has to be backfilled. Watch the first look for the thing a fixture cannot show: whether `invoice.items.taxAmount` is heavy enough to matter on a tenant with a year of pharmacy sales, since `revenueFor` fetches items for every invoice issued in the period **plus every open one whenever it was raised** — the `OR` that makes the all-time owed figure correct is also the one that makes the query grow with unpaid history rather than with the period.
- **The dashboard's patient and referral figures have never run against a live database.** The arithmetic is unit-tested over fixtures — 27 assertions across `patient-activity.spec.ts` and `referrals-out.spec.ts` — and all three projects typecheck, but nothing has counted real appointments across a real month boundary in a non-UTC timezone, and nothing has grouped real prescriptions by a real partner tenant. No migration is involved: every figure is derived from columns that already exist, so `npm run db:rls` is not needed and nothing has to be backfilled.
- **The dashboard now fetches appointments as rows rather than counting them.** `patientActivity` needs a distinct patient count and a per-doctor split, and neither is a `count()`. On a tenant with a busy month that is thousands of rows with four columns each, which is fine; on a *year* selected as a range it is not. It is the same unbounded-period gap as the revenue card below, and the same fix applies — the lab statement's `take` + one-row-over pattern — and is not applied to either yet.
- **`stepMonth` on the phone steps from what the server last resolved**, held in a ref. That is right, and it means the arrows do nothing until the first response lands — a tap in the first few hundred milliseconds falls back to the device's current month. Harmless and worth knowing before somebody reports the arrows as unresponsive.
- **A wide period is not refused on the revenue card.** The lab statement refuses rather than truncating, because a page short by whatever was cut is a wrong number a reader cannot spot. This card has no such cap: a range picker makes "the last two years" one action away, and the query would fetch every invoice and its items across it. The figures would still be right; the request would be slow. The statement's `take` + one-row-over pattern is the fix and is not applied here yet.
- **`outstandingAllTime` is the same number on every row whatever the period**, which is correct and reads oddly the first time: changing the period moves seven columns and leaves the eighth alone. That is the point — it is the figure that ignores the period — and it is labelled, but somebody will still ask once.
- **`FinanceReport`'s `pharmacy` and `lab` blocks are computed, serialised, and declared by no client.** The backend has returned them since the pharmacy shipped and neither `web/lib/types.ts` nor the reports screen has ever named them — so the 12-month per-stream trend exists in the response and is thrown away. The dashboard card covers today, the week and the month, which is what was asked for; the trend is the obvious next step and is absent rather than half-wired. Eighth instance of the family, and the first where the unreachable thing is a *field* rather than a route or a setting.
- **Nothing reconciles the dashboard's combined total against the pharmacy or lab dashboards.** All three now read from the same windows and the same `Invoice.kind`, so they should agree — and if they drift, nothing says so. `/pharmacy/dashboard` counts sales from `DispenseEvent` while this counts billed from invoices, which is deliberate (a handover with no price still leaves the shelf) and means the two are *not* the same number by design. Worth knowing before somebody reports it as a bug.
- **The vendor console's emailed recovery is the weakest link in the deployment by construction, and the three controls around it are not a substitute for a second factor.** A mailbox is now sufficient to take a console account, and the cooling-off only delays the part that reaches patient data. TOTP on `PlatformUser` is the real answer, it is absent rather than half-built, and it is the single highest-value thing left in this file.
- **The reset notification goes to every other console account, so a one-person vendor gets none.** That is logged and nothing else — the control simply is not operating, and the deployment is exactly as safe as one mailbox. Worth knowing before the first hire rather than after.
- **`platform_password_reset_tokens` needs `npm run db:rls`.** It is a new table carrying the *inverted* policy and gets none from the migration. Skipping it leaves RLS disabled on the one table whose rows are live links into accounts that can open a grant against any hospital.
- **Nothing sweeps expired console reset tokens either**, for the same reason and with the same mitigation: expiry is checked per request, so a sweep that has not run cannot make a dead link work.
- **Password reset has never run against a live database, and nothing has ever sent an email from this system.** The token rules are unit-tested, all three projects typecheck, and `MailService` reports delivery honestly — but nothing has put a message through a real SMTP server, and `nodemailer` has never been installed here. Every previous first live run in this project found something no amount of reading could; assume this has one, and assume it is in the two places a unit test structurally cannot look: whether the `log`/`smtp` switch behaves as described against a real relay, and whether a link built from `WEB_URL` actually resolves for whoever opens it.
- **The `password_reset_tokens` migration is hand-written** like the nineteen before it — check it with `prisma migrate diff` before applying it to anything holding data. **`npm run db:rls` is *not* needed**, and that is a decision rather than an oversight: the table carries no `tenantId` and deliberately gets no policy, because it is read on an unauthenticated request where `app.tenant_id` is unset and the generic policy would make every valid link read as expired.
- **Nothing sweeps expired reset tokens.** Expiry is checked per request, so a sweep that has not run can never mean a dead link still works — which is the important half and the reason this did not have to wait for a scheduler. What accumulates is rows: one per request, forever, on a table nothing prunes. `expiresAt` is indexed for the delete that does not exist yet.
- **A reset link is only as good as the address on the account.** Nothing verifies an email address at any point — an account created with a typo in it has a reset path that silently goes to somebody else, or nowhere. That is the same exposure the temporary-password flow always had, and self-service reset makes it reachable by anybody rather than only by an administrator. Address verification is the fix and is absent rather than half-built.
- **`MAIL_FROM` defaults to `no-reply@localhost`, which every real relay will refuse.** Deliberate: a plausible-looking default is one somebody ships. The boot log names the transport, so a misconfigured deployment says so at start rather than when a locked-out administrator asks for a link.
- **The vendor can now reset a hospital administrator, and that is a real transfer of power rather than a technicality.** Bounded by three things — a grant of at most eight hours carrying a written reason, `mustChangePassword` so the customer's first act replaces it, and a row in *that hospital's* audit log — and none of them stops a vendor engineer who has already decided to. Two-person approval is modelled for break-glass (`createdById` differing from `platformUserId`) and is still not enforced anywhere, which matters more now than it did when a grant bought only aggregates.
- **A vendor password change writes no audit row.** Every row in this system carries a `tenantId` or an explicit null meaning "an anonymous event at no hospital", and this belongs to neither — it is vendor-internal and concerns no hospital, so writing it against one would put a misleading row into their records. A vendor-side log is the right home and does not exist.
- **`npm run db:migrate` is `migrate deploy`, and was `migrate dev`.** `dev` creates a **shadow database** to check the migration history, so it needs `CREATEDB` — which the owner role here deliberately does not have, and should not: the split that makes RLS mean anything is an application role that cannot run DDL and an owner that can, and neither of them needs to create databases. It failed with `P3014 permission denied to create database`, which reads as a broken migration and is a wrong command. `deploy` applies the pending migrations in order and creates nothing. It is also the only correct command for this repo whatever the permissions: **every migration here is hand-written**, so there is nothing for `dev` to author, and what `dev` adds over `deploy` is exactly the behaviour that is dangerous against a database holding data — it compares the schema to the history and offers to *reset* on drift. `db:migrate:dev` survives for the day somebody genuinely wants Prisma to write one, and granting `CREATEDB` is the wrong fix.
- **`query-string` was a direct dependency here and is not any more**, and the history is worth keeping because the removal was conditional. `expo-router@5.1.11` required it in its built output and **did not declare it** — an upstream packaging bug. Under SDK 52 it resolved by accident, hoisted in by something else that later dropped it; under SDK 53 the bundle failed with *"Unable to resolve module query-string from expo-router/build/fork/getPathFromState-forks.js"*, so it was added directly and pinned to `^7` (the built code does `require()` and v8 is ESM-only). The note said to remove it *when expo-router declares its own dependency, and not before*. `expo-router@57.0.23` declares `"query-string": "^7.1.3"` in its own `dependencies` — checked against the published manifest rather than assumed — so it went at the SDK 57 upgrade. The condition was the point: deleting it because "nothing in our code imports it" would have broken the build at any time before that.
- **The bundler is a separate gate from the typechecker, and only it catches a missing module.** That failure survived `tsc --noEmit`, all 199 tests, `expo prebuild` and Gradle's entire Kotlin compile — it surfaced at `createBundleReleaseJsAndAssets`, three minutes into a release build. `npm run bundle:check` runs exactly that step (`expo export`) in about twenty seconds with no Android SDK, so an upgrade can be checked for resolution failures before anything native is attempted. Worth running after any dependency change.
- **`expo-notifications` throws when it is *imported* in Expo Go, so nothing may import it at the top level.** Remote push left Expo Go in SDK 53 and from SDK 55 the module raises rather than warning — and it does so at import, before any of this app's code runs. Expo Router statically requires every file under `app/`, so one top-level import in `alerts.tsx`, a screen nobody had opened, took the **whole app** down at launch with a red screen naming `expo-router/build/ExpoRoot.js` and no file of ours in the stack. The first fix was a guard inside `registerForPush` and **could not work for exactly this reason** — the throw precedes the function. `loadNotifications` in `lib/push.ts` is now the single permitted importer, uses a dynamic `import()`, checks `Constants.executionEnvironment === ExecutionEnvironment.StoreClient` (rather than matching Expo's error text, which would break silently the day they reword it), and resolves to `null` where push is unavailable — which every caller already treats as ordinary. `setNotificationHandler` moved inside it, because module scope is the thing that cannot be reached safely. `push-import.test.ts` fails the build on any static import, because the mistake is invisible in review: it is what the library's own docs show, it typechecks, and it works perfectly in a development build — so it can be written, merged and released, and only breaks for whoever next opens Expo Go. A release build was never affected. **Testing push at all needs a development build**, which nothing in this project has produced.
- **SDK 57 has not been built, bundled or run.** The pins come from the SDK's own version map and the code changes are the ones its schema and RN's release notes name, but nothing has installed the tree, typechecked against React 19.2, bundled, prebuilt or produced an AAB. Every previous first run in this project found something no amount of reading could; assume this has one. The order to check in: `npm install`, then `npx tsc --noEmit`, then `npm test`, then `npm run bundle:check` (twenty seconds, catches a module that cannot resolve — which is exactly what the SDK 53 jump failed on), and only then `npm run aab`.
- **`globalThis.fetch` is Expo's implementation from SDK 56, not React Native's.** Every API call this app makes goes through `fetch` in `lib/api.ts`, and the swap happened silently under us — it is WinterTC-compliant rather than RN's older behaviour. Nothing here is known to depend on the difference, and the places it could bite are the ones this app actually does: the `FormData` multipart upload in `documents.ts` where the boundary is deliberately left to the runtime, and the `Authorization` header on every request. If a networking regression appears after the upgrade, `EXPO_PUBLIC_USE_RN_FETCH=1` in `.env` restores the old implementation — worth knowing before spending an afternoon in the backend.
- **`expo-file-system/legacy` is a deferral, not a fix.** `lib/documents.ts` imports it for `cacheDirectory`, `downloadAsync` and `deleteAsync`. Expo said in SDK 54 that the legacy path would go in 55 and it is still published in 57, so there is room — but the one call that is not a rename is `downloadAsync(url, target, { headers })`, and an authenticated download is the entire purpose of that module. Migrating it deserves its own change rather than being folded into an SDK bump.
- **TypeScript stayed on 5.9 while the SDK 57 template pins 6.0.3.** A deliberate one-variable-at-a-time call: a TypeScript major on top of a four-major SDK jump means a typecheck failure could be either, and `ts-jest@29` is not known here to support TS 6. Worth revisiting on its own, and it is a real divergence from the template rather than an oversight.
- **The path length is now a hard constraint, because the flag that used to sidestep it no longer exists.** `ANDROID_NEW_ARCH=false` removed the C++ codegen and produced the first installable build of this app. RN 0.82 **ignores** `newArchEnabled=false` — the legacy architecture was removed, not deprecated — and Expo SDK 55 dropped the key from the config schema, so on SDK 57 it is not a key this project accepts. It was deleted from `app.config.js` rather than left reading against a value nothing consumes: a lever that silently does nothing is the failure this file keeps reopening, and somebody would have set it during a bad afternoon and believed they had changed something. So `C:\hms` is not a preference — it is what keeps ninja's own `path.size() > MAX_PATH` check satisfied, at 255 against 260. **Re-measure after any dependency change**, since the dominant term is a third-party module's codegen directory names and five characters is the whole margin.
- **The new architecture could not be built on Windows from the original folder, and the arithmetic that said moving would not help was measuring the wrong string.** RN's new architecture generates C++ per native module, and CMake embeds the whole source path *inside* the object path; ninja reports *"Filename longer than 260 characters"* against a generated file, minutes in, after Kotlin has compiled and the JS has bundled. Enabling Windows long paths does **not** fix it — ninja holds its own `path.size() > MAX_PATH` check and refuses before Windows is ever asked, so the registry flag is never consulted. The first measurement here was of the *absolute* path (~397) and concluded every clone location was over; ninja checks the path **relative** to its build directory, which is 294 today and **255** at `C:\hms\mobile`. So shortening the path does work, and this entry said the opposite for a while — one more false reason that read as a decision somebody had made. **`subst` is not a way to shorten it**, though the arithmetic says 244: building from a mapped `X:\` failed identically, with ninja reporting *Entering directory `C:\Najmus\…`* and the object path still embedding `C_/Najmus/…`, because Gradle and CMake canonicalise the drive away before the path is ever written. Only relocating the files actually reaches CMake. The certain remedy is still `ANDROID_NEW_ARCH=false`, which removes the codegen entirely at the cost of the old bridge; a newer CMake is worth trying and is not promised, since newer ninja carries the same check and nothing in the generated project pins a CMake version for it to be picked up by. `patch-signing.js` measures the folder and warns before Gradle starts. See [`DEPLOY-ANDROID.md`](DEPLOY-ANDROID.md) section 3c.
- **Edge-to-edge is on and no screen has been looked at under it.** At `targetSdkVersion` 36 Android draws app content under the status and navigation bars with no way to opt out, so `edgeToEdgeEnabled` is declared rather than inherited. `AppHeader` already wraps itself in `SafeAreaView edges={['top']}` and the tab bar takes its bottom inset from react-navigation, so the pieces are there — but "the pieces are there" is not the same as "the header does not sit under the clock", and this project has twice found a layout fault only by rendering something and looking at it. First thing to check on a handset.
- **No icon has been seen on a phone.** The artwork is generated rather than exported by hand, the geometry is checked against Android's 72% safe area, and every size was drawn and looked at — but nothing has installed the app and looked at the home screen, and an icon is the one asset that is *only* judged that way. Watch the first install for the two things the source cannot show: whether the heartbeat cut survives the handset's own downscaling to 48dp, and whether `adaptiveIcon.backgroundColor` and the artwork's field actually match on the device, since a mismatch there draws a stripe across the icon rather than shifting its shade.
- **The store assets are generated on a developer's machine, not in CI.** `npm run icons` needs `sharp`, and nothing fails the build if `assets/` is empty or stale — Expo substitutes its own blank artwork and the build succeeds. So a red changed in the script and not regenerated ships the old icon silently. A check that the PNGs are newer than the script is the obvious guard and does not exist.
- Module entitlements have **never run against a live database**. The guard, the role narrowing and the console are unit-tested and all three projects typecheck, but `tenants.modules` is unverified against real rows. The `tenant_modules` migration is **hand-written** like the eleven before it — check it with `prisma migrate diff` before applying it to anything holding data. `npm run db:rls` is *not* needed: it adds one column to a table that already has its policies.
- A module that is off now names itself at the foot of the menu on both clients — *Not in your plan: Laboratory, Billing* — because an absence explains nothing and a gated item simply vanishes. Reported as *"a lot of options have gone, partner labs, partner pharmacy"* by an administrator who could not tell a changed plan from a broken build. Shown to every role, since a receptionist who cannot find the appointment book is the person least able to guess why. What is still missing is anything at the moment of *reaching* for a screen: a bookmarked URL bounces off `canReach` with no explanation, and the 403 that names the module arrives only on a write.
- **`ModuleGuard` never refuses a read, so a module that is removed leaves its data browsable in a menu that no longer reaches it.** Deliberate — the alternative hides a patient's results over a billing decision — but the practical consequence is that an administrator has to be told to use a direct URL to reach what they still own, and `canReach` will bounce them off it. The guard is right and the client is stricter than the server here.
- **Modules narrow the roles a screen offers and do not touch accounts that already hold one.** A hospital whose CLINIC module is removed keeps its doctors, who can still sign in, still read everything, and cannot prescribe. That is the correct handling of a commercial change and it is not visible anywhere: nothing lists "staff holding a role you no longer have a module for".
- Diagnostics has **never run against a live database** — not the ordering path, not the worklist, and emphatically not the cross-tenant result write-back, which is the first feature in this system where data crosses the isolation boundary in both directions. Every previous first live run found a bug no unit test could see; assume this has one, and assume it is in the return leg.
- The `diagnostics` migration is **hand-written** like the nine before it, and it is the first to use `ALTER TYPE ... ADD VALUE`. Check it with `prisma migrate diff` before applying it to anything holding data, and **`npm run db:rls` is required** — eight new tables carry `tenantId` and none gets a policy from the migration.
- **No results feed.** A doctor finds results per patient; there is no "waiting for my attention" list. That needs a notion of acknowledgement which does not exist here, and half-building it produces a list that never empties. Absent rather than faked.
- **Nothing notifies anybody about anything in the lab.** Not a critical value, not a STAT order, not a partner's report arriving. The worklist and both queues auto-refresh every 15 seconds while open, so somebody watching sees it within a quarter minute and somebody who is not sees it when they look. Push exists (`notification-payload.ts`) and none of this uses it. The critical-value stop and the recorded telephone call are the compensating control, and both clients say so plainly.
- **No delta checks and no cumulative view.** A potassium that has moved from 4.0 to 6.0 in a day is flagged only against the absolute range, and there is no way to see a patient's previous value beside the current one. `numericValue` is stored for exactly this and nothing reads it yet.
- The `payable_accession` migration is **hand-written** like the sixteen before it and adds one column to a table that already carries its policy, so `npm run db:rls` is *not* needed. It is deliberately **not** backfilled — the referral holds the sending hospital's accession, but joining across it to fill in earlier rows would put a number on a financial record that nobody put there.
- Accessions, labels and scanning have **never run against a live database or a real scanner**. The encoder and the check character are unit-tested, but nothing has printed a sticker on a thermal printer and read it back — which is the only test that matters for a barcode. Watch the first print for the two things a unit test cannot see: whether the module width survives the printer's resolution, and whether the quiet zones are wide enough on a curved tube.
- **No camera scanner on mobile.** It needs `expo-camera`, a native permission prompt and hardware nobody has run this app on, and a button that asks for the camera and then fails on a device is worse than a box that always works. Bluetooth ring scanners — what phones actually get paired with on a ward — present as keyboards and type into the existing box, so the common case is covered. The camera is the gap.
- **No `LabSpecimen` row, so every tube from one order carries the same accession.** A per-tube suffix was considered and rejected: without a model behind it the suffix is a number the system cannot resolve, and a scan that lands nowhere is worse than one that lands on the order and lets the technician pick the tube. Per-tube tracking — which tube was received, which was haemolysed — belongs on that model when it is needed.
- **Nothing reconciles a label against the specimen it was stuck to.** Mis-labelling at the point of draw is the commonest serious error in phlebotomy and no barcode can catch it; the patient's name is printed larger than the accession for exactly that reason, and positive patient identification at the bedside is a bigger feature than this.
- The `lab_accession` migration is **hand-written** like the fifteen before it; `npm run db:rls` is *not* needed, since it adds columns to tables that already carry policies. Existing orders are deliberately **not** backfilled — inventing an accession for an order that never had a label printed would put a number on a record nobody can find a tube for, so the screens say "no specimen no." instead.
- The partner-lab payable and the partner price lookup have **never run against a live database**, and `partner_lab_charges` is the first table written into *another* tenant's scope by a plain create rather than by the result write-back. The `partner_lab_charges` migration is **hand-written** like the fourteen before it, and **`npm run db:rls` is required** — it is a new table carrying `tenantId` and gets no policy from the migration.
- **A partner's price list is readable by any doctor at a partnered hospital.** That is deliberate — they cannot price a referral otherwise — but it is the first cross-tenant *read* of a non-PHI table, and the lab cannot see who looked. A partnership is the consent; there is nothing finer-grained.
- **Nothing reconciles the payable against the lab's own invoice.** The two live in two tenants and could drift if the lab voids or amends its invoice — nothing propagates that, so a hospital could settle a bill the lab no longer claims. The lab's invoice remains authoritative and both screens say so.
- Referral billing has **never run against a live database**. The arithmetic and the handshake are unit-tested and all three projects typecheck, but nothing has raised the two invoices in the two tenants and compared them. The `referral_billing` migration is **hand-written** like the thirteen before it; `npm run db:rls` is *not* needed, since it creates one type and four columns on tables that already carry policies.
- **A partnership whose mode the other lab has withdrawn cannot be ordered through, and only the sending hospital's administrator can clear it.** The list says so and names the fix, but nothing notifies them — a lab that turns off `ORIGIN_PAYS` on a Tuesday is discovered by a doctor on Wednesday.
- **Under `PATIENT_PAYS` a patient who never turns up leaves a referral open indefinitely**, and the invoice raised at accession sits outstanding against them. Nothing expires either. This makes the existing "nothing expires a referral" gap commoner rather than new.
- Nothing expires a lab referral. One sent to a partner the patient never visits sits in that queue indefinitely; declining is manual, as it is for prescriptions.
- The `sendout_collection` migration is **hand-written** like the seventeen before it and adds three columns to tables that already carry policies, so `npm run db:rls` is *not* needed. Send-out collection has **never run against a live database**: nothing has drawn a tube at one tenant, dispatched it, and watched it accession as COLLECTED at another.
- **Nothing reconciles a dispatched tube against its arrival.** The sending hospital records that it went; the partner records that it was accessioned; nothing notices a specimen dispatched three days ago that never arrived. A courier manifest and an ageing send-out list are the answer and neither exists.
- **Nothing retries a failed report automatically, and nothing tells the referring hospital that one is stuck.** The transmission is best-effort by design — a network problem at their end must not undo an authorisation this laboratory has committed to — and the failure is now visible on the row, logged, and resendable by hand. What is absent is a queue: a report that failed at 4pm on a Friday waits for a technician to open the completed tab and notice the red line. The sending hospital sees only an order still in progress, which is also what a slow laboratory looks like.
- **A report that failed to transmit is found by looking, not by being told.** The worklist's completed tab is the only place `reportedBack === false` appears, and nothing filters to it — a laboratory doing forty referrals a month has to scan the list. A "not reported back" segment is the obvious next step and is absent rather than half-built.
- **Nothing records a partner's agreed statement cadence.** Somebody has to remember which laboratory is on which — the period resets to this month every time the screen opens, and a ten-daily or fortnightly cycle is now two taps on the calendar rather than a chip, so the remembering matters slightly more than it did. Storing it needs a per-referring-hospital row on the *laboratory's* side, which does not exist: the lab knows a sender only through its referrals, and `LabPartner` lives in the sending hospital's scope. That is the natural next feature and it is a model rather than a field.
- **A preset computes "today" from the client's clock.** The server resolves the period in the hospital's timezone, and `This month` is sent as an absent period so it is resolved there — but `Last month` and `Last 7 days` name two dates worked out on the device. Those agree for anybody in their own clinic and can be a day out for anybody who is not. Mitigated rather than fixed: the dates are always visible and editable, so the error is one a person can see and correct. Asking the server what "the last seven days" is before drawing the chip would remove it and costs a round trip on every screen open.
- **The phone's calendar is hand-drawn and has never rendered on hardware.** Seven columns of `View`s, Monday-first, with the month arithmetic unit-checked against every month of three years — but nothing has looked at it on a real screen, and the two faults this project has found in hand-drawn layout (a name printed through a date of birth, a table starting every column at the left margin) were both invisible to types and to tests. Watch the first one for the things only a screen shows: whether a cell is large enough for a thumb at the edges of the grid, and whether the calendar opening pushes the list it sits above off-screen.
- **Statements have never run against a live database.** The period arithmetic and the grouping are unit-tested, a page has been rendered and read, and all three projects typecheck — but nothing has grouped real invoices across a real month boundary in a non-UTC timezone, which is the exact case the anchor exists for. No migration is involved: a statement is derived from invoices that already exist, so `npm run db:rls` is not needed and nothing has to be backfilled.
- **A statement covers whatever is in the month, including invoices raised in error.** There is no way to exclude a line from one, because the way to exclude it is to void the invoice, and lab invoices are voided only through cancelling the order — which refuses once a sample has been collected. So a charge raised against the wrong hospital appears on their statement until somebody credits it, and the credit shows as a separate figure rather than removing the line.
- **Nothing reconciles a statement against what the other party recorded.** Both sides now group the same month, and if they disagree — because the laboratory voided an invoice the notice was already written for — nothing says so. The laboratory's invoices remain authoritative and both screens say so; a comparison would need one tenant to read the other's totals, which is a cross-tenant read this has deliberately not grown.
- **A returned attachment doubles the bytes**, once in each tenant, and there is no cap on the total a referral may carry back. A partner attaching a 4 MB scan to every histopathology report grows both databases at the same rate. The per-file limit still applies at upload, so the failure mode is gradual rather than sudden; the number to watch is the same backup window attachments were always measured against, now doubled for referred work.
- **The returned file names no laboratory on the row itself.** `uploadedById` is null, deliberately, and there is no `sourceLabName` column — the order carries `routedToTenantId` and the routing trail names the partner, so the context is one level up rather than on the attachment. Adding the column is the right fix if a hospital ever files reports from two partners against one order, which nothing currently allows.
- **Attachments crossing tenants has never run against a live database**, and it is the first `BYTEA` to be written into another hospital's scope. The rules are unit-tested and all three projects typecheck. Watch the first one for the thing a unit test cannot see: whether `lab_attachment_data` accepts an insert under the *sending* tenant's RLS policy inside `forTenant`, which is the same class of failure provisioning hit on its first live run.
- **A report authorised before this change carries no files.** The copy happens on the return leg, so referrals already reported keep the values they returned and gain nothing — deliberately, since the alternative is reaching into another hospital's completed records. Re-sending is refused once `resultedAt` is set, so the only route for an old one is a new order.
- An outpatient's report cannot be re-issued after amendment: `recordResult` refuses once the order is VERIFIED, so a correction is a whole new order. Correct — a reissued report that silently replaces one a clinician has already acted on is worse — but it means no amendment trail links the two.
- Imaging stores no images. A radiologist's *report* can be attached as a PDF or a Word document, but the study itself cannot: a radiograph a clinician cannot window, zoom or measure is a picture of a result rather than the result, and that needs a viewer and a DICOM story rather than a file column. `attachment-rules.ts` refuses image types outright, so the gap stays visibly open instead of looking closed.
- Lab attachments have **never run against a live database**, and they are the first `BYTEA` in this system. The rules are unit-tested and all three projects typecheck, but nothing has stored or served a real file. Watch the first upload for the two things a unit test cannot see: whether a multipart request survives whatever sits in front of the API, and whether `lab_attachment_data` actually picked up its RLS policy.
- Attachments live in Postgres rather than object storage. Deliberate for a deployment that is one API against one database — one backup, one restore, one set of policies — and the number to watch is the backup window. A hospital attaching a 4 MB scan to every histopathology report adds a few gigabytes a year, which is fine; one attaching whole-slide images would not be. The swap point is `LabAttachmentsService`, which is the only thing that touches the bytes.
- Nothing scans an uploaded file for malware. The type is validated by content and served with `nosniff`, which stops it executing in the browser; it does not stop a Word document with a macro being opened by whoever downloads it. A deployment taking files from outside the organisation wants a scanner in front of this.
- The suggested quantity **counted doses rather than units for six phases** — `timesPerDay × days`, so "2 tablets, three times daily, 5 days" suggested 15 where the patient needs 30. Fixed; see "The quantity fills itself in" above. What remains is that a dosage expressed as a strength still produces no unit total, which is deliberate and is now said on screen rather than left as a blank box.
- Rows written before `quantityPrescribed` existed still fall back to the inferred course, so an old prescription with an unreadable duration still needs the pharmacist to close it by hand. Correct, and worth knowing before somebody reports it as the same bug. That fallback deliberately keeps the old dose-count reading where the dosage cannot be read as units — reinterpreting historic prescriptions under today's rule is the `medicineName`-as-FK trap.
- **`access-matrix.spec.ts` had never actually run in CI**, because importing `UsersController` drags in `@node-rs/argon2` and its native binding failed to load. The day it ran it reported four controllers it had never checked — `TaxRatesController`, `PharmacyTillController`, `PharmacyPartnersController`, `SignupController` — and a stale assertion claiming exactly four `@Public()` routes when signup has been the fifth since it was written. Nothing was actually wrong with the roles; the point is that a test nobody can run asserts nothing, and this is the repo's most load-bearing test. Keep the binding working.
- Letterhead and PDF printing have **never run against a live database**. The renderer is unit-tested against fixtures and produces real PDFs, but the letterhead columns and `Doctor.qualifications` are unverified against real rows, and the `letterhead` migration is **hand-written** like the seven before it. `npm run db:rls` is *not* needed for it — these are columns on tables that already carry policies.
- The logo is a base64 column with a ~200KB cap. That is a deliberate trade against object storage and it does not scale to anything else — the moment a second binary needs storing (scans, referral letters, consent forms, PLAN.md 8.5), this pattern must not be copied.
- Observation orders and escalations have **never run against a live database**. The frequency arithmetic is unit-tested and all three projects typecheck, but `observation_orders` and `observation_escalations` are unverified against real rows, and the `observation_orders` migration is **hand-written** like the six before it. Check it with `prisma migrate diff` and run `npm run db:rls` afterwards — both tables need the generic tenant policy.
- **No early warning score.** Individual readings are flagged against age-banded reference ranges, and nothing aggregates them: a patient with six mildly abnormal parameters scores nothing while one with a single bad number is flagged. NEWS2 is the standard answer and needs two fields this model lacks — level of consciousness (ACVPU) and whether the patient is on oxygen — plus a scoring table that has to be exactly right. Deliberately absent rather than approximated.
- Nothing escalates an escalation. One raised at 3am with no response sits open indefinitely; the ward board shows the count and nobody is told.
- An observation order belongs to an admission, so an outpatient has no frequency — correct, and it means a clinic cannot say "recheck that BP in 20 minutes" anywhere.
- Ward requests have **never run against a live database**. The rules are unit-tested and all three projects typecheck, but `supply_requests` and `medication_requests` are unverified against real rows, and the `ward_requests` migration is **hand-written** like the five before it. Check it with `prisma migrate diff` before applying it to anything holding data, and run `npm run db:rls` afterwards — both tables need the generic tenant policy and do not get it from the migration.
- Nothing notifies anybody of a ward request. Both queues auto-refresh every 15 seconds while open, so a pharmacist or doctor with the screen up sees it within a quarter minute — and one who does not have it open learns nothing until they look. Push exists (`notification-payload.ts`) and this does not use it.
- Nothing expires or escalates a request. One raised at 3am that nobody answers sits in the queue indefinitely, and there is no "still waiting after an hour" anywhere.
- A supply request records that the pharmacy answered, and nothing links it to the dispense that actually moved the stock. Deliberate for now — the alternative was a second stock ledger — but it means "what did we send against that request" is answered by looking at both screens.
- Cross-tenant prescribing has **never run against a live database**. The rules are unit-tested and all three projects typecheck, but the referral write entering another tenant's scope, and the RLS policy on the three new tables, are unverified. Given that every previous first live run found a bug no unit test could see, assume this has one.
- The `prescription_routing` migration is **hand-written** like the three before it. Check it with `prisma migrate diff --from-schema-datasource ... --to-schema-datamodel ...` after applying, and run `npm run db:rls` — the new tables need the generic policy and do not get it from the migration.
- A referral is one-way. The sending hospital never learns whether it was dispensed or declined, because the reverse would mean the receiving tenant writing into theirs.
- Nothing expires a referral. One sent to a pharmacy the patient never visits sits in that queue indefinitely; declining is manual.

- Provisioning has now run against a live database, and it failed the first time — the fourth bug RLS has produced that no unit test could see. `unscoped` connects as `hms_app`, which is subject to RLS; `tenants` is a global model with no policy so the hospital was created, and `users` has one, so the first administrator was refused and the whole transaction rolled back. Fixed by entering the new tenant's scope inside the transaction before writing its first user; `provisioning.spec.ts` pins the ordering. The lesson generalises: `tenant-coverage.spec.ts` checks that models carry policies and nothing checks that a caller establishes scope.
- The subscription guard and a real hospital hitting a real read-only refusal are still **unverified against a live database**.
- Applying RLS for the first time broke login completely, and the cause is worth remembering. `app_login_lookup` and `app_user_tenant` are SECURITY DEFINER and the file said they "run as the owner and see past RLS" — true only while the owner was a superuser. Moving ownership to a normal role, which is itself correct, subjected them to `users`' FORCE policy: both returned zero rows, nobody could sign in, and every authenticated request failed in `JwtStrategy`. They now belong to `hms_definer`, a NOLOGIN role named in one `FOR SELECT` policy on `users` — not a BYPASSRLS role, which would exempt it from every table to solve a problem about one. The RLS script now **proves login still works** against a tenant and user it creates and removes; every other check in that file proves isolation holds, and none proved the one sanctioned hole through it was still open.
- **`pg_has_role(…, 'MEMBER')` is not the question `ALTER … OWNER TO` asks, and the guard written to prevent this exact error was built on it.** Handing a function to `hms_definer` needs the connecting role to be able to **SET ROLE** to it, which is strictly stronger than membership. On a freshly provisioned database `hms_owner` creates the role itself and PostgreSQL then reports `pg_has_role(current_user,'hms_definer','MEMBER')` as **true** while refusing `SET ROLE` — so the guard skipped its own grant and the failure arrived several statements later as `must be able to SET ROLE "hms_definer"`, which names no fix and reads as a problem with the connection. The comment directly above that check *predicted that message* and the check underneath did not prevent it: a guard written from a reasoned-about model of the server rather than from the server, which is the same lesson the live run taught about framework ordering. The test is now the operation — `SET LOCAL ROLE` inside a subtransaction, so the attempt is free and authoritative on every version — and the grant is plain, **not** `WITH ADMIN OPTION`, because creating a role makes you its grantor and Postgres refuses to grant the admin option back to a grantor, which turned the ordinary fresh install into a hard failure the first time this was repaired. Measured against a real PostgreSQL 18.4 across four states (role absent; pre-created by a superuser; granted with admin option; granted `WITH SET FALSE`) and for repeat runs in one database and in a second database in the same cluster, because roles are cluster-level and the second database is where a naive fix looks idempotent and is not. Where the role was created by somebody else there is nothing the script can do from inside, so it now **names the one superuser command** instead of failing with a bare error: `GRANT hms_definer TO "<owner>";`.
- The `subscriptions_and_signup` migration is **hand-written**, like the pharmacy one. Check it with `prisma migrate diff` before applying it to anything holding data, and run `npm run db:rls` afterwards — `tenant_applications` needs the inverted policy and does not get it from the migration.
- Nothing emails anybody. Approval shows a temporary password once in the console and the vendor conveys it out of band. A one-time setup link would be better and needs delivery infrastructure that does not exist.
- Nothing expires a subscription on a schedule. The date is checked per request, which is correct, but no job warns the vendor that ten hospitals lapse next week — they have to look.
- A platform account can still provision and suspend on its own authority. Two-person approval is modelled for break-glass (`createdById` differing from `platformUserId`) and is not enforced anywhere, including here.

- Pharmacy billing has **never run against a live database**. The arithmetic is unit-tested and both clients typecheck, but `chargeSale` appending to an open hospital invoice in COMBINED mode, and the nullable `Invoice.patientId` path for a walk-in, are unverified against real rows. Given that the last live run found three bugs no unit test could see, assume this has one.
- The `pharmacy_billing` migration is **hand-written**, because the machine it was authored on could not download the Prisma schema engine. Check it with `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` before applying it to anything holding data.
- A pharmacy invoice cannot be voided by design, and there is no credit-note UI on the pharmacy path either — a sale raised entirely in error is refunded to zero and then sits at zero rather than closing. The `cancelCharge` credit exists in `BillingService` and simply has no pharmacy caller yet.
- Nothing reconciles a till. There is no "cash counted at close of day" against `Payment` rows for the pharmacy, which is the first thing a real shop wants.
- Margin is reported from `StockBatch.costPrice`, which is optional and will be null on every batch received before this change. A margin figure over partly-costed stock is not wrong so much as unanswerable, and nothing on screen says which.

- The backend has run against a real Postgres; **neither client has.** The web app has never rendered against a live API, mobile has never run on hardware, and `docker compose` + `prisma migrate` remain unexercised — the live run used a hand-built database and a WASM Prisma client to work around a blocked binary download. Both clients are still the largest unknown.
- The login throttle buckets on IP + email, so password spraying across many accounts is limited only by the general 120/min ceiling. A per-IP failure counter is the missing piece.
- **Nothing tells somebody their address is at two hospitals until they have failed once.** That is the deliberate trade — the alternative leaks it — but the practical cost is a person who types a correct password, is refused, and only then sees a field explaining why. A remembered choice or a per-hospital subdomain would remove the failure entirely and neither exists.
- **The hospital code has to be obtained out of band.** It is on the clinic settings screen of the hospital you already have an account at, which is no help to somebody who cannot sign in to either. In practice they ask an administrator; the vendor's approval screen shows it once at provisioning and the platform console can read it back.
- **A failed sign-in still counts towards the lockout when the address was ambiguous.** It does not: `!user` returns before `failedLoginAttempts` is touched, so nothing is incremented against either account. Worth stating because the opposite would be worse — an attacker could lock out an account at hospital A by failing against an address that also exists at hospital B.
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
