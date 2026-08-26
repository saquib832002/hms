# UI / UX Design

Web and mobile design for the HMS. Clickable wireframes: [`wireframes.html`](wireframes.html). Per-role navigation: [`role-navigation.md`](role-navigation.md).

---

## 1. Design principles

**This is a tool, not a website.** Staff spend eight-hour shifts here. Optimise for the hundredth repetition, not the first impression.

1. **Density over whitespace.** A patient list shows 20 rows, not 6 cards. Marketing-site spacing wastes the screen these people work on all day.
2. **Never lose context.** Selecting a patient updates a detail panel; it does not navigate away and back.
3. **The keyboard is the primary input** for receptionists and billing staff. Every repeated action needs a shortcut.
4. **Safety-critical information is never behind a tab.** Allergies, in particular, are always visible on any patient view.
5. **Destructive and clinical actions state their consequence.** "Issue prescription — this cannot be edited after dispensing", not "Submit".
6. **Loading states are skeletons, not spinners.** Layout shouldn't jump; staff aim at where a button was.
7. **Non-production builds carry a loud banner.** Dummy data must never be mistaken for real patient data.

---

## 2. Design tokens

```css
/* Neutrals — the UI is mostly grey; colour is reserved for meaning */
--bg:            #f7f8fa;   --surface:       #ffffff;
--border:        #e3e6ea;   --border-strong: #cfd4da;
--text:          #14181d;   --text-muted:    #5b6672;
--text-subtle:   #8a939e;

/* Brand — calm medical blue, used sparingly */
--primary:       #1e6fd9;   --primary-hover: #1a5fb8;
--primary-soft:  #e8f1fd;

/* Semantic — these carry clinical meaning, never decoration */
--success:       #1a7f47;   --success-soft: #e6f4ec;   /* completed, in stock, paid */
--warning:       #b06f00;   --warning-soft: #fdf3e2;   /* waiting, due soon, low stock */
--danger:        #c0392b;   --danger-soft:  #fdecea;   /* allergy, overdue, critical */
--info:          #1e6fd9;   --info-soft:    #e8f1fd;   /* in progress, scheduled */

--radius: 6px;   --radius-sm: 4px;
--font: 'Inter', system-ui, sans-serif;
--mono: 'JetBrains Mono', ui-monospace, monospace;   /* IDs, dosages, vitals */
```

**Type scale:** 12 / 13 / 14 / 16 / 20 / 24 px. Body text is **13px**, not 16 — this is a dense data tool, and 16px body wastes a third of a patient list. Tables use 13px; the 8px grid governs spacing.

**Colour discipline:** semantic colours mean exactly one thing each. Green is never "brand green" somewhere and "completed" elsewhere. In a clinical UI, colour ambiguity is a safety problem.

**Accessibility:** all text meets WCAG AA (4.5:1). Status is never conveyed by colour alone — every status chip has a label, and critical flags have an icon. Roughly 1 in 12 men has some colour vision deficiency; hospital staff are not exempt.

---

## 3. Web layout

```
┌──────────┬─────────────────────────────────────────────────────────┐
│          │  TOPBAR  56px   title · ⌘K search · alerts · user menu  │
│ SIDEBAR  ├─────────────────────────────────────────────────────────┤
│  240px   │  STAT STRIP (optional)  48px                            │
│          ├──────────────────────┬──────────────────────────────────┤
│  fixed   │  LIST PANE           │  DETAIL PANE                     │
│          │  360–420px           │  fills remaining                 │
│  role-   │  scrolls             │  scrolls independently           │
│  derived │                      │                                  │
└──────────┴──────────────────────┴──────────────────────────────────┘
```

- **Sidebar** — fixed 240px, collapsible to 56px icons. Built from `GET /auth/me`, never a client-side role constant.
- **Two-pane** is the default for any list-plus-detail screen. Selection updates the URL (`/patients?id=12`) so views stay linkable and the back button behaves.
- **Breakpoints:** ≥1440px full two-pane; 1024–1439px narrower list pane; <1024px single pane with drill-down. **The web app does not target phones** — that's what the mobile app is for. A tablet at 1024px is the realistic floor.

### Component inventory (shadcn/ui)

`DataTable` (sortable, sticky header, keyboard nav, density toggle) · `StatusChip` · `PatientHeader` (name, age, gender, blood group, **allergy banner**) · `SplitPane` · `CommandPalette` (⌘K) · `FormSheet` (side-sheet forms — dialogs are too small for clinical forms) · `ConfirmDialog` (consequence-stating) · `Timeline` (visit history) · `EmptyState` · `Skeleton` · `AuditTrail`

### Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Global patient search |
| `j` / `k` | Move down / up a list |
| `Enter` | Open selected |
| `Esc` | Close panel or sheet |
| `g` then `q`/`p`/`a` | Go to Queue / Patients / Appointments |
| `n` | New (context-dependent) |
| `?` | Shortcut cheatsheet |

⌘K is the single highest-value component in the product. Receptionists and doctors look up patients dozens of times a day; every other path to a patient is slower.

---

## 4. Web screens — Phase 1

### Doctor — Today's Queue *(landing)*

```
┌────────────┬──────────────────────────────────────────────────────┐
│            │  Today's Queue · Wed 12 Aug      [⌘K]  [🔔]  [DR]    │
│  SIDEBAR   ├──────────────────────────────────────────────────────┤
│            │  12 scheduled   3 waiting   1 in progress   8 done   │
│ ▸ Queue ●  ├───────────────────────┬──────────────────────────────┤
│ ▸ Appts    │  09:00  A. Khan  ✓in  │  Anwar Khan                  │
│ ▸ Patients │  09:30  M. Rao   ✓in  │  47y · Male · B+ · #10241    │
│ ▸ Rx       │  10:00  S. Patel ●now │  ⚠ ALLERGY: Penicillin (sev) │
│ ▸ Records  │  10:30  J. Silva      │  ──────────────────────────  │
│            │  11:00  R. Nair       │  Overview │ Records │ Rx     │
│            │                       │                              │
│            │                       │  Reason    Follow-up, HTN    │
│            │                       │  Last seen 12 Jun 2026       │
│            │                       │  Active Rx Amlodipine 5mg OD │
│            │                       │  Vitals    138/86 · 78bpm    │
│            │                       │                              │
│            │                       │  [Start Consult] [Write Rx]  │
└────────────┴───────────────────────┴──────────────────────────────┘
```

The allergy banner sits directly under the patient name in `--danger-soft` with a red left border. It is never collapsed, never behind a tab, and appears on every patient view in the system.

### Doctor — Write Prescription

Side sheet, not a dialog. Patient header and allergy banner pinned at the top so they stay visible while prescribing.

- Medicine rows: name (autocomplete, becomes `Medicine` FK in Phase 4) · dosage · frequency · duration
- `+ Add medicine` for multiple items
- **Allergy cross-check warning** if a prescribed drug matches a recorded allergy — a warning at Phase 1, a hard block once the `Medicine` catalogue exists in Phase 4
- Footer states the consequence: *"Issue prescription — cannot be edited once dispensed."*

### Receptionist — Check-in Queue *(landing)*

Full-width table, no detail pane — this is a scanning-and-acting screen.

| Time | Patient | Doctor | Status | Actions |
|---|---|---|---|---|
| 09:00 | Anwar Khan | Dr. Rao | `CHECKED IN` | — |
| 10:00 | Sara Patel | Dr. Iqbal | `SCHEDULED` | **Check in** · No-show |

One click per row, no dialogs. `j`/`k` + `Enter` for keyboard operation.

### Receptionist — Patient Registration

Side sheet, single column, ~10 fields grouped: Identity (name, DOB, gender) · Contact (phone, email, address) · Emergency contact · Blood group.

**Duplicate detection is essential.** On name or phone blur, search and surface possible matches inline — *"3 patients named Anwar Khan. Is this one of them?"*. Duplicate patient records are one of the most common and most damaging data problems in hospital systems, because clinical history silently splits across two records.

### Receptionist — Patients

Demographics only. No clinical tabs — not disabled, **absent**, and absent from the API response too.

---

## 5. Mobile design

### Principles

**Task parity, not feature parity.** Mobile answers: *what's next, what do I need to know right now, and what can I record without sitting down?*

1. **One-handed operation.** Primary actions in the bottom third — staff carry things.
2. **Large touch targets** (min 44pt). Gloves, hurry, motion.
3. **Offline-tolerant reads.** Hospital wifi is unreliable. Cache the queue; show a clear stale-data indicator with timestamp. Writes queue and retry.
4. **No PHI in push notifications or on the lock screen.**
5. **Aggressive session timeout.** A phone left on a ward bed is a breach. 15 minutes idle → biometric re-auth.
6. **Large, legible vitals input.** Number pads, not tiny text fields.

### Navigation

Bottom tab bar, 3–4 tabs, role-derived.

```
DOCTOR      [ Queue ]  [ Patients ]  [ Alerts ]  [ Me ]
NURSE       [ Ward ]   [ Vitals ]    [ Meds ]    [ Me ]
PHARMACIST  [ Queue ]  [ Alerts ]    [ Me ]
ADMIN       [ Dashboard ]  [ Me ]                          (read-only KPIs)
```

Receptionist and billing have no mobile app — their work is desk-bound, and building it would be effort spent where nobody works.

### Key screens

**Doctor — Queue** *(landing)* — stat row, then appointment cards: time, patient name, age/gender, status chip, red allergy dot if flagged. Tap → patient summary. Pull to refresh.

**Doctor — Patient summary** — read-only. Name, age, allergy banner, active medications, last visit, recent vitals. Two actions at the bottom: `Write Prescription`, `View Records`. Deliberately not the full history — that's a web task.

**Nurse — Vitals entry** — the most-used mobile screen in the system. Large number pads, one field at a time, auto-advance. Out-of-range values highlight immediately on entry. Save is a single large bottom button. Must work offline and sync later.

**Nurse — Medication due list** — grouped Overdue / Due now / Upcoming. Swipe right to mark given, tap for detail. Overdue in `--danger`.

---

## 6. Print

Underrated and genuinely required. Prescriptions get printed and handed to patients; invoices get printed.

- Dedicated print stylesheet — no sidebar, no chrome
- Prescription: hospital header, patient identifiers, doctor name and registration number, medicines table, date, signature block
- A4 default, thermal-friendly narrow variant for receipts
- Rendered server-side (`GET /prescriptions/:id/print`) so web and mobile produce byte-identical output

---

## 7. Empty, loading, and error states

Every list needs all three designed, not defaulted:

| State | Treatment |
|---|---|
| Empty | Explain and offer the action — *"No appointments today. [Book one]"* |
| Loading | Skeleton rows matching final layout. Never a centred spinner on a table. |
| Error | What failed and what to do. *"Couldn't load the queue. [Retry]"* — never a raw status code, never a stack trace. |
| Offline (mobile) | Persistent banner: *"Offline — showing data from 09:42. Changes will sync."* |
| Forbidden | *"You don't have access to this."* — no hint about what the data contains. |

---

## 8. Build order

Match [`PLAN.md`](../PLAN.md) Phase 1:

1. Design tokens + Tailwind theme
2. App shell — sidebar, topbar, role-derived nav from `GET /auth/me`
3. `DataTable` + `SplitPane` — every screen depends on these
4. `PatientHeader` + allergy banner
5. Login and role-based redirect
6. Receptionist screens (simpler, and proves role-shaped responses end to end)
7. Doctor queue and consult flow
8. ⌘K command palette
9. Print stylesheet

Receptionist before doctor is deliberate: those screens are the strictest test that role-shaped API responses actually work, and finding a leak there is far cheaper than finding it after the clinical UI is built on top of it.
