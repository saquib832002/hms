# Technical Design

Backend and API design for the HMS. Assumes the decisions in [`CLAUDE.md`](../CLAUDE.md) and the phasing in [`PLAN.md`](../PLAN.md).

---

## 1. System shape

```
┌──────────────┐         ┌──────────────┐
│   Next.js    │         │  Expo / RN   │
│    (web)     │         │   (mobile)   │
└──────┬───────┘         └───────┬──────┘
       │  HTTPS + JWT            │
       └───────────┬─────────────┘
                   ▼
        ┌────────────────────────┐
        │      NestJS API        │
        │  ────────────────────  │
        │  Throttler             │  ← rate limit
        │  RequestContext MW     │  ← requestId, ip, ua
        │  JwtAuthGuard          │  ← who are you
        │  RolesGuard            │  ← may you call this
        │  AuditInterceptor      │  ← record it
        │  ValidationPipe        │  ← is the input sane
        │  ──── controllers ──── │
        │  ──── services ─────── │  ← business rules + resource scoping
        │  ──── Prisma ───────── │
        │  ExceptionFilter       │  ← never leak PHI or stack traces
        └───────────┬────────────┘
                    ▼
            ┌───────────────┐
            │ PostgreSQL 16 │
            └───────────────┘
```

Both clients speak to the same API. Neither ever reaches the database.

---

## 2. Backend module layout

```
backend/
├── prisma/
│   ├── schema.prisma          ← moved from backend/schema.prisma
│   ├── migrations/
│   └── seed.ts
└── src/
    ├── main.ts
    ├── app.module.ts
    ├── config/                ← env validation, hospital timezone
    ├── common/
    │   ├── decorators/        ← @Roles, @CurrentUser, @Public, @AuditAction
    │   ├── guards/            ← JwtAuthGuard, RolesGuard
    │   ├── interceptors/      ← AuditInterceptor
    │   ├── filters/           ← AllExceptionsFilter
    │   ├── middleware/        ← RequestContextMiddleware
    │   └── dto/               ← pagination, common responses
    ├── prisma/                ← PrismaModule, PrismaService  [exists]
    ├── auth/
    ├── users/
    ├── patients/              ← [exists, needs role-shaped DTOs]
    ├── doctors/
    ├── departments/
    ├── appointments/
    ├── medical-records/
    ├── prescriptions/
    ├── audit/
    ├── invoices/              ← Phase 5
    ├── vitals/                ← Phase 3
    ├── wards/                 ← Phase 3
    └── pharmacy/              ← Phase 4
```

Every module is the standard Nest triple — `*.module.ts`, `*.controller.ts`, `*.service.ts` — plus a `dto/` folder. Controllers do routing and shape; services hold business rules; Prisma is only ever touched from a service.

---

## 3. Auth

### Token strategy

| Token | Lifetime | Storage (web) | Storage (mobile) |
|---|---|---|---|
| Access (JWT) | 15 min | In-memory | In-memory |
| Refresh | 7 days, rotating | `httpOnly` `Secure` `SameSite=Strict` cookie | `expo-secure-store` |

Refresh tokens are **rotated on every use** and stored server-side as a hash. If a previously-used refresh token is presented again, that's a replay — revoke the entire family and force re-login.

**Never put a refresh token in `localStorage`** (XSS-readable) or, on mobile, in `AsyncStorage` (plaintext on a rooted device).

Passwords: **Argon2id**. Not bcrypt, not SHA-anything.

### Flow

```
POST /auth/login      { email, password }  → { accessToken, user }  + refresh cookie
POST /auth/refresh    (cookie / body)      → { accessToken }        + new refresh cookie
POST /auth/logout                          → revokes refresh family
GET  /auth/me                              → current user + role + permissions
```

`GET /auth/me` is what both clients call on boot to build the navigation. The nav is derived from the server's answer, never from a client-side role constant.

### JWT payload

```jsonc
{
  "sub": 42,              // userId
  "role": "DOCTOR",
  "doctorId": 7,          // present only for DOCTOR — avoids a lookup per request
  "jti": "…",
  "iat": …, "exp": …
}
```

Keep it minimal. Anything that can change mid-session (permissions, active status) must be re-checked server-side, not trusted from the token.

---

## 4. RBAC and audit

### Two distinct layers — do not conflate them

**Layer 1 — route-level (`RolesGuard`).** *May this role call this endpoint at all?*

```ts
@Roles(UserRole.DOCTOR, UserRole.NURSE)
@Get('patients/:id/records')
```

**Layer 2 — resource-level (service).** *May this specific user see this specific row?* A guard cannot answer this; it needs a query.

```ts
// A doctor sees their own appointments, not every doctor's.
async findQueue(user: AuthUser) {
  return this.prisma.appointment.findMany({
    where: { doctorId: user.doctorId, scheduledAt: todayRange() },
  });
}
```

Most real-world PHI leaks are Layer 2 failures with a perfectly correct Layer 1. Treat "which rows" as a first-class design question in every service method.

### Layer 3 — response shaping

This is the one that makes the receptionist boundary real. Same route, different response body per role:

```ts
// patients/dto/patient-response.ts
export function toPatientResponse(p: Patient, role: UserRole) {
  const base = { id, fullName, dob, gender, phone, email, address };
  switch (role) {
    case UserRole.RECEPTIONIST: return base;                       // no clinical data
    case UserRole.BILLING_STAFF: return { ...base, insurance };     // no clinical data
    case UserRole.PHARMACIST:   return { ...base, allergies, activeMedications };
    case UserRole.DOCTOR:
    case UserRole.NURSE:        return { ...base, allergies, bloodGroup, emergencyContact };
    case UserRole.ADMIN:        return base;                        // operational, not clinical
  }
}
```

**Never return a Prisma model directly from a controller.** One `include: { medicalRecords: true }` added for a doctor feature will silently start serving diagnoses to receptionists. Explicit mappers, always.

### Audit — an interceptor, not middleware

> **Refinement of an earlier decision.** `CLAUDE.md` says audit logging lives in "middleware". In NestJS, middleware runs *before* guards, so it has no authenticated user and no handler metadata — it literally cannot log *who* did *what*. The correct primitive is a global **interceptor**, which runs after guards and can see both. The intent is unchanged: one place, applied globally, not sprinkled through endpoints.

```ts
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest();
    const action = this.reflector.get(AUDIT_ACTION, ctx.getHandler())
                 ?? `${req.method} ${req.route?.path}`;
    return next.handle().pipe(
      tap({
        next:  ()  => this.write(req, action, 'SUCCESS'),
        error: (e) => this.write(req, action, 'FAILURE', e.status),
      }),
    );
  }
}
```

Log **failures too**. A receptionist repeatedly getting 403s on clinical endpoints is exactly the signal an audit trail exists to surface.

Writes go to a queue, not inline — a slow audit insert should never slow down a clinical action, and it should never fail the request it's recording.

---

## 5. Schema changes

### Needed for Phase 0–1

```prisma
model RefreshToken {
  id        Int      @id @default(autoincrement())
  user      User     @relation(fields: [userId], references: [id])
  userId    Int
  tokenHash String   @unique
  familyId  String              // rotation family — revoke all on replay
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime @default(now())

  @@index([userId])
  @@map("refresh_tokens")
}

model Allergy {
  id        Int      @id @default(autoincrement())
  patient   Patient  @relation(fields: [patientId], references: [id])
  patientId Int
  substance String
  severity  AllergySeverity
  notes     String?
  createdAt DateTime @default(now())

  @@index([patientId])
  @@map("allergies")
}

enum AllergySeverity { MILD MODERATE SEVERE LIFE_THREATENING }
```

**`Prescription`** — additions that give the "can't edit after dispensed" rule something to check:

```prisma
  status         PrescriptionStatus @default(ISSUED)
  dispensedAt    DateTime?
  dispensedById  Int?
```
```prisma
enum PrescriptionStatus { ISSUED PARTIALLY_DISPENSED DISPENSED CANCELLED }
```

**`AuditLog`** — the current model can't answer "what did they actually do":

```prisma
  method     String?    // GET / POST / PATCH
  path       String?
  statusCode Int?
  outcome    String     // SUCCESS | FAILURE
  userAgent  String?
  requestId  String?

  @@index([userId, createdAt])
  @@index([targetType, targetId])
```

**`User`** — for login lockout: `failedLoginAttempts Int @default(0)`, `lockedUntil DateTime?`.

**Indexes the current schema is missing** and will need under any real load:

```prisma
// Appointment
@@index([doctorId, scheduledAt])
@@index([patientId, scheduledAt])
@@index([status, scheduledAt])

// Patient — powers ⌘K search
@@index([fullName])
@@index([phone])

// MedicalRecord
@@index([patientId, visitDate])
```

### Later phases

| Phase | Models |
|---|---|
| 3 | `Vital`, `Ward`, `Bed`, `Admission`, `MedicationAdministration` |
| 4 | `Medicine`, `StockItem`; `PrescriptionItem.medicineName` → FK `medicineId` |
| 5 | `Payment`; insurance fields on `Patient` |
| — | `UserRole.PATIENT` + `User.patientId` if a portal is ever built |

### Row-Level Security

Postgres RLS was a core reason for choosing Postgres. It is **defence in depth, not the primary control** — the API is. Enable it in Phase 1 for `patients`, `medical_records`, `prescriptions`, and `audit_logs`, with the app connecting as a non-superuser role and setting `SET LOCAL app.user_id` per transaction.

`audit_logs` gets the strictest policy: **insert-only, no update, no delete, for every role including the application's.** An audit trail the app can rewrite is not an audit trail.

---

## 6. API surface (Phase 0–1)

`/api/v1` prefix. JSON. Bearer token on everything except `@Public()` routes.

### Auth
```
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout
GET    /auth/me
```

### Patients
```
GET    /patients?q=&page=&limit=     ADMIN RECEPTIONIST DOCTOR NURSE PHARMACIST BILLING
GET    /patients/:id                 (response shaped by role — §4)
POST   /patients                     ADMIN RECEPTIONIST
PATCH  /patients/:id                 ADMIN RECEPTIONIST
GET    /patients/:id/records         DOCTOR NURSE
GET    /patients/:id/prescriptions   DOCTOR NURSE PHARMACIST
GET    /patients/:id/allergies       DOCTOR NURSE PHARMACIST
```

`q` searches name, phone, and patient ID. Rate-limited harder than other reads — bulk patient enumeration is the classic exfiltration pattern.

### Appointments
```
GET    /appointments?date=&doctorId=&status=
GET    /appointments/:id
POST   /appointments                       ADMIN RECEPTIONIST
PATCH  /appointments/:id                   ADMIN RECEPTIONIST
PATCH  /appointments/:id/status            RECEPTIONIST DOCTOR   (validated transitions)
GET    /doctors/:id/availability?date=
```

### Clinical
```
GET    /me/queue                           DOCTOR   — aggregate, one call per screen
POST   /patients/:id/records               DOCTOR
POST   /prescriptions                      DOCTOR   — with nested items
GET    /prescriptions/:id
GET    /prescriptions/:id/print            DOCTOR RECEPTIONIST PHARMACIST
```

### Admin
```
GET    /users            ADMIN
POST   /users            ADMIN
PATCH  /users/:id        ADMIN
GET    /audit            ADMIN   — filter by user, action, target, date
GET    /departments      all
GET    /doctors          all
```

### Conventions

- **Errors:** RFC 7807 problem+json. Never a stack trace, never patient data in the message.
- **Money:** `Decimal` serialised as a **string**. `"1250.00"`, never `1250.0`. JS floats lose money.
- **Dates:** ISO 8601 UTC on the wire. Rendered in hospital-local time by the client. Hospital timezone is server config.
- **Pagination:** `?page=&limit=` with `{ data, meta: { total, page, limit } }`. Hard cap `limit` at 100.
- **Idempotency:** `Idempotency-Key` header on `POST /appointments` and `POST /prescriptions`. A doctor on hospital wifi double-tapping "Issue" must not create two prescriptions.

---

## 7. Web vs mobile contracts

**Same API, same DTOs.** No separate mobile backend, no `/mobile/*` namespace. Two differences only:

**1. Aggregate endpoints for mobile-first screens.** Web can afford four parallel calls to compose a screen; a phone on hospital wifi or 4G cannot. Where a mobile screen needs several resources, add one endpoint that returns them together:

```jsonc
// GET /me/queue  → everything the doctor's queue screen renders
{
  "doctor": { "id": 7, "fullName": "Dr. …", "department": "Cardiology" },
  "stats":  { "total": 12, "waiting": 3, "inProgress": 1, "completed": 8 },
  "appointments": [
    { "id": 91, "scheduledAt": "…", "status": "CHECKED_IN", "reason": "follow-up",
      "patient": { "id": 12, "fullName": "…", "age": 47, "gender": "MALE",
                   "hasAllergies": true } }
  ]
}
```

Web uses these too where they fit. They're a latency optimisation, not a mobile fork.

**2. Push notifications.** Mobile-only: `POST /devices` to register an Expo push token, `DELETE /devices/:id` on logout. Notification *content* must never contain PHI — lock-screen previews are visible to anyone holding the phone. `"You have a new critical result"`, never `"Anwar Khan's troponin is elevated"`.

### Shared types

Generate TypeScript types from the API once and consume them in both clients — a `packages/shared-types` workspace, or generate from an OpenAPI spec via `@nestjs/swagger`. Prevents web and mobile drifting on what a `Patient` is, which is the exact failure the single-backend decision exists to avoid.

---

## 8. Testing

| Layer | Coverage |
|---|---|
| Unit | Business rules: status transitions, double-booking, dispensed-prescription immutability |
| Integration | Every endpoint × every role. **Assert forbidden fields are absent from the response body**, not merely that the UI hides them. |
| Audit | Assert a row lands in `audit_logs` for every PHI-touching request, success *and* failure |
| E2E | The Phase 1 loop: register → book → check in → consult → prescribe |

The role × endpoint matrix is the important one. It's tedious and it is the test suite that actually protects patient data — a table-driven test over `[role, method, path, expectedStatus, forbiddenFields]` covers it compactly.

---

## 9. Local development

```bash
docker compose up -d                     # Postgres 16
cd backend
npm install
npx prisma migrate dev
npm run seed                             # dummy data only
npm run start:dev                        # :3000

cd ../web && npm run dev                 # :3001
cd ../mobile && npx expo start           # point at http://<LAN-IP>:3000
```

`.env` is committed **only** with dummy local values, and the repo carries a `.env.example`. The moment a real credential exists, it does not live in git.

Mobile on a physical device needs the dev machine's LAN IP, not `localhost` — and both devices on the same network.
