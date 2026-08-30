# HMS Mobile

Expo / React Native. Doctor, nurse, pharmacist and administrator. Task parity per role, not feature parity with the web app.

## Running it

```bash
cd mobile
npm install
npx expo start      # scan the QR with Expo Go, or press i / a
```

**No IP to configure.** The API host is derived from the Expo dev server your
phone already downloaded the bundle from, so it follows you between networks and
survives a new DHCP lease. It prints what it chose on boot:

```
[api] using http://192.168.1.42:3000 (derived from Expo dev server host 192.168.1.42)
```

If a connection fails, read that line first — it distinguishes "wrong address"
from "address fine, something else is blocking".

The backend still has to be reachable *from the phone*, which is two things
beyond it running:

```powershell
# 1. Windows Firewall — your laptop is now serving a port to another device
New-NetFirewallRule -DisplayName "HMS API dev" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow

# 2. Prove the path from the phone's own browser before blaming the app
#    http://<laptop-ip>:3000/api/v1/health  →  should return {"status":"ok"}
```

Phone and laptop must be on the same Wi-Fi — not mobile data, and not a guest
network with client isolation, which blocks device-to-device traffic outright.

Set `expo.extra.apiOrigin` in `app.json` only for a standalone build, where
there is no dev server to derive from.

Sign in as `doctor@demo.test`, `nurse@demo.test`, `pharmacy@demo.test`, `admin@demo.test`, `reception@demo.test` or `billing@demo.test` / `ChangeMe123!`.

**Every role can use this app.** Reception and billing were refused at login for
six phases, justified by a comment claiming the backend "would refuse every
clinical call anyway" — which was untrue; reception has its own endpoints and
always did. The real reason was that nobody had built reception screens, and an
absence had acquired a rationale.

It was also wrong for the clinics this is built for. A small practice where the
receptionist has a phone and no desktop is the normal case, and check-in is
*better* on a phone — you are standing next to the person you are checking in.
`role-screens.test.ts` now fails the build if a role in `UserRole` has no tab,
so this cannot happen again by omission.

## What it does, and what it deliberately doesn't

Every role has screens; none has *every* screen. The rule is **task parity per
role, not feature parity** — mobile carries the work that happens on your feet,
and the desk work stays at the desk.

| Role | On mobile | Web only |
|---|---|---|
| Doctor | Today's queue, patient summary, write a prescription | Full history review, printing |
| Nurse | Ward board, bedside vitals, medication round | — |
| Pharmacist | Queue length, stock alerts (read-only) | Dispensing — needs the shelf in front of you |
| Reception | Today's schedule, check-in, patient search, registration, booking | Rescheduling, cancelling, duplicate merging |
| Billing | Outstanding invoices, take a payment | Aging reports, reconciliation, bulk invoice entry |
| Admin | Aggregate overview (no patient reachable) | Users, departments, audit, reports |

Screens say this out loud rather than leaving someone hunting for a tab that
isn't there.

Two exclusions worth their reasoning. **Pharmacist dispensing is absent on
purpose**: it needs a batch number read off a box and a signature that
decrements stock, and a "dispense" button pressable from a corridor invites
signing for something not yet done. **Admin can reach no patient at all** — that
mirrors the backend, where admin holds no clinical GET whatsoever.

## Security decisions worth knowing

**Refresh token lives in `expo-secure-store`** — iOS Keychain, Android EncryptedSharedPreferences, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so it is unreadable while locked and excluded from backups. **Never `AsyncStorage`**, which is a plain SQLite file in the app sandbox, readable in seconds on a rooted device and captured in unencrypted backups. `secure-session.test.ts` scans the source and fails if `AsyncStorage` appears anywhere.

**Access token is in memory only**, same as web.

**The app locks after 15 idle minutes in the background.** A phone left on a ward desk is the realistic threat — small enough to be picked up and carried off, and nobody notices it is unattended. The session survives; the display does not. Unlocking is biometric, because typing a password on a phone keyboard between patients is the kind of friction that gets a control switched off. A device with no biometrics enrolled signs out instead of falling through.

**The lock screen sits above the navigator**, not inside it, so a notification tap on a locked phone lands on the unlock prompt rather than a patient record.

**The cached queue is in SecureStore too.** It holds patient names, ages and an allergy flag — PHI on a device that goes home in a pocket. It is wiped on sign-out along with the tokens.

## Notifications carry no patient data

The server decides notification content and every possible string is a constant in `backend/src/notifications/notification-payload.ts`. "A patient has checked in for you" — never a name, condition, or result.

A push notification renders on a locked phone, is copied into the OS notification centre, and on some platforms syncs to a paired watch or laptop. None of those surfaces are audited or authenticated. The payload carries an id; the app fetches the detail after the doctor unlocks, and *that* read lands in the audit log.

`buildPushMessage` takes a kind and numeric ids — there is no string parameter, so a future caller physically cannot write `Patient ${name} is waiting`. `notification-payload.spec.ts` asserts it.

## Offline tolerance

Hospital wifi is bad in lifts, stairwells and older wings. The last successful queue is cached and shown immediately with a visible age, while a fresh fetch runs behind it. An out-of-date queue with a timestamp beats a spinner — the doctor can judge whether four-minute-old data is good enough; a spinner tells them nothing.

## Tests

```bash
npm test      # 91 tests, no device or backend required
```

- `secure-session.test.ts` — access token never touches storage, `clear()` removes everything, idle lock boundaries including a backwards clock jump, and the AsyncStorage source scan.
- `types.drift.test.ts` — the API shapes here stay byte-identical to `web/lib/types.ts`.

Component rendering is not tested. Rendering RN in Node needs `react-test-renderer` plus a Metro-shaped module map, and the result tests the mock more than the app; the assertions that matter here are plain TypeScript.

## Known gaps

- **`lib/types.ts` is a copy of `web/lib/types.ts`, not a shared package.** `docs/technical-design.md` §7 calls for extraction, and that is still right. It needs npm workspaces plus Metro `watchFolders` config to resolve a symlinked package — bundler config that cannot be verified without running on real hardware. The drift test holds the line until then. **Extract it the first time this app boots on a device.**
- **Nothing here has run on a phone.** It typechecks and its logic is tested, but no screen has been rendered. Treat the first device run as the real review.
- Alerts only persist for the current session; there is no server-side notification history.
- Every notification kind currently deep-links to the queue rather than the specific record.
- Prescriptions still need connectivity; only vitals and doses go through the outbox.
- The admin overview is read-only aggregates with nothing to tap through to. That is deliberate — a phone that could reach a patient record from a management summary would undo the rule that admin is operational, not clinical.
