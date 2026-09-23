# Building the AAB and getting it onto Google Play

Everything here is run from `mobile/`. Read section 0 first — as of today it
decides whether any of the rest will be accepted.

---

## 0. Read this before building anything: the target API level

**Since 31 August 2026, Google Play rejects any new app or update that targets
below Android 16 (API 36).** That date has passed. Expo SDK 52 — what this app
is on — targets **API 35**, so an AAB built today is uploaded, scanned, and
refused with a message about the target SDK. Nothing else in this guide changes
that; it is the first wall.

Three ways through, in the order worth trying:

**a. Ask for the extension, then fix it properly.** Play is granting extensions
to **1 November 2026**, requested from the app's page in Play Console. That buys
time to do (b) without a rushed upgrade.

**b. Override the target on SDK 52.** `expo-build-properties` can set the target
without changing SDK:

```bash
npx expo install expo-build-properties
```

then add to the `plugins` array in `app.config.js`:

```js
[
  'expo-build-properties',
  { android: { compileSdkVersion: 36, targetSdkVersion: 36, buildToolsVersion: '36.0.0' } },
],
```

This is the cheap attempt and it is not guaranteed. SDK 52 ships React Native
0.76 with an Android Gradle Plugin from before API 36 existed, so the build can
fail on the toolchain rather than on your code. If it builds, **test on a real
Android 16 device** — a raised target turns on new runtime behaviour (stricter
background limits, edge-to-edge by default) and the failures land at runtime,
not at build time.

**c. Upgrade the SDK.** SDK 55 and above target API 36 by default. This is the
real answer and it is a piece of work: three SDK jumps, a React Native upgrade,
and the first native build this app has ever had. Do it deliberately, not the
afternoon before a release.

---

## 1. One-time account setup

You need three things, and they are separate accounts that people conflate:

| | What it is | Cost |
| --- | --- | --- |
| **Expo account** | builds the AAB on Expo's machines and holds your signing key | free tier is enough |
| **Google Play Developer account** | the store listing and the upload | US$25, once, ever |
| **Google Cloud service account** | *optional*, lets `eas submit` upload without you | free |

Install the CLI and sign in:

```bash
npm install --global eas-cli
eas login
eas whoami
```

### Register the project with Expo

```bash
cd mobile
eas init
```

`eas init` normally writes the project id into `app.json`. **This app has a
dynamic `app.config.js`, which the CLI cannot write into**, so it prints the id
and stops. Paste it into `extra` in `app.config.js` — there is a commented line
there waiting for it:

```js
eas: { projectId: '...the id eas init printed...' },
```

Until that line is live, every `eas build` refuses with *"run eas init"*, which
reads as the CLI being broken rather than as one missing line.

---

## 2. Signing: the authorisation chain for a release

This is the part worth understanding rather than following, because one half of
it is recoverable when lost and the other is not.

There are **two** keys, and Play holds one of them:

```
  your upload key  ──signs the AAB──▶  Play verifies it is you
                                        │
                                        ▼
                              Play re-signs with the
                              app signing key it holds
                                        │
                                        ▼
                                 what phones install
```

- **The app signing key** is what Android checks when installing an update. If it ever changes, existing installs cannot be updated — the app is effectively a different app. **Play App Signing** means Google generates and keeps this key, so it cannot be lost, and that is the whole reason to use it. It is the default for new apps and you should not opt out.
- **The upload key** is only how Play knows an upload came from you. If it leaks or is lost, Play support resets it. Recoverable, which is exactly what the other one is not.

### Let EAS generate and hold the upload key (recommended)

```bash
eas credentials
# → Android → production → Keystore → Set up a new keystore
```

EAS generates it, keeps it server-side, and signs every build with it. Nothing
sensitive lands in the repo. Back it up anyway:

```bash
eas credentials
# → Android → production → Keystore → Download existing keystore
```

Put that file and its passwords somewhere that is not this repo and not one
laptop. `.gitignore` already refuses `*.jks`, `*.keystore` and
`credentials.json`, because the realistic mistake is a keystore sitting in
`mobile/` next to `eas.json` and going in with a `git add .`.

### Or generate it yourself

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore upload.keystore -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

`-validity 10000` is about 27 years. Play requires a key valid past 2033, and a
key that expires mid-life is a problem with no clean fix.

---

## 3. Build the AAB

The production profile in `eas.json` already does the right things: no
`buildType` override, so it produces an **AAB** (Play wants a bundle, not an
APK); `autoIncrement: true` with `appVersionSource: "remote"` so Play's
`versionCode` goes up on its own. That matters — Play refuses any upload whose
`versionCode` is not higher than the last, and hand-incrementing it is the thing
everyone forgets on release three.

Generate the icons first if you have not (`assets/` is otherwise empty and Expo
substitutes blank artwork *without failing the build*):

```bash
npm install
npm run icons
```

Then:

```bash
eas build --platform android --profile production
```

The build runs on Expo's machines; the terminal prints a URL to watch. On
success it gives you a download link, or:

```bash
eas build:list --platform android --limit 5
```

### Point it at the right API first

`app.config.js` refuses to build a non-development profile against plain HTTP,
deliberately — the refresh token is a `Secure` cookie and this app carries
patient data. Production defaults to `https://hms.sawera.info`. To override:

```bash
API_ORIGIN=https://hms.yourhospital.com eas build --platform android --profile production
```

That origin needs a **real certificate**. Android rejects self-signed certs with
a generic network error, which reads on a phone as "the app does not work"
rather than as a TLS problem.

### Building locally instead

If you would rather not use Expo's builders:

```bash
eas build --platform android --profile production --local
```

Needs JDK 17, the Android SDK, and on Windows it needs WSL. Or drop EAS
entirely:

```bash
npx expo prebuild --platform android --clean
cd android
./gradlew bundleRelease
# → android/app/build/outputs/bundle/release/app-release.aab
```

That route makes signing your problem: `android/` is generated, so a signing
config added to `build.gradle` is wiped by the next `prebuild`. If you go this
way, commit `android/` and stop prebuilding, or keep the signing config in
`gradle.properties` outside the generated tree. EAS exists to avoid this choice.

### A staging build to put on a phone first

```bash
eas build --platform android --profile staging
```

APK, internal distribution, amber band on the icon so it is distinguishable from
the real app on the same home screen. **This app has never run on Android
hardware.** Install this one and work through each role before you spend a
production `versionCode`.

---

## 4. The first upload has to be by hand

The Play Developer API cannot create the *first* release of an app. So:

1. Play Console → **Create app** — name, language, "App", "Free".
2. Fill **App content**: privacy policy URL, Data safety, App access, ads declaration, content rating, target audience, health apps declaration. Sections 6–8 below cover the ones with traps.
3. **Testing → Internal testing → Create new release** → upload the `.aab`.
4. Accept **Play App Signing** when offered.

Store listing text, the 512×512 icon and the feature graphic are in
[`PLAY-STORE-LISTING.md`](PLAY-STORE-LISTING.md), already written.

---

## 5. Automated uploads after that

`eas.json` names a service account file, and the file does not exist yet. To
create it:

1. Play Console → **Setup → API access** → link a Google Cloud project.
2. Google Cloud Console → **IAM & Admin → Service Accounts → Create**. No project-level roles needed.
3. On that service account → **Keys → Add key → JSON**. Save it as `mobile/play-service-account.json` — `.gitignore` already refuses it.
4. Back in Play Console → **Users and permissions → Invite new user** → paste the service account's email → grant it **app-level** permissions on this app only: *Release to testing tracks*, *View app information*. Add *Release to production* only when you actually want a machine able to do that.

Then:

```bash
eas submit --platform android --profile production --latest
```

The profile is set to `track: internal` and `releaseStatus: draft` on purpose:
an automated upload lands somewhere harmless and a human presses the button.
A pipeline that can put a build in front of patients unattended is not a
convenience worth having on a clinical app.

**Scope it to the app, never the Google Cloud project.** A service account with
project-wide rights can publish to every app on the account, and this key sits
on a developer laptop.

---

## 6. The closed-testing requirement, if it applies to you

If your Play Console account is a **personal** account created **after 13
November 2023**, you cannot publish to production until you have run a closed
test with **at least 12 testers opted in continuously for 14 days**, and then
applied for production access.

- **Organisation accounts are exempt**, as are personal accounts opened before that date.
- The 14 days must be *continuous*. A tester who opts out and back in restarts their clock, and testers below 14 days do not count — so recruit more than twelve.
- Plan for it: it is a fortnight of calendar time, not a form.

Twelve real users on a hospital app is not a hardship — it is the on-device
testing this app has never had. Recruit from the clinic.

---

## 7. App access: the demo account, and why it is mandatory here

Every screen in this app is behind a login and there is **no sign-up**, by
design — accounts are created by a hospital administrator, or by the vendor at
provisioning. A reviewer who cannot get in rejects the app without seeing it.

Play Console → **App content → App access** → *All or some functionality is
restricted* → add credentials.

Give them an account that holds **several roles**, so one login reaches the
queue, the ward board and the till. That is what multi-role assignment is for,
and it saves a reviewer concluding the app is mostly empty.

Two things to write in the notes field:

- Sign in with the email and password given; there is no registration screen and that is deliberate for a staff tool.
- The app locks itself after 15 minutes idle and asks for device biometrics or the device PIN. On an emulator with no lock screen set, set one first or the unlock cannot complete.

Point it at **staging with dummy data**, never at a hospital holding real
records. A reviewer is a stranger with a working login.

---

## 8. How authentication and authorisation actually work

For the Data safety form, the health apps declaration, and anyone who asks.

**Signing in.** Email and password against `POST /auth/login`. Passwords are
hashed with **Argon2**, never stored or logged in the clear. Repeated failures
lock the account, and the login rate limit buckets on **IP + email** rather than
IP alone — bucketing on IP throttles a hospital where six staff sign in from one
building inside a minute, while leaving an attacker the full budget per account.

**Email is unique per hospital, not globally**, so one person can hold accounts
at two. When an address matches two, login refuses with the same *invalid email
or password* as a wrong password — saying "which hospital did you mean" tells an
attacker where an address is registered. The way out is a third field for the
hospital code, revealed after any failed attempt.

**Tokens.**

- The **access token** is a short-lived JWT held **in memory only** and sent as an `Authorization` header. Deliberately not a cookie and not in storage: anything a script can read, an XSS payload can read.
- The **refresh token** is long-lived, **rotates on every use**, and lives in `expo-secure-store` — the Android Keystore, not app storage.
- After **15 minutes idle** the app locks and requires device biometrics or the device PIN (`expo-local-authentication`). The token survives; the screen does not unlock without the person.

**Authorisation is three layers, all server-side**, and the client is never the
boundary — the API assumes any client can call any endpoint:

1. **Route.** `@Roles()` plus a guard: may this role call this endpoint at all?
2. **Resource.** Query scoping in the service: may this user see *this row*? A guard cannot answer that.
3. **Response.** The same endpoint returns a different body per role. A receptionist reading a patient does not receive allergies; billing staff reading an invoice get medicine and test lines collapsed to a count, because a test name is frequently the question itself.

**One role at a time.** A person may hold several (the clinic owner who is also
the treating doctor) and acts as exactly one, switched through an audited
endpoint. The union is never granted, so an administrator cannot pick up
clinical access by holding both.

**Which hospital you are in comes from your own user row, never from the
request.** Every table holding patient-derived data carries a tenant id and a
Postgres row-level security policy keyed on it — so a query that forgets its
filter returns **zero rows**, not another hospital's records. The database
enforces the separation; the application only asks.

**Every access to patient data is audited** — who, what, when, which record —
into that hospital's own log, refusals included. Push notifications carry no
patient details at all: a lock screen is unauthenticated, so the content is a
server-chosen constant and the app fetches the detail after unlock, where the
read *is* audited.

---

## 9. What will actually bite

In the order you will meet them:

1. **Target API 36.** Section 0. Everything else is wasted effort until this is settled.
2. **The missing `projectId`.** Builds refuse with a message about `eas init` that you have already run.
3. **Empty `assets/`.** `npm run icons` needs `sharp` installed. If it has not been run, the build *succeeds* with Expo's blank artwork — nothing fails, and you find out on the store page.
4. **The first native build.** This app has only ever run in Expo Go. The new architecture is on, and `sharp`, `expo-notifications` and biometrics have never been through a release build. Expect the first one to fail on something unrelated to your code.
5. **HTTPS.** A self-signed certificate presents as a generic network failure on the device.
6. **Data safety.** You collect health information, names and dates of birth. Declaring "no data collected" on a hospital app is the mismatch that gets an app pulled after it has shipped.
7. **Two phone screenshots minimum**, from a device, with no real patient names in them.

---

Sources for the two Play policies above, both of which change:
[target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878),
[meeting the target API level](https://developer.android.com/google/play/requirements/target-sdk),
[testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465).
Check them in the console before you plan a date around either.
