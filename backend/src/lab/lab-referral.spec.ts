import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LabCategory, LabPriority, LabSpecimenType } from '@prisma/client';
import { TENANT_SCOPED_MODELS } from '../common/tenancy/tenant-context';
import { NEVER_TRANSMITTED, toLabReferralPayload } from './lab-referral';

/**
 * Sending a test to another company, and getting the result back.
 *
 * This is the first feature in the system where patient data crosses the
 * isolation boundary in **both** directions, so most of what is asserted here
 * is about how narrow the return leg is. The tests that matter are the ones
 * about what the design refuses to do.
 */

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const service = strip(readFileSync(path.resolve(__dirname, 'lab-referral.service.ts'), 'utf8'));
const rls = readFileSync(
  path.resolve(__dirname, '../../prisma/rls/tenant-isolation.sql'),
  'utf8',
);

describe('what crosses the boundary', () => {
  const payload = toLabReferralPayload({
    patient: { fullName: 'Alice Chen', dob: new Date('1980-03-02') },
    doctor: { fullName: 'Dr Rao' },
    clinicalDetails: '?anaemia, 3 months',
    priority: LabPriority.URGENT,
    items: [
      {
        id: 77,
        testCode: 'FBC',
        testName: 'Full blood count',
        category: LabCategory.HAEMATOLOGY,
        specimenType: LabSpecimenType.BLOOD,
      },
    ],
  });

  it('carries the patient, the tests and the clinical question', () => {
    expect(payload.patientName).toBe('Alice Chen');
    expect(payload.items[0].testCode).toBe('FBC');
    /*
     * `clinicalDetails` is the one field here that deserves an argument, and
     * it crosses on purpose: a laboratory that does not know why a test was
     * requested cannot comment usefully on the answer, and a histopathologist
     * without it is guessing. It is also one field the requesting doctor typed
     * knowing where it was going.
     */
    expect(payload.clinicalDetails).toBe('?anaemia, 3 months');
  });

  it('carries the id the result will be written back against', () => {
    expect(payload.items[0].sourceOrderItemId).toBe(77);
  });

  it('carries nothing else', () => {
    /*
     * Asserted against the serialised payload, not field by field. An explicit
     * allowlist rather than a spread is what makes this hold — a spread passes
     * every "does it contain X" check while silently carrying the next field
     * somebody adds to the model.
     */
    expect(Object.keys(payload).sort()).toEqual(
      ['clinicalDetails', 'items', 'patientDob', 'patientName', 'priority', 'requestedByName'].sort(),
    );
    for (const forbidden of NEVER_TRANSMITTED) {
      expect(JSON.stringify(payload)).not.toContain(forbidden);
    }
  });

  it('is built by an allowlist, never a spread', () => {
    const source = readFileSync(path.resolve(__dirname, 'lab-referral.ts'), 'utf8');
    const fn = /export function toLabReferralPayload[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    expect(fn).toBeTruthy();
    expect(fn).not.toMatch(/\.\.\.input/);
  });
});

describe('the write into another tenant', () => {
  it('happens inside forTenant and nowhere else', () => {
    /*
     * `forTenant` opens a transaction and sets `app.tenant_id` on it with
     * `set_config(..., true)` — transaction-local. A plain `SET` would persist
     * on a pooled connection into the next request, which is a different
     * hospital.
     */
    expect(service).toMatch(/forTenant\(partner\.partnerTenantId/);
    expect(service).toMatch(/forTenant\(sourceTenantId/);
    // And never through the cross-tenant escape hatch.
    expect(service).not.toMatch(/\.unscoped\./);
  });

  it('needs no policy exception in either direction', () => {
    /*
     * THE DESIGN DECISION THIS FILE EXISTS TO PROTECT.
     *
     * The rejected alternative was a policy carve-out making a referral tagged
     * for hospital B visible to B — one line of SQL, after which
     * `tenantId = app_current_tenant()` is no longer the whole truth and every
     * future reader of that policy has to know about the exception.
     *
     * Instead both legs write a row into the *owning* tenant's scope. Every
     * lab table takes the generic policy and nothing else.
     */
    for (const table of ['lab_referrals', 'lab_referral_items', 'lab_orders', 'lab_result_values']) {
      expect(rls).toContain(`'${table}'`);
    }
    expect(rls).not.toMatch(/lab_referrals[\s\S]{0,400}?CREATE POLICY(?!\s+tenant_isolation)/);
  });

  it('scopes every lab table in the application proxy too', () => {
    for (const model of [
      'labTest',
      'labAnalyte',
      'labOrder',
      'labOrderItem',
      'labResultValue',
      'labPartner',
      'labReferral',
      'labReferralItem',
    ]) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });

  it('retries only on a reference collision', () => {
    // A blanket retry would swallow a real failure five times and then report
    // something misleading. Same narrowing as the prescription referral.
    expect(service).toMatch(/err\.code === 'P2002'/);
    expect(service).toMatch(/continue;/);
  });
});

describe('the result coming back', () => {
  const returnLeg = service.slice(
    service.indexOf('async returnResult('),
    service.indexOf('private pushBack('),
  );

  it('writes only onto items named on that referral', () => {
    /*
     * The allowlist is rebuilt from the referral's own rows and checked
     * against the request body, because the body is the one thing the partner
     * controls. Without this a partner could name any order item id in the
     * sending hospital and write a result onto it.
     */
    expect(returnLeg).toMatch(/new Set\(referral\.items\.map/);
    expect(returnLeg).toMatch(/allowed\.has\(i\.sourceOrderItemId\)/);
  });

  it('refuses to overwrite a report the ordering hospital has authorised', () => {
    expect(returnLeg).toMatch(/LabOrderStatus\.VERIFIED/);
  });

  it('refuses to report twice', () => {
    // A correction is a new order, so the original stays readable — the same
    // rule the in-house result path applies.
    expect(returnLeg).toMatch(/referral\.resultedAt/);
  });

  it('demands every test on the referral, not some of them', () => {
    /*
     * A partial report looks complete, and the tests missing from it are
     * exactly the ones nobody chases, because the order has left the queue.
     */
    expect(returnLeg).toMatch(/Still to be reported/);
  });

  it('does not re-flag the partner\'s values against this hospital\'s ranges', () => {
    /*
     * Their analyser has their reference intervals. Recomputing a flag here
     * would be one organisation asserting something about a measurement it did
     * not make — the same reason `PrescriptionReferralItem` carries no
     * `medicineId`.
     */
    expect(returnLeg).toMatch(/flag: LabResultFlag\.UNKNOWN/);
    expect(returnLeg).not.toMatch(/flagFor\(/);
  });

  it('attributes the work to the partner, not to a local user', () => {
    // No `resultedById`: inventing one would make a partner's work
    // indistinguishable from this hospital's own staff in an audit.
    expect(returnLeg).toMatch(/performedByName/);
    expect(returnLeg).not.toMatch(/resultedById/);
    expect(returnLeg).toMatch(/externalVerifiedBy/);
  });

  it('tells the sending hospital when it is declined', () => {
    /*
     * A hospital that never learns its sample was rejected is a hospital whose
     * patient is waiting for a result nobody is producing. The decline is
     * written back too, and lands the order in REJECTED — which means "take
     * another sample" rather than "never mind".
     */
    const decline = service.slice(service.indexOf('async decline('), service.indexOf('async returnResult('));
    expect(decline).toMatch(/pushBack\(referral\.sourceTenantId/);
    expect(decline).toMatch(/LabOrderStatus\.REJECTED/);
  });
});

describe('the partner directory', () => {
  it('cannot be enumerated', () => {
    /*
     * "No such code", "they run no lab" and "they have not opted in" are one
     * identical refusal — the same reasoning that stops the public signup form
     * saying whether an email has applied before, and that keeps login from
     * separating "no such account" from "wrong password".
     */
    /*
     * Sliced to the *next method*, not to a method named further down.
     *
     * This used to end at `async removePartner(`, and a later change that
     * inserted three methods between the two swept them into the slice — so
     * the assertion below counted their refusals and failed, reporting a
     * problem with enumeration that did not exist. A test whose subject
     * silently grows is one that eventually asserts something nobody meant.
     */
    const from = service.indexOf('async addPartner(');
    const rest = service.slice(from + 1);
    const next = rest.search(/\n  (?:private )?async \w+\(/);
    const add = next === -1 ? rest : rest.slice(0, next);
    expect(add).toMatch(/!target \|\| !target\.isActive \|\| !target\.hasLab \|\| !target\.acceptsExternalLabOrders/);
    expect(add.match(/NotFoundException/g) ?? []).toHaveLength(1);
  });

  it('reactivates a removed partner rather than refusing to re-add it', () => {
    /*
     * The unique index covers inactive rows while the list shows only active
     * ones, so a plain create is refused naming a row the administrator cannot
     * see. That happened with partner pharmacies and the only exit was a
     * database console.
     */
    const add = service.slice(service.indexOf('async addPartner('), service.indexOf('async removePartner('));
    expect(add).toMatch(/isActive: true, label: dto\.label\.trim\(\)/);
  });

  it('never hard-deletes', () => {
    // Orders already sent carry `routedToTenantId`, and "where did this go" is
    // asked precisely when a partnership has ended.
    const remove = service.slice(service.indexOf('async removePartner('), service.indexOf('async requirePartner('));
    expect(remove).toMatch(/isActive: false/);
    expect(remove).not.toMatch(/\.delete\(/);
  });

  it('resolves a partner row id, never a raw tenant id from a client', () => {
    expect(service).toMatch(/async requirePartner\(partnerId: number\)/);
  });

  it('catches only a duplicate, never everything', () => {
    // A bare catch would report a dropped connection as "already a partner"
    // and send somebody looking for a row that was never written.
    const add = service.slice(service.indexOf('async addPartner('), service.indexOf('async removePartner('));
    expect(add).toMatch(/PrismaClientKnownRequestError && err\.code === 'P2002'/);
  });
});

describe('a destination is a filter, never a refusal', () => {
  const labService = strip(readFileSync(path.resolve(__dirname, 'lab.service.ts'), 'utf8'));

  it('is not consulted when collecting or resulting', () => {
    /*
     * If the patient changes their mind and brings the sample here, the lab
     * runs it. A routing note hardening into "computer says no" is the failure
     * the payment gate and the subscription guard both refuse, and the
     * dispensing path already refuses it too.
     */
    for (const method of ['async collect(', 'async recordResult(', 'async verify(']) {
      const start = labService.indexOf(method);
      expect(start).toBeGreaterThan(-1);

      /*
       * Bounded by the next method, not by a fixed number of characters.
       *
       * This read a flat 2500-char window, which is fine until a neighbouring
       * method grows or moves — `forPatient` gained a routing trail that
       * legitimately reads `destination`, the window ran into it, and the
       * failure pointed at `verify`, which had not changed. A fixture that does
       * not match the shape of the thing it measures tests the fixture, which
       * this repo has been caught by before.
       */
      const next = labService.slice(start + method.length).search(/\n {2}(?:private |protected )?async \w+\(/);
      const body = labService.slice(start, next === -1 ? undefined : start + method.length + next);

      expect(body).not.toMatch(/destination/);
    }
  });

  it('only filters the worklist', () => {
    const worklist = labService.slice(
      labService.indexOf('async worklist('),
      labService.indexOf('async collect('),
    );
    expect(worklist).toMatch(/destination: LabOrderDestination\.IN_HOUSE/);
  });
});
