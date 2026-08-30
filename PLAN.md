# Hospital Management System — Build Plan

Companion docs: [`docs/technical-design.md`](docs/technical-design.md), [`docs/ui-design.md`](docs/ui-design.md), [`docs/role-navigation.md`](docs/role-navigation.md), [`docs/wireframes.html`](docs/wireframes.html). Architectural decisions live in [`CLAUDE.md`](CLAUDE.md).

---

## Guiding principle

Build one **complete vertical slice** before building anything wide.

The temptation with a hospital system is to model everything first — wards, inventory, insurance, labs — because it all obviously belongs. That path produces six months of schema and no working software. Instead, Phase 1 delivers a single real clinical loop that a real receptionist and a real doctor could actually use end to end. Everything after that is widening.

The loop:

```
Patient walks in
  → Receptionist registers them          (Patients)
  → Receptionist books an appointment    (Appointments)
  → Patient arrives, gets checked in     (Appointment status)
  → Doctor sees them in today's queue    (Queue)
  → Doctor records diagnosis + notes     (MedicalRecord)
  → Doctor writes a prescription         (Prescription + Items)
  → Patient leaves with a printed Rx
```

Every step of that is already modelled in `schema.prisma`. That is not a coincidence — it's why this slice is the right one.

---

## Phase 0 — Foundation ✅

**Nothing works until this does.** No UI in this phase.

| # | Task | Notes |
|---|---|---|
| 0.1 | Fix `backend/package.json` | Missing `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `rxjs`, `reflect-metadata`, `prisma`, `@prisma/client`. Add `@nestjs/config`, `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt`, `argon2`, `@nestjs/throttler`. |
| 0.2 | Delete duplicate `backend/patients/` | Move the spec files into `src/patients/`, delete the stray folder. |
| 0.3 | Move `schema.prisma` → `backend/prisma/schema.prisma` | Prisma's expected location. Currently at `backend/schema.prisma`. |
| 0.4 | Schema additions for Phase 1 | `RefreshToken`, `Allergy`, prescription dispense fields, richer `AuditLog`. See technical design §5. |
| 0.5 | First migration + seed script | Seed: 3 departments, 4 doctors, 1 of each staff role, ~40 dummy patients, ~60 appointments across a week. **Dummy data only.** |
| 0.6 | Auth module | Login, refresh, logout. JWT access + rotating refresh token. Argon2 password hashing. |
| 0.7 | `RolesGuard` + `@Roles()` decorator | Global guard, opt-out via `@Public()`. |
| 0.8 | Audit interceptor | Logs every PHI-touching request. See technical design §4. |
| 0.9 | Global exception filter | Never returns a stack trace. Never echoes patient data in an error message. |
| 0.10 | Rate limiting | Strict on `/auth/login` and patient search. |

**Exit criteria:** `docker compose up`, `npx prisma migrate dev`, `npm run seed`, `npm run start:dev` — then log in as each of the six roles via curl and get a token. A DOCTOR token can `GET /patients`; a BILLING_STAFF token gets a response with clinical fields stripped. Every one of those calls appears in `audit_logs`.

> **Do not skip 0.8.** Retrofitting audit logging after the endpoints exist is how it ends up inconsistent — which is exactly the failure mode it's meant to prevent.

---

## Phase 1 — MVP: the receptionist → doctor loop (web only) ✅

Two roles, one loop, web only. This is the phase that proves the architecture.

### Backend

| Module | Endpoints |
|---|---|
| Patients | Extend existing: search, role-shaped responses |
| Appointments | CRUD, availability check, status transitions |
| Medical Records | Create + list by patient |
| Prescriptions | Create with items, list, PDF/print |
| Doctors | Read-only list + availability |

**Business rules that must live here, not in the UI:**

- No double-booking a doctor for the same slot.
- Appointment status only moves forward: `SCHEDULED → CHECKED_IN → IN_PROGRESS → COMPLETED`. `CANCELLED`/`NO_SHOW` are terminal.
- A doctor can only write records/prescriptions for a patient they have an appointment with today.
- A prescription cannot be edited once `dispensedAt` is set.
- A receptionist's `GET /patients/:id` response contains no clinical fields *at all* — enforced by the DTO, not by the client hiding them.

### Web

Next.js + shadcn/ui, persistent sidebar, role-derived nav.

- Login → role-based redirect
- **Receptionist:** Check-in Queue, Appointments (book/reschedule/cancel), Patient Registration, Patients (demographics only)
- **Doctor:** Today's Queue, Patient detail panel, Write Record, Write Prescription
- ⌘K global patient search
- Allergy banner, always visible on the patient panel

**Exit criteria:** a person can be registered, booked, checked in, consulted, and sent home with a printed prescription — without anyone touching the database directly.

---

## Phase 2 — Doctor mobile ✅

First React Native app. Deliberately after web, because the web build settles the API shape and mobile should consume a stable contract rather than co-evolve with one.

- Expo, JWT stored in `expo-secure-store` (**not** AsyncStorage)
- Today's Queue, patient summary (read-only), write prescription, push notifications
- Aggregate endpoint `GET /me/queue` — one call per screen, not five. Cellular latency is the constraint.

**Explicitly not on mobile:** full history review, appointment management, registration.

---

## Phase 3 — Nurse ✅

The largest schema expansion. Nurse is the most mobile-critical role, so web and mobile ship together here.

New models: `Vital`, `Ward`, `Bed`, `Admission`, `MedicationAdministration`.

- Web: ward board, vitals history, medication schedule
- Mobile: bedside vitals entry, medication due list with mark-as-given

**Exit criteria:** a nurse completes a full shift — admit, observe, medicate, hand over — from a phone at the bedside.

---

## Phase 4 — Pharmacy ✅

New models: `Medicine`, `StockItem`.

**Breaking change:** `PrescriptionItem.medicineName` is free text today. It becomes a FK to `Medicine`. Doing this in Phase 4 means a data migration over Phase 1–3 prescriptions — annoying but small. Doing it in Phase 6 would not be.

- Dispense queue, dispense action (sets `dispensedAt`, decrements stock), history, low-stock alerts
- Mobile: queue + alerts only

---

## Phase 5 — Billing ✅

New model: `Payment`. `InvoiceStatus.PARTIALLY_PAID` currently has nothing recording the partial amount.

- Invoice list/create, payment recording, aging report
- Patient response shaped to billing fields only — no clinical data
- Web only

---

## Phase 6 — Admin ✅

- User management, doctor/department CRUD, dashboard KPIs, reports
- **Audit log browser** — the compliance payoff for Phase 0.8
- Mobile: read-only KPIs

**Note:** ADMIN does *not* get blanket clinical read access. If break-glass is ever needed, build it as an explicit, reason-required, loudly-audited action.

---

## Deferred — not scheduled

| Item | Trigger for scheduling it |
|---|---|
| Patient portal | A decision to let patients self-serve. Needs `UserRole.PATIENT` + `User↔Patient` link. |
| HL7 / FHIR layer | A real integration: lab system, clearinghouse, pharmacy chain, another hospital. |
| Lab orders & results | Ordering bloodwork in-app rather than on paper. |
| Insurance claims | Beyond simple invoicing. |
| Real PHI / production | **Blocks on BAA-covered hosting.** Until then, dummy data only. |
| Multi-tenancy (many hospitals) | A second hospital. Design settled in [`docs/adr-001-multi-tenancy.md`](docs/adr-001-multi-tenancy.md) — shared schema + `tenantId` + Postgres RLS. Not implemented; touches ~133 query call sites and four unique constraints. |

---

## Where the plan proved wrong

Worth recording, because the deviations were deliberate:

| Plan said | What was built | Why |
|---|---|---|
| Audit logging in *middleware* | A NestJS **interceptor** | Middleware runs before guards, so it cannot see who the caller was or whether they were allowed through. |
| `medicineName` *becomes* a FK to `Medicine` | Text kept verbatim, nullable `medicineId` **added** | A prescription is a contemporaneous record. A join would let a catalogue rename rewrite what a doctor wrote months ago. |
| Allergy checking becomes a hard block in Phase 4 | Blocks at **dispensing**, with an audited override | Blocking a prescriber mid-consultation pushes the decision onto paper where nothing sees it. The pharmacist is the second check. |
| Phase 3 "complete" | Three endpoints had no caller at all | Admit, discharge and drug-chart scheduling were correct, tested and unreachable. `endpoint-coverage.spec.ts` now fails the build on any orphan. |
| Admin is operational, not clinical | It had drifted in four places | Stated from Phase 1, first *tested* in Phase 6, which immediately found the violations. |
| Failures logged alongside successes in the interceptor | Successes in the interceptor, failures in **`AllExceptionsFilter`** | The error branch was unreachable: guards run before interceptors, so a denial never reaches one. Zero FAILURE rows in the live database against 30 SUCCESS rows. |
| Rate limiting "strict on `/auth/login`" | Strict on login **per account**, not per IP | Per-IP throttling limits the hospital — six staff on one NAT hit 429 — while leaving an attacker the full budget against a single account. |
| Audit records which record was touched | It did, except on nested clinical routes | The extractor read `params.id`; those routes declare `:patientId`. Denials on records, vitals and prescriptions logged no subject at all — the rows where "which patient" matters most. |

Note what the last two have in common with the Phase 3 orphans: all three passed every test and every reading, and were found only by running the system. Each phase was signed off on a suite that had never executed against a database.

---

## Endpoints with no way in

Found by tightening `endpoint-coverage.spec.ts` to match on `(method, path)`
structurally instead of grepping for path fragments. All had been passing
on coincidence — the old check was satisfied by the words appearing anywhere in
the client source, in any order, in any file, under any HTTP verb.

These are **missing UI, not design decisions**, which is why they are listed
here rather than buried in the spec's "intentionally uncalled" list. The test
fails if an entry in `KNOWN_GAPS` is not also written down on this page, so the
two cannot drift apart.

| Endpoint | What is missing | Why it matters |
|---|---|---|
| `PATCH /prescriptions/:id/cancel` | No way for a doctor to retract a prescription | The worst of the five. A wrong prescription can be issued and not withdrawn. `schedule-medication-sheet.tsx` already refuses to chart a cancelled prescription, so the UI reasons about a state it gives nobody a way to reach. |
| `PATCH /medicines/:id` | No way to correct a catalogue entry | This is what the `drugClass = OTHER` trap needs in order to be fixable. Allergy checks against a mis-classed medicine run, report nothing, and look healthy. |
| `POST /medicines` | No way to add a medicine | The catalogue can only be seeded. A hospital cannot stock anything new. |
| `GET /patients/:patientId/admissions` | No screen shows a past stay | Admission history was never built; the ward board only shows current occupancy. |

`PATCH /doctors/:id` was on this list and is now closed: consultation fees made
it load-bearing — a fee nobody can set is a checkout nobody can complete — so
the doctors screen gained a fee editor.

Two more endpoints have no caller and are staying that way — `GET /appointments/:id`
and `GET /prescriptions/:id` — both superseded by richer reads the clients
already use. Those are recorded in the spec, not here.

---

## Dependency order

```
Phase 0 ──► Phase 1 ──┬──► Phase 2 (doctor mobile)
                      ├──► Phase 3 (nurse)  ──► Phase 4 (pharmacy)
                      ├──► Phase 5 (billing)
                      └──► Phase 6 (admin)
```

Phases 3, 5, and 6 are independent of each other and can be reordered by whatever the hospital actually needs first. Phase 4 depends on Phase 3 only for the medication-administration link — it can start earlier if pharmacy is the priority.

---

## Risks worth naming now

| Risk | Mitigation |
|---|---|
| **Response-shaping bugs leak PHI.** The receptionist/billing restriction is enforced in DTOs — one careless `include` in a Prisma query undoes it. | Explicit per-role DTO mappers, never raw model returns. Integration tests that assert forbidden fields are absent. |
| **Free-text `medicineName`** becomes hard to migrate as prescription volume grows. | Convert in Phase 4, not later. |
| **`Decimal` handling** — Prisma `Decimal` serialises awkwardly to JSON and JS floats lose money. | Serialise as string end to end. Never `parseFloat` a currency value. |
| **Timezones.** Appointment times across DST, or staff in different zones, silently shift. | Store UTC, render in hospital-local time. Decide the hospital's timezone as config in Phase 0. |
| **Scope creep into labs/insurance** before the core loop works. | The deferred list above is a commitment, not a wishlist. |
| **Seed data that looks real.** Realistic-looking fake patient data gets mistaken for real data. | Obviously-fake names, and a loud banner in non-production builds. |
| **A green suite that has never run the system.** Two of the worst defects here were invisible to 513 passing tests, because both were properties of framework runtime ordering rather than of any function. | Run it. The backend now has; neither client has. Treat a phase as unverified until something real has exercised it. |
