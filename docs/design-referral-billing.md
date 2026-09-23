# Design — who pays for referred lab work

**Status: proposal. Nothing here is built.**

## The thing to look at first

The premise of the request is that today the referring hospital pays. Half of
that is true, and the other half is a hole:

| | Referring hospital | Performing lab |
|---|---|---|
| Charges the patient | **nothing** | — |
| Is charged | by the lab, on accept | — |

`LabService.create` charges only `IN_HOUSE` orders:

```ts
destination === LabOrderDestination.IN_HOUSE
  ? await this.chargeOrder(tx, created.id, dto.patientId, created.items, tax)
  : { invoiceId: null, unpriced: [] }
```

and `LabOrder.invoiceId` says so in as many words — *"Null for a partner or
external order, which this hospital does not bill for."*

So a clinic that sends a test to a partner **raises no charge against the
patient and receives an invoice from the lab**. Every partner referral is a
straight loss, silently, and nothing on any screen says so. It is the same
shape as the unpriced dispense this codebase surfaces daily, except that it is
not surfaced anywhere — no screen lists another company's debts, and no screen
lists tests the hospital declined to charge for.

That has to be fixed whichever way this goes, and it is most of the work. The
two-way switch the request asks for is the smaller half.

## Two modes, named from who pays the lab

```
ReferralBilling
  ORIGIN_PAYS    the referring hospital settles with the lab,
                 and recovers it from the patient itself
  PATIENT_PAYS   the patient settles at the lab counter,
                 and the referring hospital charges nothing
```

Both are ordinary. `ORIGIN_PAYS` is the reference-laboratory contract — the
patient never learns the lab was involved, the lab bills the institution,
usually at a rate below its retail one. `PATIENT_PAYS` is the requisition
model: the clinic writes the request, the patient walks into the diagnostic
centre, pays the counter price, gives blood there.

The difference is not only the debtor. It changes **where the patient
physically is**, and therefore when work can start — which is why this is a
mode rather than a flag on an invoice.

```
ORIGIN_PAYS                              PATIENT_PAYS

  Patient                                  Patient
     │ pays ①                                 │
     ▼                                        │ walks in ②
┌────────────┐   referral   ┌──────┐          │
│  Hospital  │ ───────────► │ Lab  │      ┌────────────┐   referral   ┌──────┐
│            │ ◄─────────── │      │      │  Hospital  │ ───────────► │ Lab  │
└────────────┘   invoice ②  └──────┘      │            │ ◄─────────── │      │
                  result                  └────────────┘    result    └──────┘
                                            charges                      ▲
  ① invoice at ordering, retail               nothing                    │
  ② invoice at accession, to the hospital                          pays ① at
     Invoice.patientId = null                                       collection
                                                              Invoice.patientId
                                                                  = the patient
```

Note the ordering flips. Under `ORIGIN_PAYS` the patient is billed first, at
the hospital, and the lab's invoice is raised at accession against an
institution that is not standing there. Under `PATIENT_PAYS` nothing is billed
until the patient arrives at the lab, which is also the moment the specimen is
taken — so **collection is the natural place to surface the unpaid invoice**,
not accession.

## Where the setting lives

**On the partnership, not on either tenant.** `LabPartner.billing`.

A tenant-level setting is the obvious cheap answer and it is wrong: the same
laboratory routinely holds a wholesale contract with a hospital group and takes
walk-in referrals from a single-doctor clinic down the road. One lab, two
commercial relationships, and a tenant field cannot express that.

It has to be known **at ordering time on the sending side**, because that is
when the sending hospital decides whether to charge the patient. Resolving it
only at accession would mean the referring hospital had already billed, or
already failed to bill, before anyone knew which was correct.

### The receiving lab must agree, so it is a two-sided handshake

Same shape as the pharmacy handshake (`acceptsExternalPrescriptions` plus a
partner row) and for the same reason — one side alone must not be able to
decide.

```
Tenant.acceptedReferralBilling  ReferralBilling[]  @default([ORIGIN_PAYS])
```

on the **receiving** lab, beside `acceptsExternalLabOrders`. The partner lookup
returns it, and the sending hospital may only pick a mode that is in that set.
A lab that will not chase individual patients declares `[ORIGIN_PAYS]` and
cannot be handed the job; a lab with no account-receivable function declares
`[PATIENT_PAYS]` and cannot be handed an institutional debt.

Deliberately an array, not a single value, for the reason `Tenant.modules` is:
a lab that does both is the common case, and two booleans would be two places
to forget.

### The mode is captured on the referral

```
LabReferral.billing  ReferralBilling
```

Snapshot, exactly as `PrescriptionReferralItem` captures the medicine as text
and `DispenseLine` captures `unitPrice`. Renegotiating the contract next
quarter must not restate who owed what for work already sent. Every read at the
receiving end uses the referral's value and never the partner row — which is a
thing worth asserting, because reaching for the partner row is one line shorter
and there is no partner row on the receiving side anyway.

## The distinctions that must not collapse

**`payableAtLab` is not `unpriced`.** Under `PATIENT_PAYS` the sending hospital
raises no line for that test, and every "tests that went out uncharged" figure
in this system would then scream about it forever — the pharmacy and lab
dashboards, the admin overview, the accession notice. A test nobody priced and
a test somebody else is charging for are opposite facts, and this codebase has
already made this exact mistake twice (`Medicine.sellingPrice`,
`Doctor.consultationFee): blank is not zero, and here *not ours to charge* is
not *nobody charged*. It needs its own field on the order item response and its
own words on screen.

**Payment still gates nothing.** `PATIENT_PAYS` makes it tempting to refuse
collection, or to withhold the report, until the invoice is settled — and that
is exactly the gate `lab-billing.spec.ts` and `consultation-billing.spec.ts`
assert the absence of. A patient who has given blood has given blood. The
invoice sits outstanding on the lab's till like any other and the result is
released on verification regardless. The new paths need the same absence
assertion, because the argument for adding it here is more plausible than it
has been anywhere else in this system.

**Reject and decline are unaffected.** A rejected specimen still returns the
order to a collectable state and still means *take another sample*, whoever is
paying. Under `PATIENT_PAYS` that means asking the patient back — which is a
reason to make sure the reject reason travels, not a reason to change the
state machine.

**Referred work still never joins the patient's hospital invoice**, even under
`PATIENT_PAYS` at a COMBINED tenant. `COMBINED` means one balance to settle at
*this* hospital; the lab's charge is another company's.

## What changes

### Backend

| File | Change |
|---|---|
| `prisma/schema.prisma` | `enum ReferralBilling`; `LabPartner.billing` (default `ORIGIN_PAYS`); `Tenant.acceptedReferralBilling ReferralBilling[]`; `LabReferral.billing`; `LabOrderItem.payableExternally Boolean @default(false)` |
| `prisma/migrations/…_referral_billing/` | Hand-written, as the thirteen before it. Uses `CREATE TYPE`; no new tables, so **`npm run db:rls` is not required** |
| `lab.service.ts` — `create` | Charge `PARTNER` orders under `ORIGIN_PAYS` (the hole above). Under `PATIENT_PAYS` charge nothing and set `payableExternally` |
| `lab.service.ts` — `chargeReferredOrder` | Take the referral's `billing`; pass the patient id under `PATIENT_PAYS` and null under `ORIGIN_PAYS`. `payerNote` only in the latter |
| `lab-referral.service.ts` — `transmit` | Resolve the partner's mode, refuse one the receiver has not declared, capture it on the referral |
| `lab-referral.service.ts` — `accept` | Unchanged except for which payer it charges — the state machine does not branch |
| `lab-partners.controller.ts` | `PATCH /lab/partners/:id` to change the mode; lookup response gains the accepted set |
| `clinic-settings` | `acceptedReferralBilling` in the DTO, the service and the response |
| `lab-response.ts` / `invoice-response.ts` | Surface `payableExternally` and the payer; no drug/test name rules change |

### Web

- Partner labs settings — a mode per partner, offering only what that lab accepts, with the reason shown when a mode is unavailable (an option hidden is a feature that looks absent — the mistake the pharmacy handshake made).
- Clinic settings — `acceptedReferralBilling` for a lab that takes external work. `settings-reachable.spec.ts` will require the screen to *send* it.
- Order sheet / patient record — *payable at the laboratory* against those items, distinct from *not priced*.
- Lab incoming — the accession notice names the payer; redirect to the till only under `ORIGIN_PAYS`.
- Lab collection — surface the patient's unpaid invoice at the moment they are standing there.

### Mobile

Same five, per the standing both-clients rule. The partner-mode picker and the
clinic setting are one field each and do not want a desk.

### Tests

- `referral-billing.spec.ts` (new) — exactly one payer per referral in each mode; `ORIGIN_PAYS` invoice carries a null patient and a payer note, `PATIENT_PAYS` carries the patient and none; a mode outside the receiver's set is refused at send; the mode is read from the referral and never from the partner row.
- `lab-billing.spec.ts` — extend the absence assertions to the new paths.
- `schema-drift.spec.ts`, `settings-reachable.spec.ts`, `endpoint-coverage.spec.ts`, `screen-parity.spec.ts` — all will fail until the above is complete, which is the intent.

## Deliberately out of scope

- **Contract pricing.** A reference lab charges an institution less than its counter price, and `LabTest.sellingPrice` is retail. `LabOrderItem.unitPrice` is already captured at accession, so a per-partner rate can be added later without restating history. Half-building it would mean a discount field nobody could explain.
- **Split billing** — the clinic keeps a collection fee, the lab bills the patient for the test. Real, and it needs two invoices for one referral, which is a different data shape rather than a third enum member.
- **Settlement between tenants.** The lab's invoice to a hospital is a row in the lab's ledger and nothing in the hospital's. Neither party sees the other's balance, and reconciliation is a telephone call. Making it two-sided means a hospital writing into a lab's rows, which is the blast radius the prescription referral was deliberately kept out of.
- **Expiry.** Under `PATIENT_PAYS` a patient who never turns up leaves a referral open indefinitely. Already a known gap; this makes it commoner rather than new.
