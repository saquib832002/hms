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

**Note:** ADMIN does *not* get blanket clinical read access — with one
deliberate, later exception. `GET /admin/reports/consultations` returns the
patients behind a count on the owner's daily activity screen: name, time,
attendance, what was charged, whether it was paid. Nothing clinical, and the
rule in `access-matrix.spec.ts` was rewritten to say what it now is rather than
left saying something that had stopped being true. See `CLAUDE.md`, "Admin sees
attendance and money, never clinical content".

Break-glass was built — `backend/src/platform/`, an explicit, reason-required,
time-boxed and loudly-audited action, outside the tenant role model entirely.

---

## Phase 7 — Make it safe to run for real

Phases 0–6 built the clinic. This one closes the holes that only matter once
somebody depends on the system, and every item is something already half-present
in the code: an endpoint with no caller, a state the UI reasons about but cannot
reach, or a rule enforced on one client and not the other.

Nothing here is new capability. All of it is finishing what is already there.

| # | Item | Why it is in this phase and not later |
|---|---|---|
| 7.1 ✅ | **Forced password change on mobile** | Done. `PasswordGate` on mobile, above the navigator beside the idle lock. |
| 7.2 ✅ | **Refunds** | Done. `Refund` model, `POST /billing/invoices/:id/refunds`, UI on both clients. A refund reduces what the invoice *holds* and reopens the balance; the charge still stands. Voiding now keys on money held rather than on payment rows existing, so a fully refunded invoice can finally be withdrawn. **Credit notes are still absent** — there is no way to hold a balance against a future invoice, which is why overpayment is still refused rather than absorbed. |
| 7.3 ✅ | **Cancel a prescription** | Done. "Cancel & rewrite" on both clients: withdrawing one opens a new prescription pre-filled with its lines. Deliberately *not* an edit — a prescription is a contemporaneous record, and amending one in place would let the paper in the patient's hand disagree with the row in the database. Cancelling leaves the mistake and the correction both readable. |
| 7.4 ✅ | **Medicine catalogue: add and correct** | Done. Add/edit sheet on the web inventory screen, plus a mobile Stock screen that adds a medicine and receives a delivery at the shelf. Both warn, at the moment of choosing, that leaving `drugClass` on `OTHER` produces allergy checks that run and find nothing. |
| 7.5 | **Admission history screen** | `GET /patients/:patientId/admissions` has no caller. The ward board shows current occupancy only; a past stay is invisible. |
| 7.6 | **Notification triggers** | `QUEUE_WAITING`, `PRESCRIPTION_QUERY` and `CRITICAL_RESULT` are defined in `notification-payload.ts` and never fired. Only check-in notifies anybody. Either wire them or delete them — a declared alert that never arrives is worse than no alert, because people learn to trust it. |

| 7.7 | **Reverse a dispense, from a phone** | `/pharmacy/dispense-events/:p/reverse` (POST) is web-only, because the only screen it is reachable from — the dispensing history — is web-only. That is a real hole rather than a decision: "the patient cannot pay" happens at the counter, which is exactly where somebody is holding a phone. The likely entry point is the dispense confirmation itself rather than a history list, since the reversal almost always happens seconds after the handover was recorded. |

**Exit criteria:** every endpoint has a caller on every client that needs it,
`KNOWN_GAPS` and `PARITY_GAPS` are empty, and money is reversible.

---

## Phase 8 — What a clinic asks for in the first fortnight

Genuinely new work, and none of it is guesswork — each is a request a running
clinic makes almost immediately.

| # | Item | Notes |
|---|---|---|
| 8.1 | **A scheduler** | There is no background job infrastructure in the backend at all — no `@nestjs/schedule`, no cron, no queue. Everything is request-driven. This blocks 8.2 and 8.3, and it is also what would let the audit spill file alert somebody instead of waiting to be noticed. Build it first. |
| 8.2 | **Appointment reminders** | "Remind the patient the day before." Needs 8.1 plus an SMS or email transport. Note the PHI constraint the push payloads already follow: a reminder may carry a time and a clinic name, never a doctor's specialty. |
| 8.3 | **Self-service password reset** | Today a forgotten password needs an administrator, in person or on the phone. Fine for six staff, painful at thirty. Needs a mail transport and a single-use token — and the same care as login about not revealing whether an address exists. |
| 8.4 | **Report exports** | Every report is JSON on a screen. The first thing an owner asks is "can I send this to my accountant". CSV covers most of it; the finance report probably wants PDF. |
| 8.5 | **Document attachments** | `MedicalRecord.attachments` exists in the schema and is read and written by nothing — a vestigial column, not a feature. Scans, referral letters and consent forms are the actual need. This one carries the most risk in the phase: uploads mean storage, virus scanning, and a second place PHI lives. |
| 8.6 | **Global search** | `⌘K` searches patients only. Doctors, appointments and invoices are not reachable by search on either client. |
| 8.7 | **Ward → pharmacy supply request** ✅ | Built. `SupplyRequest`, raised by a nurse against a `PrescriptionItem`, answered from the pharmacist's Ward Supply queue on both clients. Marking supplied moves no stock — the medicine leaves the shelf through dispensing, so there is one ledger and one charge. |
| 8.8 | **Nurse → doctor medication request** ✅ | Built. `MedicationRequest`, free-text need plus a required clinical reason, answered from the doctor's Ward Requests queue on both clients. Closes only against a `prescriptionId` the doctor wrote through the ordinary route, or a decline with a reason that is kept. |

**8.7 and 8.8 are two requests, not one, and merging them would be the mistake.**
They read alike — "the nurse needs a medicine that is not here" — and they differ
in what is missing. One is a logistics problem with a pharmacist at the other
end; the other is a clinical decision with a prescriber at the other end. A
single "request medication" button would route half of each to the wrong person,
and the failure mode is a drug supplied that nobody prescribed.

Neither is a route by which a nurse can put a medicine on a chart. In the UK,
US and India alike, prescribing is a prescriber's act unless the nurse holds a
separate qualification the system does not model — so the verb here is **ask**,
and the answer comes back from somebody licensed to give it.

---

## Phase 9 — Integration, and only when something real needs it

Unchanged from the original deferred list, and still correctly deferred. Each
of these should wait for a concrete trigger rather than being built because it
obviously belongs — that is the failure mode the guiding principle at the top of
this page exists to prevent.

Patient portal · HL7/FHIR · Insurance claims

---

## Deferred — not scheduled

| Item | Trigger for scheduling it |
|---|---|
| Patient portal | A decision to let patients self-serve. Needs `UserRole.PATIENT` + `User↔Patient` link. |
| HL7 / FHIR layer | A real integration: an analyser, a clearinghouse, a pharmacy chain, a hospital not on this platform. Note that partner labs *on* this platform no longer need it — a referral and its result cross as rows, not as messages. |
| Insurance claims | Beyond simple invoicing. |
| Real PHI / production | **Blocks on BAA-covered hosting.** Until then, dummy data only. |

Two rows were removed from this table because they had been **built** and nobody
updated the page:

- **Multi-tenancy.** Shipped in full — `tenantId` on every patient-derived
  model, Postgres RLS policies in `backend/prisma/rls/tenant-isolation.sql`,
  `PrismaService.forTenant`, and per-hospital clinic settings. `CLAUDE.md` has
  described it correctly since it landed; this page still called it "not
  implemented", which is the kind of stale claim that makes a planning document
  worth less than no planning document.
- **Break-glass vendor access.** Phase 6's note said "if break-glass is ever
  needed, build it as an explicit, reason-required, loudly-audited action."
  That is exactly what `backend/src/platform/` is. It has never run against a
  live database and has no UI — both deliberate, both recorded under Risks.

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
| Phase 3 gave nurses a working ward | Wards and beds could only be created by the demo seed | No `POST /wards` existed at all, and provisioning made none — so every hospital from the platform had zero wards. The nurse's landing screen then spun on a loading skeleton forever, because no ward meant no board was ever requested. Reported as a slow backend. `self-provisionable.spec.ts` now asks, for each resource a hospital must create before the system works, whether a route exists to create it. |

Note what the last three have in common with the Phase 3 orphans: all of them passed every test and every reading, and were found only by running the system. Each phase was signed off on a suite that had never executed against a database.

The ward one adds a second lesson worth keeping separate. **An empty table and an
unbuilt feature render identically**, and a screen that shows a spinner for both
reports the more misleading of the two. Three resources have now been seed-only
in exactly this way — the medicine catalogue, doctor profiles, and wards — and
each was found by a customer rather than a test, because nothing was broken in
any way a reader could see.

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
| `GET /patients/:patientId/admissions` | No screen shows a past stay | Admission history was never built; the ward board only shows current occupancy. |

`POST /medicines` and `PATCH /medicines/:id` were on this list and are now
closed. The cost of the gap only became visible on a real deployment: a hospital
that did not run the demo seed had an empty catalogue, so "Receive stock"
offered an empty dropdown and the pharmacy did not work at all — with nothing on
screen explaining why. Web gained an add/edit sheet on the inventory screen;
mobile gained a Stock screen that adds a medicine and receives a delivery at the
shelf. Both warn, at the moment of choosing, that leaving `drugClass` on `OTHER`
produces allergy checks that run and find nothing.

`PATCH /doctors/:id` was on this list and is now closed: consultation fees made
it load-bearing — a fee nobody can set is a checkout nobody can complete — so
the doctors screen gained a fee editor.

## Parity gaps — one client has it, the other needs it

`endpoint-coverage.spec.ts` asked whether *a* client called a route. That is
the wrong question when two clients serve the same role, and it let a real gap
through for a whole phase: `POST /appointments/:id/invoice` was wired into the
mobile schedule screen and never into the web check-in screen, so a receptionist
working at the desk — which is most of them, most of the day — had no way to
bill a patient they had just checked in. Coverage stayed green because mobile
counted. A user reported it; no test could.

The spec now compares web and mobile separately, with `WEB_ONLY` and
`MOBILE_ONLY` for deliberate single-client routes and `PARITY_GAPS` for real
holes. A test fails if a gap here is not also written down below.

**The list is currently empty.** Two entries have been through it:

- `POST /appointments/:id/invoice` — the charge reception raises at check-in
  existed only on the phone. Closed: the web check-in screen bills from
  `CHECKED_IN` onwards.
- `POST /me/password` — a **security gap**. A member of staff created with
  `mustChangePassword = true` is forced through a change on the web by
  `PasswordGate`; mobile had no such gate and no change screen, so someone who
  only had a phone signed in with a temporary password that had been read aloud
  or written on paper, and was never asked to replace it. It stayed live
  indefinitely. Closed by `mobile/components/password-gate.tsx`, which sits
  above the navigator beside the idle lock so no deep link can pass it.

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
