# ADR-001 — Multi-tenancy: serving many hospitals from one system

**Status:** Accepted and implemented (backend). Verified against PostgreSQL 14.
**Date:** 2026-08-21
**Supersedes:** nothing. **Depends on:** the RLS commitment in `CLAUDE.md` (Phase 1, now applied)

**Decisions taken:** users are **per-hospital** (`@@unique([tenantId, email])`);
the medicine catalogue is **copied per tenant**; **one database**, with
connection resolution kept indirect so database-per-tenant stays open.

**Not yet done:** the HTTP surface has not been exercised end to end — see
"What was verified" at the end.

---

## Context

The system today serves one hospital. The company wants to sell it to many, with
each hospital's data segregated from every other's.

This is not a feature like billing or pharmacy. Those fail visibly — a wrong
total, a missing dose. Tenancy fails **invisibly and catastrophically**: a single
forgotten `WHERE tenantId = ?` returns another hospital's patient list, and
nothing in the response looks wrong. There is no user who notices.

That risk profile should decide the design, and it is sharpened by this
project's own history. Three of the worst defects found so far — unreachable
failure auditing, the per-IP login throttle, blank audit targets on nested routes
— shared one shape: **the code read correctly and the runtime disagreed.** All
three survived a full unit suite. A tenancy design that depends on 133 query
call sites each remembering a filter is that same bet, made 133 times, where
losing once means a HIPAA breach notification.

So the question is not "how do we scope queries by hospital". It is "what
happens the day someone forgets".

---

## Decision

**Shared database, shared schema, `tenantId` column on every tenant-owned table,
with Postgres Row-Level Security as the enforcing boundary — not the application.**

Application-level scoping is still written; it is what makes queries fast and
intentions readable. But it is *not* what makes them safe. The database refuses
to return rows that do not belong to the caller's hospital, so a forgotten filter
yields **zero rows instead of another hospital's records**.

This is the reason Postgres was chosen over MySQL in the first place.
`CLAUDE.md`:

> Rationale: native Row-Level Security, JSONB, stricter constraints…

and, still open in Known Issues since Phase 1:

> Postgres RLS policies (defence in depth behind the API) not yet applied

Multi-tenancy is what that decision was for. This ADR spends it.

---

## Why not the alternatives

**Database per tenant.** Strongest isolation, and the easiest story in a
procurement review: one hospital, one database, `DROP DATABASE` on offboarding.
Rejected as the default because migrations must run N times and partially fail
across a fleet, connection pools multiply, and cross-tenant platform reporting
becomes a fan-out. Kept as an *option* — see "Keeping the door open".

**Schema per tenant.** Looks like a compromise, behaves like the worst of both:
still one database to exhaust, still N migrations, and Prisma has no first-class
support for switching schemas per request. Rejected.

**Application-only filtering, no RLS.** The common choice, and the one this
codebase is least entitled to make. It requires 133 call sites across 20 services
to be correct forever, including in code written by people who have not read this
document. Rejected as the *sole* mechanism; it remains as the first layer.

---

## What "tenant" means

A **Tenant is one hospital organisation** — the entity that signs the contract
and the BAA. Not a site or a building: a hospital group with three campuses
sharing one patient index is one tenant, because a patient treated at one campus
must be visible at another. Multi-site becomes a `Site`/`Facility` dimension
*inside* a tenant, not a second tenant. Getting this backwards is expensive
later, because merging two tenants means merging two patient indexes.

---

## Model classification

All 24 models fall into three groups.

### Tenant-owned — carry `tenantId` directly (14)

`User`, `Doctor`, `Department`, `Patient`, `Ward`, `Bed`, `Medicine`,
`StockBatch`, `Invoice`, `Appointment`, `Prescription`, `Admission`,
`MedicalRecord`, `AuditLog`

These are the RLS-policy tables. `AuditLog` is in this list deliberately — see
"Platform access" for why the audit trail must be tenant-scoped.

### Tenant-derived — reachable only through a tenant-owned parent (8)

`Allergy`, `PrescriptionItem`, `Vital`, `MedicationAdministration`,
`DispenseEvent`, `DispenseLine`, `Payment`, `InvoiceItem`

These *could* rely on their parent's scoping. **Denormalise `tenantId` onto them
anyway.** Reasoning: an RLS policy on a child table cannot see the parent's
`tenant_id` without a subquery, and a subquery in a policy runs on every row
touched — a real cost on `Vital`, which grows fastest of any table here. The
denormalised column is redundant data defended by a foreign key and a check;
that is a good trade against a policy that joins.

### Global — no `tenantId` (2)

`RefreshToken`, `Device`

Both hang off `User` and are meaningless without it. A refresh token is already
a bearer secret scoped to one user; adding a tenant column to it protects
nothing that the `userId` foreign key does not already protect.

---

## What breaks the moment a second hospital exists

Four unique constraints are global today. Each becomes a cross-tenant collision:

| `schema.prisma` | Today | Effect with two hospitals | Becomes |
|---|---|---|---|
| L186 | `Department.name @unique` | Only one hospital in the world may have "Cardiology" | `@@unique([tenantId, name])` |
| L349 | `Ward.name @unique` | Only one may have "ICU" | `@@unique([tenantId, name])` |
| L526 | `Medicine.name @unique` | One shared drug catalogue, forced on everyone | `@@unique([tenantId, name])` |
| L95 | `User.email @unique` | A locum at two hospitals cannot have two accounts | see below |

These four are why "add a column" is not the whole job: the second tenant's
**seed run fails**, loudly, on `Department.name`. That is fortunate — it fails
at setup rather than leaking at runtime.

Constraints that are already safe, and why:

- `@@unique([wardId, label])` (Bed) — `wardId` is tenant-scoped, so bed labels
  are transitively scoped.
- `@@unique([medicineId, batchNumber])` (StockBatch) — same, via `medicineId`.
- `@@unique([doctorId, scheduledAt])` (Appointment) — same, via `doctorId`.
- `@@unique([prescriptionItemId, dueAt])` (MedicationAdministration) — same.
- `clientRef @unique` (Vital, MedicationAdministration) — client-generated
  UUIDs, globally unique by construction. **Leave global.** Scoping them per
  tenant would weaken the offline-replay guarantee described in `CLAUDE.md` for
  no benefit.
- `Admission.currentBedId` / `currentPatientId @unique` — the nullable-mirror
  trick that enforces one live admission per bed. Both point at tenant-scoped
  rows, so the guarantee survives unchanged.

---

## Tenant resolution: the part that must not be got wrong

**`tenantId` is read from the authenticated user's own database row. Never from
a header, a subdomain, a query parameter, or a JWT claim taken at face value.**

Anything client-supplied is a one-line cross-hospital breach: change
`X-Tenant-Id: 1` to `2` and read another hospital's patients.

The codebase is already positioned for this, by an accident of good judgement.
`JwtStrategy.validate()` re-reads the user from the database on every single
request rather than trusting token claims:

> Re-reads the user on every request rather than trusting the token claims.
> This costs one indexed primary-key lookup per request. The alternative is
> that a deactivated account, or one whose role was just downgraded, keeps its
> old access for up to the token TTL.

That lookup already returns the user row. `tenantId` comes along for free, and
it is authoritative on every request. `AuthUser` gains one field:

```ts
export interface AuthUser {
  userId: number;
  tenantId: number;   // ← from the DB row, never from the token
  email: string;
  // …
}
```

The token *may* also carry `tenantId`, but only as a cheap mismatch check —
if the claim and the row disagree, reject the session and audit it. That
disagreement means either a tenant migration mid-session or a forged token;
neither should continue.

---

## The RLS layer, as tested

The policies below were run against PostgreSQL 14 before this ADR was written.
The naive version has two failure modes that only appear at runtime, so the
hardened version is the one to ship.

### The helper — do not skip the `nullif`

```sql
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS int
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::int $$;
```

### The policy, per tenant-owned table

```sql
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON patients
  USING      (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
```

Three details, each load-bearing:

- **`FORCE`** — without it the *table owner* bypasses RLS entirely. If the app
  connects as the role that ran the migration, every policy is decorative.
- **A non-owner application role** — `hms_app`, granted only
  `SELECT/INSERT/UPDATE/DELETE`. Prisma migrations run as the owner; the API
  runs as `hms_app`.
- **`WITH CHECK` as well as `USING`** — `USING` filters reads; `WITH CHECK`
  blocks *writes* that would label a row with someone else's tenant.

### What the live test showed

| Scenario | Result |
|---|---|
| Owner role, no tenant set | **5 rows — everything.** Why the app is not the owner. |
| App role, no tenant set | 0 rows |
| App role, tenant 1, **query with no `WHERE` at all** | 2 rows — only tenant 1's |
| Same query, tenant 2 | 3 rows — only tenant 2's |
| Tenant 1 selects tenant 2's row *by primary key* | 0 rows |
| Tenant 1 `UPDATE`s tenant 2's row by id | `UPDATE 0` |
| Tenant 1 `INSERT`s a row labelled tenant 2 | `ERROR: new row violates row-level security policy` |

The third line is the whole argument: a query that forgot to filter returned the
correct tenant's rows anyway.

### Two failure modes the textbook version has

**1. The naive policy throws after a transaction commits.** With
`current_setting('app.tenant_id', true)::int` and no `nullif`, the setting is
`''` (not NULL) once a `SET LOCAL` transaction ends. Casting `''` to `int` is an
error, so the *next* query on that pooled connection dies with
`invalid input syntax for type integer: ""` instead of returning zero rows.
Fail-closed, but as a 500 on an unrelated request — miserable to debug. The
`nullif` wrapper turns it back into a clean zero-row result.

**2. `SET` instead of `SET LOCAL` leaks across requests.** Plain `SET` persists
for the life of the *connection*. On a pooled connection that means the next
request — a different user, a different hospital — inherits the previous
tenant's context. Verified: after `SET app.tenant_id = '1'` outside a
transaction, rows stayed visible indefinitely.

> **No database setting prevents this.** It is a code-review rule enforced in
> one place (`PrismaService`) and asserted by a test. Every tenant-scoped query
> runs inside an explicit transaction that begins with `SET LOCAL`.

---

## Connection layer

`PrismaService` today is twelve lines: connect, disconnect. It becomes the
single place tenancy is applied.

```ts
/**
 * Every tenant-scoped query runs inside a transaction that sets app.tenant_id.
 *
 * SET LOCAL, never SET: plain SET persists on the pooled connection and the
 * next request — different user, different hospital — inherits it. Verified
 * behaviour, not caution. See ADR-001.
 */
async forTenant<T>(tenantId: number, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return this.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
    return fn(tx);
  });
}
```

`set_config(..., true)` is the parameterisable equivalent of `SET LOCAL` — it
takes a bind parameter, where `SET LOCAL` requires a literal and would mean
string interpolation into SQL.

**Pooling caveat:** with PgBouncer in *transaction* mode this is safe precisely
because the setting is transaction-local. In *statement* mode it breaks. Session
mode works but wastes connections. Transaction mode is the target.

---

## Platform access — your company's staff

A hospital ADMIN administers one hospital. Your support engineers are a
different thing entirely and must not reuse that role.

- A **platform role living outside the tenant model**, not a `UserRole` value.
  Adding `SUPER_ADMIN` to the existing enum would silently widen every
  `@Roles(ADMIN)` decision point that uses a set comparison.
- **Break-glass, not standing access:** time-boxed, per-incident, tied to a
  ticket, expiring automatically.
- **Written to that hospital's `AuditLog`** — which is why `AuditLog` carries
  `tenantId`. A hospital must be able to answer "who from the vendor read our
  patients' records, and when". If the audit rows live outside the tenant, that
  question has no answer, and it is the first question a compliance officer asks.
- Platform *reporting* (usage, billing, uptime) reads aggregates with no patient
  rows — the same discipline already applied to hospital admin reports in
  Phase 6.

`AuditService.record()` is fire-and-forget today. Under multi-tenancy a dropped
write loses a cross-tenant access event. The queue named in Known Issues stops
being a nice-to-have.

---

## Decisions that need an answer before implementation

**1. Is a user global or per-hospital?**

*Per-hospital* (recommended to start): `@@unique([tenantId, email])`, one account
per hospital, `AuthUser.tenantId` is a scalar, nothing else changes. Correct for
employed staff, which is the overwhelming majority.

*Global identity + membership*: `User` loses `tenantId`, gains a
`UserTenant` join table; login returns a list of hospitals; every request carries
"acting as". This is materially harder — it touches auth, the JWT, the shell UI,
and every audit row — and it is the right answer for locums and visiting
consultants. **Do not build it speculatively**, but do not make it impossible:
keeping `tenantId` on `User` rather than baking it into the primary key leaves
the migration open.

**2. Is the medicine catalogue shared or per-tenant?**

Per-tenant copy, seeded from a company-maintained master, is recommended.
Formularies genuinely differ, and `drugClass` drives allergy checking — a shared
catalogue means one hospital's edit changes another hospital's safety check. Note
the trap already documented in `backend/prisma/MIGRATION-PHASE-4.md`: a
backfilled catalogue with `drugClass = OTHER` produces allergy checks that run,
report nothing, and look healthy. Copying a master per tenant multiplies that
risk by the number of tenants if the master is wrong.

**3. Does any hospital need its own database?**

Some will ask, for data-residency or procurement reasons. See below.

---

## Keeping the door open to database-per-tenant

Do not hard-code a single connection. Resolve it per tenant from a registry —
even while every tenant resolves to the same database:

```ts
getClientFor(tenantId: number): PrismaClient   // today: always the shared pool
```

With that indirection, a hospital demanding its own database becomes a routing
change and a data migration. Without it, it becomes a rewrite. The cost today is
one function.

---

## The tests that keep it honest

This repo's static tests (`access-matrix.spec.ts`, `endpoint-coverage.spec.ts`,
`audit-target.spec.ts`) each caught a real violation the day they were written.
Tenancy needs the same treatment, plus something they could not provide.

**1. Schema completeness (static).** Parse `schema.prisma`; assert every model
in the tenant-owned and tenant-derived lists has a `tenantId` field, and that
every model not in the "global" allow-list is covered. A new model then fails the
build until someone classifies it. This is the `endpoint-coverage.spec.ts`
pattern.

**2. Policy coverage (static, against the migration SQL).** Assert every
tenant-owned table has `ENABLE`, `FORCE`, and a `tenant_isolation` policy. A
table with a `tenant_id` column and no policy is worse than useless — it looks
scoped in review.

**3. Cross-tenant probe (integration, real database).** Seed two hospitals. Log
in as Hospital A. Call every route with Hospital B's ids.

> **Assert 404, not 403.** A 403 confirms the record exists, which is an
> enumeration oracle across tenants: an attacker learns Hospital B's patient id
> range by reading status codes. Non-existent and not-yours must be
> indistinguishable.

**4. Pool-leak probe (integration).** Two requests for different tenants forced
onto the same pooled connection; assert the second sees only its own rows. This
is the only test that would have caught failure mode 2 above — and note that
none of tests 1–3 would have, because all three assert properties of *code*,
and this is a property of the *runtime*. That distinction is the lesson written
into `CLAUDE.md` after the live run; it applies here with more at stake.

---

## Rollout

Each phase leaves the system working.

| # | Step | Notes |
|---|---|---|
| 1 | `Tenant` model; `tenantId` on 22 models; fix the four unique constraints | Backfill everything to tenant 1 in the same migration. Single-tenant behaviour unchanged. |
| 2 | `tenantId` on `AuthUser` via `JwtStrategy`; `PrismaService.forTenant()`; services adopt it | Still no RLS. App-level scoping only, so bugs here are visible in tests rather than silently blocked. |
| 3 | Hand-written migration: `hms_app` role, `app_current_tenant()`, policies with `FORCE` | Prisma cannot express RLS in `schema.prisma`. Precedent exists — `backend/README.md` already documents a hand-written index. |
| 4 | Tests 1–4 above; seed a second hospital | The second seed run is itself a test: it fails on `Department.name` if step 1 was incomplete. |
| 5 | Platform role, break-glass, tenant-scoped audit; `AuditService` queue | Done. Built as `PlatformUser` **outside** `UserRole`, not as a `SUPER_ADMIN` value — see below. The queue is in-process with retry and a disk spill, which is not a broker; the limits are recorded in `CLAUDE.md`. |
| 6 | Tenant-aware rate limiting | One hospital must not exhaust another's budget. Note the login throttle already buckets on IP + email; tenant is a third dimension. |

Steps 1–2 are mechanical and touch ~133 call sites. Step 3 is small and is where
the actual safety arrives. **Do not stop after step 2** — a half-done tenancy
that scopes queries in the application and reports itself finished is the
dangerous state, because it looks complete in code review.

---

## Consequences

**Accepted:**

- Per-hospital backup, restore and offboarding become row operations rather than
  `DROP DATABASE`. Offboarding in particular — "delete everything for this
  hospital" — needs a tested procedure, not an ad-hoc script. Price this before
  committing; it is the largest ongoing cost of shared-schema.
- Every tenant-scoped query runs in a transaction. Slightly more overhead,
  and an incompatibility with PgBouncer statement mode.
- One noisy hospital can affect others' performance. Mitigated by per-tenant
  rate limits, not solved by them.

**Gained:**

- One migration, one deployment, one connection pool.
- Cross-tenant platform reporting is a `GROUP BY`.
- A forgotten `WHERE` clause returns nothing instead of a breach.

**Legal, and outside this document's competence:** hosting multiple hospitals'
PHI makes the company a Business Associate — a BAA with each hospital,
BAA-covered infrastructure, and breach-notification duties with statutory
deadlines. That constrains the hosting decision and should be settled with
counsel before the first real patient record exists. `CLAUDE.md` rule 6 stands
until then: dummy data only, locally.

---

## What was verified, and what was not

Run against a real PostgreSQL 14 with both hospitals seeded (80 patients, 16
staff, one database):

| Check | Result |
|---|---|
| `patient.count()` with **no filter**, as each tenant | 40 and 40; the owner sees 80 |
| Another hospital's patient **by primary key** | `null` — invisible, so the API 404s rather than 403s |
| `update` on another hospital's row | refused |
| `insert` labelled with another hospital's id | refused by `WITH CHECK` |
| `create()` with no `tenantId` in the payload | stored with the correct tenant |
| Query on the same pooled connection after the transaction | 0 rows — the setting does not leak |
| Audit rows | stamped per hospital; a tenant reads 2 of 6, never the unattributed ones |
| Backend suite | 374 tests + 40 access-matrix, all passing |

**Not verified:** the HTTP layer. Nest could not boot in the verification
sandbox — `require('@nestjs/common')` hangs against a Windows-installed
`node_modules` on a mounted filesystem — so status codes were not exercised.
Specifically unproven: that a cross-tenant fetch surfaces as **404 rather than
403**, which is the enumeration-oracle rule. The data layer returns `null`,
which is the precondition for it, but the controller behaviour needs a run on a
real machine. This is the first thing to check after `npm run db:setup`.

Also outstanding from the rollout table: a per-tenant rate limit — which cannot
live in `AppThrottlerGuard`, because that guard is registered ahead of
`JwtAuthGuard` and has no authenticated user to read. See the comment in that
file.

`AuditService.record()` is no longer fire-and-forget — it retries and spills to
disk rather than losing rows, which mattered more once platform denials started
flowing through it. It is still an in-process queue, so a hard kill loses
milliseconds of entries and a multi-instance deployment would want a broker.

## Addendum: how step 5 was actually built

Step 5 said "platform role". It was built as a platform **principal**, and the
difference is the whole decision.

A `SUPER_ADMIN` member of `UserRole` would have been one line. It would also
have widened every `@Roles(ADMIN)` site in the codebase the moment any set
comparison saw the new value — and the new value is the most privileged one in
the system. So platform staff are a separate table (`PlatformUser`), a separate
token audience, and a separate guard.

The load-bearing detail is that `PlatformGuard` **does not set `req.user`**.
`RolesGuard` cannot admit a principal with no `UserRole`, and `TenantInterceptor`
opens no transaction for one. The separation is a property of the request shape
rather than of anyone remembering to check a flag.

Three consequences worth recording:

1. **`break_glass_grants` carries the inverse policy.** It has a `tenantId`, so
   the generic `tenantId = app_current_tenant()` would apply cleanly and be
   wrong — it would show each hospital the grants against it, from a table that
   also names every other hospital's. The predicate is
   `app_current_tenant() IS NULL`: visible only outside a hospital request.
   `PLATFORM_MODELS` exists as a third category for exactly this, because
   forcing it into "scoped" or "global" meant either the wrong policy or a
   `tenantId` column with no policy at all.

2. **Grants are re-checked per request.** Revoked beats expired, and both are
   evaluated on use rather than at issue. Checking only at grant time would make
   "revoke" mean "revoke when the access token expires".

3. **Platform actions are audited into the hospital's own log**, with
   `actorRole` null. The hospital answers "who from the vendor, when, why" from
   its own records rather than by asking the vendor for theirs.

What a grant buys is deliberately narrow: row counts, clinic settings, denial
counts. No patient rows at all. That is enough for nearly every support
question, and reading records would need a BAA conversation and per-incident
consent — so it is absent rather than half-built behind a flag.

Unproven, and the same gap as the rest of this ADR: none of it has run against
the live database yet. The inverted policy has an in-SQL self-check that inserts
a probe row and asserts both directions, which is more than the original
policies had before their first live run found three bugs.

## References

- `CLAUDE.md` — Postgres/RLS rationale; rule 2 (server-side RBAC); rule 6 (PHI hosting)
- `backend/src/auth/strategies/jwt.strategy.ts` — per-request user re-read
- `backend/src/prisma/prisma.service.ts` — the connection layer to extend
- `backend/prisma/MIGRATION-PHASE-4.md` — the `drugClass = OTHER` trap
- Live RLS verification: PostgreSQL 14, results tabulated above
