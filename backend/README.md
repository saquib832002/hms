# HMS Backend

NestJS + Prisma API serving both the web and mobile clients. See [`../PLAN.md`](../PLAN.md) for phasing and [`../docs/technical-design.md`](../docs/technical-design.md) for the design.

**Phase 0 (foundation) complete.** Auth, RBAC, audit logging, PHI-safe error handling, rate limiting.

**All phases complete.** Receptionist → doctor loop, mobile support, the inpatient surface, pharmacy, billing, and administration.

**Phase 4 touches existing data** — see [`prisma/MIGRATION-PHASE-4.md`](prisma/MIGRATION-PHASE-4.md) before migrating a database with prescriptions in it.

## API

| Method | Path | Roles |
|---|---|---|
| POST | `/auth/login` `/auth/refresh` `/auth/logout` | public |
| GET | `/auth/me` | any authenticated |
| GET | `/patients` `/patients/:id` | all staff (**body differs per role**) |
| POST/PATCH | `/patients` `/patients/:id` | admin, reception |
| GET | `/patients/duplicates` | admin, reception |
| GET | `/doctors` `/doctors/:id` | all staff |
| GET | `/doctors/:id/availability?date=` | admin, reception, doctor |
| GET | `/appointments?date=&doctorId=&status=` | admin, reception, doctor, nurse |
| POST/PATCH | `/appointments` `/appointments/:id` | admin, reception |
| PATCH | `/appointments/:id/status` | admin, reception, doctor |
| GET | `/me/queue?date=` | doctor |
| GET/POST | `/patients/:id/records` | read: doctor, nurse · write: **doctor only** |
| POST | `/prescriptions` | doctor |
| GET | `/prescriptions/:id` | doctor, nurse, pharmacist |
| GET | `/prescriptions/:id/print` | doctor, reception, pharmacist |
| PATCH | `/prescriptions/:id/cancel` | **doctor only** |
| GET | `/patients/:id/prescriptions` | doctor, nurse, pharmacist |
| GET | `/wards` | all clinical + reception |
| GET | `/wards/:id/board` | **nurse, doctor only** — names patients |
| POST | `/admissions` | admin, nurse, doctor |
| GET | `/admissions/:id` | nurse, doctor |
| PATCH | `/admissions/:id/transfer` `/discharge` | admin, nurse, doctor — writes only |
| POST | `/vitals` | **nurse, doctor only** |
| GET | `/patients/:id/vitals` | nurse, doctor |
| GET | `/medications/round/:wardId` | **nurse, doctor only** |
| PATCH | `/medications/doses/:id` | **nurse only** |
| POST | `/admissions/:id/medication-schedule` | nurse, doctor |
| POST/DELETE | `/devices` | doctor, nurse, pharmacist |
| GET | `/patients/:id/admissions` | nurse, doctor |
| GET | `/medicines` | pharmacist, doctor, nurse, admin |
| POST/PATCH | `/medicines` `/medicines/:id` | pharmacist, admin |
| GET | `/medicines/unmapped` | pharmacist, admin |
| PATCH | `/medicines/items/:id/link` | pharmacist, admin |
| GET | `/pharmacy/queue` `/pharmacy/history` | **pharmacist only** — names patients |
| GET | `/pharmacy/inventory` | pharmacist, admin |
| GET | `/pharmacy/prescriptions/:id` | **pharmacist only** |
| POST | `/pharmacy/prescriptions/:id/dispense` | **pharmacist only** |
| POST | `/pharmacy/stock` | pharmacist, admin |
| GET | `/billing/invoices` `/billing/invoices/:id` | **billing, admin only** |
| POST | `/billing/invoices` | billing, admin |
| PATCH | `/billing/invoices/:id/void` | billing, admin |
| POST | `/billing/invoices/:id/payments` | billing, admin |
| GET | `/billing/payments` `/billing/aging` | billing, admin |
| GET/POST | `/users` | **admin only** |
| PATCH | `/users/:id` | admin only |
| POST | `/users/:id/reset-password` | admin only |
| POST | `/me/password` | any authenticated |
| GET | `/departments` | all staff |
| POST/PATCH/DELETE | `/departments` `/departments/:id` | admin only |
| PATCH | `/doctors/:id` | admin only |
| GET | `/admin/dashboard` `/admin/reports/*` | admin only |
| GET | `/audit` | admin |

Rows marked **only** are ones where a role was deliberately removed. `access-matrix.spec.ts` asserts this table rather than trusting it.

### Business rules enforced here, not in the UI

- **No double-booking.** Unique constraint on `(doctorId, scheduledAt)`; a clash returns 409.
- **Status only moves forward.** `SCHEDULED → CHECKED_IN → IN_PROGRESS → COMPLETED`; `CANCELLED`/`NO_SHOW` are terminal. Reception checks in and marks no-shows; only a doctor may start or complete a consultation.
- **Clinical writes require a clinical relationship.** A doctor can only write a record or prescription for a patient they are seeing *today*.
- **A dispensed prescription is immutable.** Cancelling one returns 409.
- **A bed holds one patient; a patient occupies one bed.** Enforced by unique indexes on `Admission.currentBedId` and `currentPatientId`, not by an application check — two nurses admitting from different terminals in the same second both pass any check we could write.
- **A recorded dose cannot be re-recorded.** Marking a GIVEN dose as MISSED would rewrite the record of a medicine a patient actually received.
- **Anything other than "given" needs a reason.** At a handover, "not given" without a why is close to useless.
- **Observations and doses are idempotent** by a client-generated `clientRef`. The mobile app retries blindly from its offline queue; the server dedupes.
- **Expired stock is never dispensed.** Not deprioritised — excluded. Allocation is first-expired-first-out, so short-dated stock rotates instead of dying on the shelf.
- **A severe or life-threatening allergy conflict blocks dispensing** unless the pharmacist overrides with a written reason, which is stored on the dispense event and shown in history. Not a hard refusal: a system that cannot express "we discussed it and went ahead" gets worked around invisibly.
- **The prescribed text is never rewritten.** `medicineName` is the record; `medicineId` is an added link. A catalogue rename cannot alter what a doctor wrote.
- **Currency never touches a float.** Postgres holds `Decimal(10,2)`; arithmetic happens in integer minor units; the API sends and receives strings. `0.1 + 0.2` is not `0.3`, and across a few thousand payments that becomes a reconciliation dispute nobody can explain.
- **Overpayment is rejected, not absorbed.** A credit balance needs refunds and credit notes to exist; swallowing the excess loses the patient's money with no record of where it went.
- **Invoices are voided, never deleted** — and an invoice with payments against it cannot be voided at all, because that would orphan money that was actually received.
- **Invoice lines are typed by billing, never generated from clinical data.** A line reading "Amoxicillin 500mg × 21" would hand billing a medication history, routing PHI past the response shaping that exists to keep it away from them.
- **An admin cannot lock everyone out.** No self-demotion, no self-deactivation, and the last active administrator cannot be demoted or switched off. `account-rules.spec.ts` covers each branch.
- **An admin has no clinical read endpoint.** Not records, observations, the drug chart, the ward board, or the dispensing queue. Bed-management *writes* remain, because that is how a mis-admission gets corrected, and every one is audited. Reports are aggregates only.
- **Deactivating a user revokes their sessions immediately.** Otherwise "deactivate" would be a suggestion for up to seven days.
- **Admin-set passwords must be replaced at first login.** A password two people know is one too many for a credential that reads patient records.
- **Doctors see their own appointments.** A doctor requesting another doctor's list gets 403; another doctor's appointment by id returns 404, not 403 — confirming it exists already reveals the patient saw someone else.

---

## Running it

```bash
# 1. Postgres
docker compose up -d              # from the repo root

# 2. Dependencies
cd backend
npm install

# 3. Database
npx prisma migrate dev --name init
npm run seed                      # dummy data only

# 4. API
npm run start:dev                 # http://localhost:3000/api/v1
```

`.env` is committed with development-only placeholder values. `validateEnv` refuses to boot in production if the JWT secrets still contain `dev-only`.

---

## Verifying Phase 0

```bash
curl http://localhost:3000/api/v1/health

# Log in as each seeded role — password for all of them is ChangeMe123!
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"doctor@demo.test","password":"ChangeMe123!"}'
```

The check that matters — **the same endpoint returns different fields to different roles:**

```bash
DOC=$(curl -s -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"doctor@demo.test","password":"ChangeMe123!"}' | jq -r .accessToken)
REC=$(curl -s -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"reception@demo.test","password":"ChangeMe123!"}' | jq -r .accessToken)

curl -s localhost:3000/api/v1/patients/1 -H "Authorization: Bearer $DOC" | jq
# → includes bloodGroup and allergies

curl -s localhost:3000/api/v1/patients/1 -H "Authorization: Bearer $REC" | jq
# → no bloodGroup, no allergies. Not hidden — absent.
```

Then confirm every one of those calls landed in the audit trail:

```bash
ADMIN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@demo.test","password":"ChangeMe123!"}' | jq -r .accessToken)
curl -s localhost:3000/api/v1/audit -H "Authorization: Bearer $ADMIN" | jq '.data[:5]'
```

Failures are logged too — try a patient-creation call as a doctor (403) and it will appear with `outcome: FAILURE`.

That last line was true in intent and false in fact until a live run checked it. Worth re-running as a real assertion rather than reading it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/audit -H "Authorization: Bearer $DOC"   # 403
curl -s localhost:3000/api/v1/audit -H "Authorization: Bearer $ADMIN" | jq '[.data[]|select(.outcome=="FAILURE")]|length'
```

A zero there means denials are being dropped, whatever the code appears to say.

---

## Seeded accounts

Password for all of them: `ChangeMe123!`

| Role | Email |
|---|---|
| ADMIN | `admin@demo.test` |
| DOCTOR | `doctor@demo.test`, `doctor2@demo.test`, `doctor3@demo.test` |
| NURSE | `nurse@demo.test` |
| RECEPTIONIST | `reception@demo.test` |
| PHARMACIST | `pharmacy@demo.test` |
| BILLING_STAFF | `billing@demo.test` |

Patient names are deliberately absurd (`Testpatient Alpha`, `Demopatient Bravo`). If seeded data ever starts looking like real patient data, that is a bug — realistic fakes get mistaken for the real thing.

---

## Layout

```
src/
├── common/          decorators, guards, interceptors, filters, middleware, hospital-time
├── config/          env loading + boot-time validation
├── prisma/          PrismaService
├── auth/            login, refresh rotation, JWT strategy
├── audit/           audit writer + admin query endpoint
├── patients/        role-shaped responses
├── doctors/         directory + slot availability
├── appointments/    booking + the status machine
├── medical-records/
├── prescriptions/   issuing, cancelling, server-rendered print
├── me/              aggregate queue endpoint
├── wards/           ward board
├── admissions/      admit, transfer, discharge
├── vitals/          observations + reference ranges
├── medications/     drug chart, rounds, frequency parsing
├── medicines/       drug catalogue + free-text mapping
├── pharmacy/        dispensing, FEFO stock, class-aware allergy checks
├── billing/         invoices, payments, aging, integer-minor-unit money
├── users/           staff accounts, account safety rules, password changes
├── departments/
├── admin/           dashboard and reports — aggregates only, no patient rows
├── notifications/   push, with a hard no-PHI rule
└── health/
```

Run the tests with `npm test` — 348 of them, no database required. The ones worth knowing about:

- `common/guards/access-matrix.spec.ts` reads the `@Roles()` decorators off every controller and asserts the whole role × endpoint matrix. It fails if anyone adds an endpoint without deciding who may call it.
- `common/guards/endpoint-coverage.spec.ts` greps `web/` and `mobile/` for a caller of every route. Phase 3 shipped admit, discharge and medication-scheduling endpoints that were correct, tested, and reachable by no client at all — this is the test that would have caught it. Endpoints with no caller must be listed with a reason.
- `patients/dto/patient-response.spec.ts` asserts on the *absence* of clinical fields for non-clinical roles.
- `medications/dose-frequency.spec.ts` asserts the parser **refuses** to schedule anything it does not confidently recognise, and never schedules PRN medicine.
- `vitals/vital-ranges.spec.ts` asserts adult ranges are not applied to children, and that a pain score of 0 is a finding rather than a blank.
- `notifications/notification-payload.spec.ts` asserts no patient-identifying text can reach a lock screen.
- `pharmacy/allergy-check.spec.ts` asserts Amoxicillin is caught against a penicillin allergy — the case the Phase 1 substring check could not see.
- `pharmacy/stock-selection.spec.ts` asserts expired stock is never dispensed even when it is all there is, and that quantity is not guessed from an unreadable course.
- `billing/money.spec.ts` asserts `"0.10" + "0.20"` is exactly `"0.30"`, that `parseFloat`-style coercion is refused rather than accepted, and that overpayment throws.
- `billing/aging.spec.ts` pins every bucket boundary, including that an invoice due later today is not overdue.
- `users/account-rules.spec.ts` covers the lockout guards — including that promoting *someone else* to admin is never blocked, since that is the way out of a last-admin situation.

- `common/filters/failure-audit.spec.ts` asserts denials are recorded, and that the interceptor holds no failure branch — the gap a live run found, pinned so it cannot return.
- `common/utils/audit-target.spec.ts` parses route paths out of the controllers and asserts every id-bearing route resolves to a target. Written from the real routes rather than a fixture, because a fixture using `params: { id }` is what hid the bug it was written for.

**Request pipeline:** `RequestContextMiddleware` → `AppThrottlerGuard` → `JwtAuthGuard` → `RolesGuard` → `AuditInterceptor` → controller → `AllExceptionsFilter`.

Read that ordering as a constraint, not a diagram. **A rejected request never reaches the interceptor** — it exits at whichever guard refused it and goes straight to the filter. That is why successes are logged in the interceptor and failures in the filter, and why an error handler in the interceptor is dead code.

---

## Three things to know before changing anything

**1. Controllers never return Prisma models.** Every patient response goes through `toPatientResponse(patient, role)`. Returning a model directly, or adding an `include:` for one role's feature, silently starts serving that data to every role. `patient-response.spec.ts` asserts on the *absence* of fields for exactly this reason.

**2. Route-level `@Roles()` is not sufficient on its own.** It answers "may this role call this endpoint". It cannot answer "may this user see this row" — that needs a query, and belongs in the service. A doctor's queue must filter by their own `doctorId`.

**3. Audit is split across an interceptor and the exception filter, and neither placement is arbitrary.** Middleware runs before guards, so it cannot see who the caller was or whether they were allowed through — hence an interceptor, which deviates from the wording in `CLAUDE.md` while keeping the intent (one place, applied globally). But guards run before interceptors too, so a *denied* request never reaches the interceptor either. Successes are recorded in `AuditInterceptor`, failures in `AllExceptionsFilter`. Do not "tidy" them back together; one half of the pipeline cannot see the other's cases.

---

## One thing the migration needs by hand

`Admission` carries `currentBedId` and `currentPatientId` — nullable mirrors of `bedId`/`patientId`, nulled on discharge, each with a unique index. That is what guarantees one live admission per bed.

The textbook alternative is a partial unique index:

```sql
CREATE UNIQUE INDEX admissions_one_per_bed
  ON admissions (bed_id) WHERE discharged_at IS NULL;
```

Prisma cannot express that in `schema.prisma`, and `@@unique([bedId, dischargedAt])` would not work: Postgres treats NULLs as distinct, so it would happily allow ten live admissions in one bed. The nullable-mirror approach gets the same guarantee using only what Prisma supports. If you later add the partial index by hand in a migration, the mirror columns become redundant and can go.

## Known follow-ups

- `prisma migrate` prints a deprecation warning about `package.json#prisma`. Harmless on Prisma 6; it moves to `prisma.config.ts` when upgrading to Prisma 7 — note that doing so stops `.env` being auto-loaded, so that upgrade needs care.
- Postgres RLS policies (defence in depth behind the API) are Phase 1.
- `AuditService.record()` is fire-and-forget. Fine locally; belongs behind a real queue before production.
- The login throttle buckets on IP + email. Correct for staff behind one hospital NAT, but it means an attacker spraying one password across many accounts is only limited by the general 120/min ceiling. Password spraying wants a separate per-IP *failure* counter.
