import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The two clients must agree on what the API returns.
 *
 * `mobile/lib/types.ts` is a copy of the shapes in `web/lib/types.ts` — see
 * the header of that file for why it is a copy and not yet a shared package.
 * A copy is only defensible with something enforcing that it stays a copy;
 * otherwise it is exactly the drift the single-backend decision exists to
 * prevent, just slower and harder to spot.
 *
 * If this fails, do not edit mobile's file to match. Change web's (the source
 * of truth) and re-copy, or the next divergence goes the other way.
 */

const WEB_TYPES = path.resolve(__dirname, '../../web/lib/types.ts');
const MOBILE_TYPES = path.resolve(__dirname, './types.ts');

/** Pulls a named `export interface X { ... }` or `export type X = ...;` block. */
function extract(source: string, name: string): string | null {
  // The optional `<...>` matters: `Paginated<T>` is shared like anything else,
  // and a matcher that silently cannot see generic declarations reports them as
  // missing from *both* clients — which reads as a drift failure and is really
  // a broken extractor.
  const iface = new RegExp(`^export interface ${name}(?:<[^>]*>)? \\{`, 'm').exec(source);
  if (iface) {
    const start = source.indexOf('{', iface.index);
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return source.slice(iface.index, i + 1);
      }
    }
    return null;
  }
  const alias = new RegExp(`^export type ${name} =[\\s\\S]*?;`, 'm').exec(source);
  return alias ? alias[0] : null;
}

/** Comments and whitespace may differ; the declaration itself may not. */
function normalise(block: string): string {
  return block
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SHARED = [
  'UserRole',
  'AppointmentStatus',
  'AllergySeverity',
  'AuthUser',
  'Allergy',
  'Patient',
  'QueueItem',
  'DoctorQueue',
  'MedicalRecord',
  'PrescriptionItem',
  'Prescription',
  'DoseStatus',
  'VitalFlag',
  'Vital',
  'BedRow',
  'WardBoard',
  'Dose',
  'MedicationRound',
  'Ward',
  'DrugClass',
  'Medicine',
  'StockBatchView',
  'DispenseQueueItem',
  'InventoryRow',
  'Inventory',
  'AdminDashboard',
  // Reception and billing, added when mobile was opened to every role.
  'PatientListItem',
  'Doctor',
  'Appointment',
  'Slot',
  'Availability',
  'Paginated',
  'AgingBucket',
  'PaymentMethod',
  'InvoiceLine',
  'PaymentRecord',
  'Invoice',
  // Admin reporting, added when the overview gained takings and per-doctor
  // figures. `AgingReport` comes along because `FinanceReport` names it — a
  // shape is only pinned if everything it references is pinned too.
  // Staff and role assignment, added when the phone gained the roles screen.
  'StaffUser',
  /*
   * The owner's daily view and its drill-down.
   *
   * `AuditRow` was here and is not any more: the phone's activity screen used
   * to open a person's audit trail, and that was removed for being a list of
   * API action names rather than a description of anybody's work. Mobile is
   * allowed to carry a subset, so the type went with the screen rather than
   * lingering as a shape nothing reads.
   */
  'StaffActivityReport',
  'LedgerRow',
  'ConsultationLedger',
  'AgingReport',
  'FinanceReport',
  'DoctorReportRow',
  'DoctorReport',
];

describe('web ↔ mobile type drift', () => {
  const web = readFileSync(WEB_TYPES, 'utf8');
  const mobile = readFileSync(MOBILE_TYPES, 'utf8');

  it.each(SHARED)('%s is declared in both clients', (name) => {
    expect(extract(web, name)).not.toBeNull();
    expect(extract(mobile, name)).not.toBeNull();
  });

  it.each(SHARED)('%s is identical in both clients', (name) => {
    const webBlock = extract(web, name);
    const mobileBlock = extract(mobile, name);
    expect(normalise(mobileBlock ?? '<missing from mobile>')).toBe(
      normalise(webBlock ?? '<missing from web>'),
    );
  });

  it('mobile defines no type the web client does not', () => {
    // Mobile is allowed to carry a subset — it has no need for Invoice or
    // Availability. It is not allowed to invent its own idea of a shape.
    const declared = [...mobile.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
    const extra = declared.filter((name) => !extract(web, name));
    expect(extra).toEqual([]);
  });

  it('points at the real web types file', () => {
    // Guards against the test quietly passing because the path went stale.
    expect(web).toContain('export interface AuthUser');
  });
});
