# Google Play Console — store listing copy

Paste these into **Store presence → Main store listing**.

---

## App name (30 characters max)

```
My Hospital
```

---

## Short description (80 characters max)

```
Hospital staff app for queues, wards, pharmacy, lab and billing on your phone.
```

Alternatives if you want a different emphasis:

```
Run your clinic from your phone: patients, wards, pharmacy, lab and billing.
```

```
Secure staff app for clinics and hospitals. One login, only your own screens.
```

---

## Full description (4000 characters max)

```
My Hospital is the mobile app for staff at clinics, hospitals, pharmacies and diagnostic laboratories. It is a work tool, not a patient app — you sign in with an account created by your own organisation.

Everything you do on the phone is the same record your colleagues see on the desktop app, updated as it happens.

WHAT EACH ROLE GETS

Doctors
• Today's queue, with the patient you are about to see at the top
• A patient summary with allergies, recent visits and results
• Write a prescription, or repeat an earlier one in two taps
• Answer medication requests raised from the ward

Nurses
• Ward board with beds, admissions, transfers and discharges
• Record observations at the bedside
• The medication round: sign for a dose in front of the patient
• Raise a supply request or a medication request to the pharmacy or a prescriber

Reception
• Today's schedule, with one-tap check-in
• Register a new patient, with duplicate detection so one person does not become two records
• Book against your clinic's own slot grid and opening hours
• Raise the consultation charge at the desk

Pharmacy
• Dispensing queue and stock alerts
• Batch and expiry aware, with the quantity worked out for you
• Prescriptions sent in by partner clinics
• Today's takings at a glance

Laboratory
• Worklist from ordered through collected, in progress, resulted and verified
• Specimen collection, barcoded labels, and a scanned number that opens the tube
• Result entry with reference ranges and a stop on critical values
• Incoming referrals from partner hospitals, and statements for what they owe
• Take payment at the lab counter

Billing
• Outstanding invoices, and what is actually still due on each
• Take a payment at the desk and hand over the receipt

Administrators
• Read-only overview of the day: attendance, takings and staff activity
• Set a doctor's consultation fee, clinic settings and staff roles

BUILT FOR REAL CLINICS

• Works offline at the bedside. Observations and doses are saved on the device and sent when signal returns, and they cannot be recorded twice by a retry.
• Your hospital's own clinic day. Timezone, opening hours and appointment length are yours, so "today" means what it means where you are.
• Your own currency and tax rules, including multi-component rates.
• Refer a prescription to a partner pharmacy, or a test to a partner laboratory, and get the report back.

PRIVACY AND SECURITY

• Access is decided on the server, per role. Nobody sees more than their job needs — a receptionist never sees clinical notes.
• Every access to patient data is written to your hospital's own audit log: who, what, when.
• Your sign-in is protected by a device lock or biometric after a period of inactivity.
• Notifications never contain patient details. You open the app to see anything.
• One hospital can never see another's records. That is enforced by the database itself, not just by the app.

WHAT YOU NEED

An account at an organisation that uses this system. The app cannot be used without one, and there is no public sign-up here — ask your administrator. If your clinic is not set up yet, they can apply on the web.

Some screens depend on what your organisation has: a clinic with no pharmacy will not show dispensing, and a laboratory will not show the appointment book.
```

---

## Graphics

Run `cd mobile && npm install && npm run icons` once. It writes:

| File | Where it goes |
| --- | --- |
| `store/play-icon-512.png` | Play Console → Main store listing → App icon |
| `store/play-feature-graphic.png` | Play Console → Main store listing → Feature graphic |
| `mobile/assets/icon.png` | the app itself, via `app.config.js` |
| `mobile/assets/adaptive-icon.png` | Android home screen |
| `mobile/assets/splash.png` | launch screen |
| `mobile/assets/notification-icon.png` | the status bar |

The feature graphic deliberately has no text on it — add the app name over it in
any design tool, where you can see how it sits. Play also wants **at least two
phone screenshots**; take those on a device once the app is running, and choose
screens with no real patient names in them.

---

## Notes before you submit

1. **Demo account is required.** The app is entirely behind a login, so Play review will reject it without one. Add a working username and password under **App content → App access**, with a short note saying which role it signs in as. Give them an account that can see several roles if you can.
2. **Data safety form.** You collect health information, names, dates of birth and contact details. Declare them as collected, tied to the user's organisation, and state that data is encrypted in transit. Do not tick "data is not collected".
3. **Health apps declaration.** Play asks about health data. This is a staff record-keeping tool rather than a medical device or a diagnosis aid — say so plainly, and do not use words like "diagnose", "treat" or "monitor" in the listing.
4. **Category:** Medical. **Content rating:** answer the questionnaire as a professional tool with no user-generated public content.
5. **Not for patients.** Keep that sentence in the description. It heads off a reviewer expecting a consumer health app, and it is the reason the app has no sign-up screen.
