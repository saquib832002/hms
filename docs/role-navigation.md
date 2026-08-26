# Role-Based Navigation Map

Source of truth for what each role sees. The web sidebar and mobile tab bar are both generated from this. Backend RBAC guards must mirror it exactly — this file describes the UI, not the security boundary.

Roles come from `UserRole` in `schema.prisma`: `ADMIN`, `DOCTOR`, `NURSE`, `RECEPTIONIST`, `PHARMACIST`, `BILLING_STAFF`.

Related: [`../PLAN.md`](../PLAN.md) · [`technical-design.md`](technical-design.md) · [`ui-design.md`](ui-design.md) · [`wireframes.html`](wireframes.html)

---

## DOCTOR

**Web sidebar**

| Item | Route | Primary view |
|---|---|---|
| Today's Queue *(landing)* | `/queue` | Appointments for `doctorId = me`, today, ordered by `scheduledAt`. Status chips drive the workflow: SCHEDULED → CHECKED_IN → IN_PROGRESS → COMPLETED. |
| My Appointments | `/appointments` | Calendar + list, filterable by date range and status. |
| Patients | `/patients` | Search-first. List left, detail right. Detail tabs: Overview, Medical Records, Prescriptions, Appointments. |
| Prescriptions | `/prescriptions` | Written by me. Create flow adds `PrescriptionItem` rows (medicine, dosage, frequency, duration). |
| Medical Records | `/records` | Write diagnosis + notes against a visit. |

**Mobile** — Today's Queue, Patient search (read-only summary + recent records), Approve/issue prescription, Alerts.

**Not visible:** invoices, staff management, inventory, system settings.

---

## NURSE

**Web sidebar**

| Item | Route | Primary view |
|---|---|---|
| Ward / Patient List *(landing)* | `/ward` | Currently admitted or checked-in patients. |
| Vitals | `/vitals` | Entry form per patient, timestamped. |
| Medication Schedule | `/medications` | Due/overdue administration derived from active `PrescriptionItem` rows. |
| Appointments | `/appointments` | Read-only day view, for prep. |
| Patients | `/patients` | Clinical detail, read-only except vitals/notes. |

**Mobile** — this is the most mobile-critical role. Bedside vitals entry, medication due list with mark-as-given, patient lookup, alerts.

**Not visible:** billing, prescription authoring, staff management, reports.

---

## RECEPTIONIST

**Web sidebar**

| Item | Route | Primary view |
|---|---|---|
| Check-in Queue *(landing)* | `/check-in` | Today's arrivals; sets `CHECKED_IN` / `NO_SHOW`. |
| Appointments | `/appointments` | Book, reschedule, cancel across all doctors. Doctor availability grid. |
| Patient Registration | `/patients/new` | Create `Patient` — demographics, contact, emergency contact, blood group. |
| Patients | `/patients` | **Demographic fields only.** No diagnoses, notes, or prescriptions. |
| Doctors | `/doctors` | Directory + availability, read-only. |

**Mobile** — not a priority role for mobile; front-desk work is desk-bound. Optional read-only day schedule.

**Not visible:** clinical data of any kind, billing amounts, reports. This is the sharpest minimum-necessary boundary in the system — enforce it in the API response shape, not just the UI.

---

## PHARMACIST

**Web sidebar**

| Item | Route | Primary view |
|---|---|---|
| Prescription Queue *(landing)* | `/pharmacy/queue` | Pending prescriptions across all doctors, oldest first. Dispense action. |
| Dispensed History | `/pharmacy/history` | Audit trail of what was dispensed, by whom, when. |
| Inventory | `/pharmacy/inventory` | Stock levels, low-stock alerts. **Requires new models — see gaps.** |
| Patients | `/patients` | Minimal: name, DOB, allergies, active medications. Not full history. |

**Mobile** — queue view + low-stock alerts. Dispensing itself stays on web (barcode/stock accuracy).

**Not visible:** appointments, medical records, billing, staff management.

---

## BILLING_STAFF

**Web sidebar**

| Item | Route | Primary view |
|---|---|---|
| Invoices *(landing)* | `/billing/invoices` | Filter by `InvoiceStatus`: PENDING / PAID / PARTIALLY_PAID / OVERDUE / CANCELLED. |
| Create Invoice | `/billing/invoices/new` | Attach `InvoiceItem` lines to a patient. |
| Payments | `/billing/payments` | Record payments against invoices. **Requires new model — see gaps.** |
| Outstanding / Aging | `/billing/aging` | Overdue report by age bucket. |
| Patients | `/patients` | **Billing-relevant fields only:** name, DOB, contact, insurance. No clinical data. |

**Mobile** — web-only role. Reconciliation on a phone is a bad idea.

**Not visible:** diagnoses, notes, prescriptions, ward status.

---

## ADMIN

**Web sidebar**

| Item | Route | Primary view |
|---|---|---|
| Dashboard *(landing)* | `/admin` | Appointment volume, occupancy, revenue summary, active staff. |
| Staff / Users | `/admin/users` | Create users, assign `UserRole`, deactivate (`isActive`). |
| Doctors | `/admin/doctors` | Profiles, specialization, department assignment. |
| Departments | `/admin/departments` | CRUD. |
| Reports | `/admin/reports` | Operational + financial, exportable. |
| Audit Log | `/admin/audit` | `AuditLog` browser — filter by user, action, target, date. |
| Patients | `/patients` | **Demographics only** — same shape the receptionist gets. For operational work: fixing a mistyped registration, merging duplicates. No clinical data. |
| Settings | `/admin/settings` | System configuration. |

**Mobile** — dashboard KPIs only, read-only.

**Important:** admin is an *operational* role, not a clinical one. Do not give ADMIN blanket read access to diagnoses and notes by default — that breaks minimum-necessary. If break-glass access is ever needed, make it an explicit, loudly-audited action rather than an always-on permission.

---

## Doctor's Dashboard — layout detail

The landing screen for the highest-value role. Desktop-app treatment.

```
┌────────────┬──────────────────────────────────────────────────────┐
│            │  Dr. [Name] · [Department]        [⌘K search]  [👤]  │
│  SIDEBAR   ├──────────────────────────────────────────────────────┤
│            │  ▸ 12 today   ▸ 3 waiting   ▸ 1 in progress          │
│  Queue  ●  ├───────────────────────┬──────────────────────────────┤
│  Appts     │  TODAY'S QUEUE        │  SELECTED PATIENT            │
│  Patients  │                       │                              │
│  Rx        │  09:00 A. Khan   ✓in  │  Anwar Khan · 47 · M · B+    │
│  Records   │  09:30 M. Rao    ✓in  │  ─────────────────────────   │
│            │  10:00 S. Patel  ●now │  Overview│Records│Rx│Appts   │
│            │  10:30 J. Silva       │                              │
│            │  11:00 R. Nair        │  Reason: follow-up, HTN      │
│            │                       │  Last visit: 12 Jun 2026     │
│            │                       │  Active Rx: Amlodipine 5mg   │
│            │                       │  Allergies: Penicillin  ⚠    │
│            │                       │                              │
│            │                       │  [Start Consult] [Write Rx]  │
└────────────┴───────────────────────┴──────────────────────────────┘
```

Behaviours worth building in from the start:

- **⌘K global search** — patient by name/ID/phone, jumps straight to detail. Doctors and receptionists will use this constantly.
- **No page reloads** between queue selection and detail panel.
- **Allergy banner is always visible** on the patient panel, never behind a tab. Cheapest safety win in the whole UI.
- **`j`/`k` to move through the queue**, `Enter` to open.
- Status transitions are one click from the queue row.

---

## Gaps — nav items with no backing model

These routes are in the map but cannot be built until the schema grows:

| Nav item | Missing |
|---|---|
| Nurse → Vitals | `Vital` model (patientId, recordedById, timestamp, BP, pulse, temp, SpO2, resp. rate) |
| Nurse → Ward / Beds | `Ward`, `Bed`, `Admission` models — nothing in the schema tracks admission or occupancy |
| Nurse → Medication Schedule | `MedicationAdministration` model (which `PrescriptionItem`, due time, given time, given by) |
| Pharmacist → Inventory | `Medicine`, `StockItem` models. Also: `PrescriptionItem.medicineName` is a free-text string — should become a FK to `Medicine` before inventory is meaningful |
| Pharmacist → Dispense | No `dispensedAt` / `dispensedById` on `Prescription`; the "can't edit after dispensed" rule has nothing to check |
| Billing → Payments | `Payment` model. `Invoice.status` has `PARTIALLY_PAID` but nothing records partial amounts |
| Receptionist → Patient insurance | No insurance fields on `Patient` |
| Doctor → allergies | No allergy field or model — referenced in the dashboard above and clinically important |
| Patient portal | `UserRole` has no `PATIENT`; `User` has no link to `Patient` |
