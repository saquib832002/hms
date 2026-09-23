import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NEVER_TRANSMITTED, generateReference, toReferralPayload } from './referral';

/**
 * The first feature that deliberately moves patient data between tenants.
 *
 * WHY THIS FILE MATTERS MORE THAN MOST
 * ------------------------------------
 * Every isolation guarantee rests on one property: a row belongs to exactly one
 * hospital and the *database* decides who sees it. An unfiltered
 * `patient.count()` returns 40 where the owner sees 80, because the policy — not
 * the query — is the boundary.
 *
 * Routing a prescription to another hospital's pharmacy had two possible
 * implementations. The rejected one added a policy exception so a prescription
 * tagged for hospital B became visible to B: one line of SQL, and afterwards
 * `tenantId = app_current_tenant()` is no longer the whole truth. Every future
 * reader of that policy has to know about the carve-out, and the first mistake
 * in it is a cross-hospital breach.
 *
 * So a copy is transmitted instead. These tests exist to stop that decision
 * being quietly reversed by somebody who finds the copy inconvenient.
 */

const SERVICE = readFileSync(resolve(__dirname, './prescriptions.service.ts'), 'utf8');
const SCHEMA = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
const RLS = readFileSync(resolve(__dirname, '../../prisma/rls/tenant-isolation.sql'), 'utf8');
const PARTNERS = readFileSync(resolve(__dirname, '../pharmacy/partners.controller.ts'), 'utf8');

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function transmitBody(): string {
  const start = SERVICE.indexOf('private async transmitReferral(');
  expect(start).toBeGreaterThan(-1);
  return strip(SERVICE.slice(start, SERVICE.indexOf('\n  async create(', start)));
}

describe('the copy, not the carve-out', () => {
  it('adds no cross-tenant exception to any policy', () => {
    /*
     * The assertion the whole design exists to make true. Every scoped table,
     * including the two new ones, gets the same `tenantId = app_current_tenant()`
     * policy — there is no `OR routedToTenantId = ...` anywhere.
     */
    expect(RLS).not.toMatch(/routedToTenantId/);

    /*
     * The generic policy's READ predicate is exactly one equality, with no
     * alternative. Asserted on `USING` specifically rather than on the whole
     * file, because `audit_logs` legitimately widens its *WITH CHECK* to allow
     * a NULL tenant — an anonymous failed login belongs to no hospital and is
     * one of the most useful rows in that table. Widening a `USING` is what
     * would let one hospital read another's data; widening a `WITH CHECK` only
     * affects what may be written.
     */
    const loop = RLS.slice(RLS.indexOf('scoped text[]'), RLS.indexOf('audit_logs ENABLE'));
    const usingClauses = loop.match(/USING \([^)]*\)/g) ?? [];
    expect(usingClauses.length).toBeGreaterThan(0);
    for (const clause of usingClauses) {
      expect(clause).toContain('app_current_tenant()');
      expect(clause).not.toMatch(/\bOR\b/i);
    }
  });

  it('scopes the referral tables like everything else', () => {
    for (const table of [
      'pharmacy_partners',
      'prescription_referrals',
      'prescription_referral_items',
    ]) {
      expect(RLS).toContain(`'${table}'`);
    }
  });

  it('writes into the receiving tenant’s scope, not the sender’s', () => {
    /*
     * `forTenant` opens a transaction with `app.tenant_id` set to the
     * destination, so the rows land under *their* policy and are theirs from
     * the moment they exist. Writing them from the sender's scope would fail
     * the WITH CHECK — the same way provisioning failed on its first live run,
     * for the same reason.
     */
    const body = transmitBody();
    expect(body).toMatch(/forTenant\(\s*partner\.partnerTenantId/);
  });

  it('is a snapshot, never a live read of the source', () => {
    // A later edit at the prescribing hospital must not silently change what
    // another company is about to hand a patient. Same reasoning as
    // `DispenseLine.unitPrice` and `PrescriptionItem.medicineName`.
    expect(SCHEMA).toContain('model PrescriptionReferralItem');
    const model = SCHEMA.slice(SCHEMA.indexOf('model PrescriptionReferralItem'));
    expect(model.slice(0, model.indexOf('}'))).not.toContain('medicineId');
  });
});

describe('what crosses the boundary', () => {
  const payload = toReferralPayload({
    patient: { fullName: 'Asha Rao', dob: new Date('1980-04-02') },
    doctor: { fullName: 'Dr Chen', registrationNo: 'GMC123' },
    issuedAt: new Date('2026-09-01T10:00:00Z'),
    items: [
      { medicineName: 'Amoxicillin 500mg', dosage: '1 cap', frequency: 'TDS', duration: '7 days' },
    ],
  });

  it('carries only what a pharmacy needs to dispense', () => {
    expect(Object.keys(payload).sort()).toEqual(
      ['issuedAt', 'items', 'patientDob', 'patientName', 'prescriberName', 'prescriberRegistrationNo'].sort(),
    );
  });

  it('carries no clinical context at all', () => {
    /*
     * Asserted on the serialised body rather than field by field, so a later
     * `reason` or `notes` "for the pharmacist's convenience" fails here rather
     * than shipping. Minimum-necessary applies at least as strongly across a
     * company boundary as across a role one — the receiving hospital is not
     * bound by this one's policies at all.
     */
    const body = JSON.stringify(payload).toLowerCase();
    for (const forbidden of NEVER_TRANSMITTED) {
      expect(body).not.toContain(forbidden.toLowerCase());
    }
  });

  it('names allergies as something deliberately withheld', () => {
    // On the list, and the list is data so it can be asserted. The consequence
    // — no allergy check is possible at the far end — is stated to the
    // receiving pharmacist rather than left to be inferred from silence.
    expect(NEVER_TRANSMITTED).toContain('allergies');
  });

  it('builds the payload from an allowlist, not a spread', () => {
    const src = readFileSync(resolve(__dirname, './referral.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function toReferralPayload'));
    // A spread passes every "does it contain X" check while silently carrying
    // the next field somebody adds to the model.
    expect(fn).not.toMatch(/\.\.\.input/);
  });
});

describe('the reference the patient reads out', () => {
  it('avoids characters that are misread aloud', () => {
    // No 0/O, no 1/I/L. This gets spoken down a phone and copied off a printout
    // by somebody who has never seen it before.
    for (let i = 0; i < 200; i++) {
      expect(generateReference()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it('is unique per receiving pharmacy rather than globally', () => {
    // Globally unique would mean a longer string for no benefit — the length is
    // set by a person reading it at a counter, not by the birthday problem.
    expect(SCHEMA).toMatch(/@@unique\(\[tenantId, reference\]\)/);
  });

  it('retries a collision rather than lengthening the code', () => {
    expect(transmitBody()).toContain("err.code === 'P2002'");
  });
});

describe('the partner directory cannot be browsed', () => {
  it('never lists tenants', () => {
    /*
     * A dropdown of every hospital running a pharmacy would turn the provider's
     * customer base into something any administrator can read. The same
     * enumeration concern that makes the public signup form refuse to say
     * whether an email has applied before.
     */
    const code = strip(PARTNERS);
    expect(code).not.toMatch(/tenant\.findMany/);
  });

  it('gives one answer to every kind of failure', () => {
    /*
     * "No such code", "they have no pharmacy" and "they have not opted in" are
     * reported identically. Separating them would let somebody walk plausible
     * slugs and learn which hospitals exist and how they are configured.
     */
    const code = strip(PARTNERS);
    const guard = code.slice(code.indexOf('if (!target'), code.indexOf('throw new NotFoundException'));
    for (const condition of ['isActive', 'hasPharmacy', 'acceptsExternalPrescriptions']) {
      expect(guard).toContain(condition);
    }
    // One throw, not three.
    expect(code.match(/NotFoundException\(\s*'No pharmacy/g) ?? []).toHaveLength(1);
  });

  it('requires the receiving side to have opted in', () => {
    expect(strip(PARTNERS)).toContain('acceptsExternalPrescriptions');
    expect(SCHEMA).toContain('acceptsExternalPrescriptions Boolean @default(false)');
  });
});

describe('removing a partner is reversible', () => {
  /*
   * Two rules meet here and only one of them was implemented.
   *
   * Remove is a soft delete, and has to be: prescriptions already sent carry
   * `routedToTenantId`, and "where did this go" is asked precisely when a
   * partnership has ended. But the unique index covers inactive rows too and
   * the list shows only active ones — so re-adding a removed partner was
   * refused as "already one of your partners", naming a row the administrator
   * could not see and had no way to reach. Found by a user, with no exit but a
   * database console.
   */
  it('reactivates a removed row instead of refusing it', () => {
    const code = strip(PARTNERS);
    const add = code.slice(code.indexOf('async add('), code.indexOf('async remove('));

    /*
     * It has to look for an existing row before creating, and the *where*
     * must not filter on isActive — filtering there reintroduces the bug
     * exactly, since the row it needs to find is the inactive one.
     *
     * Asserted on the where clause alone rather than the whole call: `select`
     * reads isActive quite legitimately, and the first version of this test
     * failed on that. Matching a wider slice than the rule covers is how a
     * test ends up describing the code that happened to be there.
     */
    expect(add).toMatch(/findFirst\(/);
    const where = add.slice(add.indexOf('where:', add.indexOf('findFirst(')));
    expect(where.slice(0, where.indexOf('}'))).not.toContain('isActive');

    expect(add).toMatch(/isActive:\s*true/);
  });

  it('still refuses a partner that is actually there', () => {
    // The conflict is right for an *active* row; it was only ever wrong for a
    // removed one. Losing the message would let a hospital add a duplicate
    // under a second label.
    const add = strip(PARTNERS);
    expect(add).toContain('existing?.isActive');
    expect(add).toMatch(/ConflictException\('That pharmacy is already one of your partners'\)/);
  });

  it('keeps remove as a deactivation, never a delete', () => {
    /*
     * The tempting repair for the bug above is to hard-delete on remove, which
     * makes the re-add work and quietly breaks every prescription already
     * routed there. Asserted so that fix cannot be made by accident.
     */
    const code = strip(PARTNERS);
    const remove = code.slice(code.indexOf('async remove('));
    expect(remove).toMatch(/isActive:\s*false/);
    expect(remove).not.toMatch(/pharmacyPartner\.delete/);
  });

  it('does not report every failure as a conflict', () => {
    /*
     * The original `catch {}` turned any error — a dropped connection, a
     * constraint added later — into "already one of your partners", sending
     * somebody to look for a row that was never written. Only P2002, and only
     * as the two-administrators-at-once race the explicit check leaves behind.
     */
    expect(strip(PARTNERS)).toContain("code === 'P2002'");
  });
});

describe('a destination is not a refusal', () => {
  it('filters the in-house queue without gating dispensing', () => {
    /*
     * The queue shows IN_HOUSE only, so a prescription being filled elsewhere
     * stops reading as work nobody is doing. But `prepareDispense` and
     * `dispense` must NOT check the destination: if the patient changes their
     * mind and walks up to the counter, the pharmacist hands it over.
     *
     * A routing note hardening into "computer says no" is the same failure the
     * payment gate and the subscription guard both refuse.
     */
    const pharmacy = strip(
      readFileSync(resolve(__dirname, '../pharmacy/pharmacy.service.ts'), 'utf8'),
    );

    const queue = pharmacy.slice(pharmacy.indexOf('async queue()'), pharmacy.indexOf('async prepareDispense'));
    expect(queue).toContain('PrescriptionDestination.IN_HOUSE');

    const dispensing = pharmacy.slice(
      pharmacy.indexOf('async prepareDispense'),
      pharmacy.indexOf('async dispenseEvent'),
    );
    expect(dispensing).not.toContain('destination');
  });
});
