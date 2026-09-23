import { Request } from 'express';

/**
 * Works out *which record* a request touched, for the audit trail.
 *
 * This is the field that turns a log into an investigation tool. "Reception was
 * denied something" is nearly useless; "reception was denied patient #412, six
 * times, in ninety seconds" is the whole point of keeping the trail.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED
 * -------------------------------------
 * `AuditInterceptor` (successes) and `AllExceptionsFilter` (failures) each held
 * their own identical copy. Identical is how they started; drift is what
 * happens next, and the halves would disagree about the same request depending
 * on whether it succeeded. One function, two callers.
 *
 * WHY IT READS PARAM NAMES AND NOT JUST `id`
 * ------------------------------------------
 * Both copies read `req.params.id` and inferred the type from the path. That
 * silently produced *no target at all* for every nested route, because those
 * are declared `patients/:patientId/records`, not `:id` — so exactly the
 * clinical endpoints, the ones where "which patient" matters most, recorded
 * nothing. A live run showed it: four 403 rows against patient routes, every
 * one with `target=-`.
 *
 * The unit test missed it by building a request with `params: { id: '1' }` —
 * a shape the router never actually produces for those routes. A fixture that
 * doesn't match reality tests the fixture.
 */

/** Param name → what it identifies. Path-independent, so nesting cannot break it. */
const BY_PARAM: ReadonlyArray<readonly [string, string]> = [
  // patientId wins when present: on a nested clinical route the patient is the
  // subject of the access, whatever sub-resource was being read or written.
  ['patientId', 'Patient'],
  ['admissionId', 'Admission'],
  ['wardId', 'Ward'],
  // `/wards/beds/:bedId` — the bed is the subject, not the ward it sits in.
  // Declared as its own param rather than `:id` precisely so the nesting
  // cannot make it resolve to a Ward, which is the mistake this file exists
  // to stop repeating.
  ['bedId', 'Bed'],
  ['itemId', 'MedicineItem'],
  /*
   * The *other* hospital, on a monthly statement.
   *
   * A statement names a counterparty rather than a record of our own, and both
   * sides of it are worth recording: "who at this laboratory printed, or
   * emailed, a statement for which hospital" and "who here marked a whole month
   * of one laboratory's charges settled" are each a question somebody asks
   * afterwards, and neither is answerable from the action alone.
   *
   * Declared as their own param names rather than `:id` for the same reason
   * `bedId` is — so the path nesting cannot make them resolve to a LabOrder or
   * a LabPartner, which is the mistake this whole file exists to stop repeating.
   * Last in the list, so a route carrying a patient still records the patient.
   */
  ['sourceTenantId', 'Tenant'],
  ['partnerTenantId', 'Tenant'],
];

/**
 * For `:id`, the resource is whatever the route is mounted on.
 *
 * Order matters — first match wins, so more specific prefixes go first.
 * `/medications/doses/:id` must not be read as `/medications`.
 */
const BY_PATH: ReadonlyArray<readonly [string, string]> = [
  // Vendor routes first — they are the most specific prefixes here, and a
  // denial on one is a security event about a hospital's data even though no
  // hospital user was involved.
  ['/platform/break-glass', 'BreakGlassGrant'],
  // Before '/platform/tenants', because approving an application creates a
  // tenant and the row being acted on is still the application. Ordering in
  // this list is significant — the first matching segment wins.
  ['/platform/applications', 'TenantApplication'],
  ['/platform/tenants', 'Tenant'],
  // Before '/pharmacy', because '/pharmacy/referrals/:id' is a referral rather
  // than anything of this pharmacy's own. Ordering in this list is significant:
  // the first matching segment wins.
  ['/pharmacy/referrals', 'PrescriptionReferral'],
  // Before '/pharmacy': a reversal acts on the dispense event, not on this
  // pharmacy's own id space. Ordering in this list is significant.
  ['/pharmacy/dispense-events', 'DispenseEvent'],
  ['/pharmacy-partners', 'PharmacyPartner'],
  ['/tax-rates', 'TaxRate'],
  // Before '/medication-requests' would ever be reached by a looser match, and
  // before '/medications': these are requests for a prescriber to act on, not
  // administrations.
  // Before '/escalations' could be caught by anything looser.
  ['/escalations', 'ObservationEscalation'],
  /*
   * Printing. The target is the document's subject, not "a document" — "who
   * printed prescription #412, and when" is the question a dispute starts
   * with, and a printed copy is the most complete form of the record there is.
   *
   * These sit before the bare '/prescriptions' and '/invoices' entries because
   * the first matching segment wins and '/documents/...' is the longer prefix.
   */
  ['/documents/prescriptions', 'Prescription'],
  ['/documents/invoices', 'Invoice'],
  ['/documents/records', 'MedicalRecord'],
  ['/documents/lab-orders', 'LabOrder'],
  /*
   * Diagnostics. Thirteen id-bearing routes arrived with the lab and none of
   * them resolved, so every denial on one recorded `target=-` — the exact bug a
   * live run found in Phase 6, arriving again in a new module because nothing
   * about adding a controller forces anybody to think about this file.
   *
   * `audit-target.spec.ts` derives its cases by parsing route paths out of the
   * controllers, so it caught all thirteen the first time it was able to run.
   *
   * Ordering matters as everywhere else here: the longer '/lab/...' prefixes
   * come before the bare '/lab-orders', and a referral is its own row rather
   * than an order of this hospital's.
   */
  ['/lab/referrals', 'LabReferral'],
  ['/lab/attachments', 'LabAttachment'],
  // `/lab/orders/:id/...` — collect, reject, verify and the attachment list all
  // act on the order, which is the row a reviewer asks about.
  ['/lab/orders', 'LabOrder'],
  ['/lab/invoices', 'Invoice'],
  ['/lab-partners', 'LabPartner'],
  ['/lab-orders', 'LabOrder'],
  ['/lab-tests', 'LabTest'],
  ['/supply-requests', 'SupplyRequest'],
  ['/medication-requests', 'MedicationRequest'],
  ['/medications/doses', 'MedicationAdministration'],
  ['/patients', 'Patient'],
  ['/appointments', 'Appointment'],
  ['/prescriptions', 'Prescription'],
  ['/invoices', 'Invoice'],
  ['/admissions', 'Admission'],
  ['/wards', 'Ward'],
  ['/medicines', 'Medicine'],
  ['/medications', 'MedicationAdministration'],
  ['/vitals', 'Vital'],
  ['/departments', 'Department'],
  ['/doctors', 'Doctor'],
  ['/devices', 'Device'],
  ['/users', 'User'],
];

export interface AuditTarget {
  targetType: string | null;
  targetId: number | null;
}

const NO_TARGET: AuditTarget = { targetType: null, targetId: null };

export function resolveAuditTarget(req: Request): AuditTarget {
  const params = (req.params ?? {}) as Record<string, string | undefined>;

  for (const [param, type] of BY_PARAM) {
    const id = toId(params[param]);
    if (id !== null) return { targetType: type, targetId: id };
  }

  const id = toId(params.id);
  if (id === null) return NO_TARGET;

  const path = req.route?.path ?? req.path ?? '';
  for (const [segment, type] of BY_PATH) {
    if (path.includes(segment)) return { targetType: type, targetId: id };
  }
  return NO_TARGET;
}

/**
 * Ids are positive integers. `Number('')` is 0 and `Number(undefined)` is NaN,
 * so both are rejected rather than recorded as a target that does not exist.
 */
function toId(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * On a failed login there is no authenticated user, so the address that was
 * tried is the only identifier available — and repeated failures against a real
 * account are precisely the row worth keeping.
 *
 * The password is never read. Truncated because the column is bounded and an
 * over-long body should not be able to fail the audit write.
 */
export function attemptedEmail(req: Request): string | null {
  if (!req.path?.endsWith('/auth/login')) return null;
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.slice(0, 255) : null;
}
