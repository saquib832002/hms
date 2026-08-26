# HMS Web

Next.js 15 (App Router) staff client. Design comes from [`../docs/ui-design.md`](../docs/ui-design.md); navigation from [`../docs/role-navigation.md`](../docs/role-navigation.md).

**All phases complete** — the receptionist → doctor loop, and the nurse's inpatient surface: ward board with admit / transfer / discharge, drug-chart scheduling, observation history and the medication round.

## Running it

```bash
# Backend must be running first (see ../backend/README.md)
cd web
npm install
npm run dev          # http://localhost:3001
```

Sign in with any seeded account — `reception@demo.test` or `doctor@demo.test`, password `ChangeMe123!`. Each role lands on its own screen.

## The API is proxied, and that matters

`next.config.mjs` rewrites `/api/v1/*` to the backend. This is not a convenience.

The refresh token is an httpOnly `SameSite=Strict` cookie scoped to `/api/v1/auth`. A browser on `localhost:3001` will not send that cookie to `localhost:3000`, so without the rewrite silent refresh never fires and every page reload bounces the user back to the login screen. Proxying makes the API same-origin from the browser's point of view — which is also how it should be deployed.

Point it elsewhere with `API_ORIGIN` in `.env.local`.

## How auth works

- **Access token lives in a module variable — memory only.** Never `localStorage`. Anything script can read, an XSS payload can read, and a stolen token here reads patient records.
- **Refresh token is the httpOnly cookie**, which script cannot touch at all.
- A page reload therefore loses the access token *by design*; the app silently re-establishes one from the cookie on boot (`bootstrapSession`).
- A 401 mid-session is expected, not exceptional — access tokens last 15 minutes. `lib/api.ts` refreshes once and retries transparently, sharing one in-flight refresh across concurrent requests.

## What's here

```
app/
├── login/                  sign in
└── (app)/                  authenticated shell
    ├── queue/              doctor · two-pane today's queue
    ├── check-in/           reception · scan-and-act table
    ├── appointments/       booking sheet with server-driven availability
    ├── patients/           two-pane list + detail
    ├── patients/new/       registration with duplicate detection
    ├── ward/               nurse · bed board, admit, transfer, discharge, drug chart
    ├── vitals/             observation history (entry is on the phone)
    ├── medications/        drug round, read-only (signing is on the phone)
    ├── doctors/  audit/
    ├── pharmacy/queue     dispensing with allergy block + override
    ├── pharmacy/inventory batch stock, low-stock and expiry
    ├── billing/invoices   invoices with inline aging, creation, payments
    ├── billing/payments    money received
    ├── admin              operational dashboard — no patient data reachable
    ├── admin/users        staff accounts, roles, temporary passwords
    └── admin/departments
components/
├── shell.tsx               sidebar (role-derived) + topbar
├── command-palette.tsx     ⌘K patient search
├── allergy-banner.tsx      never collapsed, never behind a tab
├── record-sheet.tsx        write a clinical record
├── prescription-sheet.tsx  issue a prescription, with allergy hints
├── admit-sheet.tsx         admit and transfer
├── schedule-medication-sheet.tsx  build a drug chart from a prescription
├── dispense-sheet.tsx      dispensing, allergy check above the medicines
├── map-medicines-sheet.tsx map free-text items onto the catalogue
├── dispense-history-sheet.tsx  history, with overrides highlighted
├── invoice-sheet.tsx       invoice detail, payment, void
├── create-invoice-sheet.tsx  invoice creation from service presets
├── password-gate.tsx       blocks the app until a forced password change is done
└── ui/                     primitives, status chips, side sheet
lib/
├── api.ts  auth-context.tsx  nav.ts  types.ts  format.ts
```

## Three things to know before changing anything

**1. The sidebar is not the security boundary.** `lib/nav.ts` hides things for usability. The API enforces access and assumes any client can call any endpoint directly. If `nav.ts` and the backend's `@Roles()` disagree, the backend is right and `nav.ts` is the bug.

**2. Absent is not hidden.** `Patient.allergies` and `bloodGroup` are optional in `lib/types.ts` because the API omits them entirely for non-clinical roles. `AllergyBanner` renders nothing when `allergies === undefined` (role can't see them) and "No known allergies" when it's `[]` (role can see them; there are none). Those two states must stay distinct.

**3. Business rules are not re-implemented here.** The status machine, double-booking, and dispensed-prescription immutability all live in the backend. The UI shows the server's error message rather than guessing — which is why the check-in screen surfaces a 409 verbatim instead of pre-validating.

## Tests

```bash
npm test          # 74 tests, no backend required
```

| File | What it protects |
|---|---|
| `lib/nav.test.ts` | The role → nav matrix. Mirrors the backend's access-matrix test: reception and billing must never be offered a clinical route. |
| `components/allergy-banner.test.tsx` | That `undefined` (role cannot see allergies) and `[]` (role can; there are none) never collapse into the same rendering. |
| `lib/api.test.ts` | The refresh dance — one shared refresh across concurrent 401s, retry with the *new* token, token never written to browser storage. |
| `lib/no-browser-storage.test.ts` | Static scan: no `localStorage`, `sessionStorage`, `document.cookie` or `indexedDB` anywhere in `lib/`, `components/` or `app/`. |
| `lib/use-auto-refresh.test.ts` | Polling stops when the tab is hidden, resumes on return, and survives the callback changing identity. |
| `components/ui/confirm-dialog.test.tsx` | Focus lands on dismiss rather than the destructive button, so a stray Enter cannot cancel an appointment. |

The `api.test.ts` suite earned its place immediately: it caught that the in-flight refresh slot was being cleared on a `setTimeout` rather than when the promise settled, which meant a stale resolved promise could be handed to a later caller.

## Live refresh

Queue, check-in and appointment screens poll every 15 seconds via `useAutoRefresh`, and show how old the data is.

**Why polling and not SSE.** `EventSource` cannot set an `Authorization` header, so the access token would have to travel in the query string — which the backend's audit interceptor records in `path`. That writes a live credential into the append-only audit table on every connection. Cookie-authenticated SSE would work, but the access token is deliberately not a cookie, so that means a second auth path existing for one transport. Polling costs one indexed query per user per 15s and needs neither. Revisit if a screen ever needs sub-second freshness — vitals monitoring would.

Polling pauses while the tab is hidden (a terminal left open overnight should not spend the night querying) and while a sheet is open (the queue must not shift under a half-written prescription).

## Confirmation, used sparingly

`ConfirmDialog` guards appointment cancellation and no-show — both terminal, both wrong-row-able. Check-in stays one click: it is routine and reversible in practice, and a dialog on an action performed forty times a morning trains everyone to dismiss dialogs without reading them, which is how the ones that matter stop working.

## Known gaps

- Availability is fetched but not live — two receptionists on the same slot find out on submit, when the API returns 409. Handled, but not pretty.
- Sidebar does not collapse to icons yet (ui-design.md calls for it at ≥1024px).
- No `g`-then-key navigation or `?` shortcut cheatsheet; only ⌘K, j/k, Enter and Esc are bound.
- No shared `DataTable` — three screens hand-roll their own table markup.
- Nothing degrades to a single pane below 1024px.
- No end-to-end test of the full loop; the suite is unit-level.
- **Currency is always a string.** `lib/format.ts` `money()` takes a string and returns a string — it never converts to a number, because `Number("1250.00")` reintroduces the float the string exists to avoid. The API sends `outstanding` pre-computed so no client does the subtraction.
- **The password gate sits above the shell, not inside a route** — there is no URL that skips a forced password change, and `mustChangePassword` is re-read from the server on every request so a reload cannot either.
- No `g`-then-key navigation or `?` cheatsheet; the sidebar still does not collapse to icons; nothing degrades below 1024px. All three are `ui-design.md` commitments that remain unbuilt.
- Admission history has no screen — past stays are not visible anywhere.
