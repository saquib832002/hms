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
  ['itemId', 'MedicineItem'],
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
  ['/platform/tenants', 'Tenant'],
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
