import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Request } from 'express';
import { attemptedEmail, resolveAuditTarget } from './audit-target';

/**
 * The previous version of this logic was tested with a hand-written request
 * carrying `params: { id: '1' }` — a shape Express never produces for a route
 * declared `patients/:patientId/records`. The test passed; the code recorded no
 * target for every nested clinical route.
 *
 * So the important suite here is the last one: it reads the real route paths
 * out of the controllers and derives the params from them, instead of trusting
 * a fixture to resemble the router.
 */

function req(path: string, params: Record<string, string>): Request {
  return { route: { path }, path, params, body: {} } as unknown as Request;
}

describe('resolveAuditTarget', () => {
  it('resolves a plain :id against the resource it is mounted on', () => {
    expect(resolveAuditTarget(req('/api/v1/patients/:id', { id: '42' }))).toEqual({
      targetType: 'Patient',
      targetId: 42,
    });
    expect(resolveAuditTarget(req('/api/v1/prescriptions/:id', { id: '7' }))).toEqual({
      targetType: 'Prescription',
      targetId: 7,
    });
  });

  it('resolves :patientId on nested routes — the case that recorded nothing', () => {
    // Four 403 rows in a live run, all against routes like these, all with no
    // target at all. This is the regression.
    for (const path of [
      '/api/v1/patients/:patientId/records',
      '/api/v1/patients/:patientId/vitals',
      '/api/v1/patients/:patientId/prescriptions',
      '/api/v1/patients/:patientId/admissions',
    ]) {
      expect(resolveAuditTarget(req(path, { patientId: '412' }))).toEqual({
        targetType: 'Patient',
        targetId: 412,
      });
    }
  });

  it('prefers the patient over a sub-resource id', () => {
    // "Who reached for this patient" is the question the trail must answer.
    expect(
      resolveAuditTarget(req('/api/v1/patients/:patientId/vitals/:id', { patientId: '9', id: '3' })),
    ).toEqual({ targetType: 'Patient', targetId: 9 });
  });

  it('resolves admission and ward routes', () => {
    expect(
      resolveAuditTarget(req('/api/v1/admissions/:admissionId/medication-schedule', { admissionId: '5' })),
    ).toEqual({ targetType: 'Admission', targetId: 5 });
    expect(resolveAuditTarget(req('/api/v1/wards/:id/board', { id: '2' }))).toEqual({
      targetType: 'Ward',
      targetId: 2,
    });
  });

  it('records no target rather than a wrong one', () => {
    expect(resolveAuditTarget(req('/api/v1/me/queue', {}))).toEqual({
      targetType: null,
      targetId: null,
    });
    // A non-numeric or absent id must not become 0 or NaN in the trail.
    for (const bad of ['', 'abc', '0', '-1', '1.5']) {
      expect(resolveAuditTarget(req('/api/v1/patients/:id', { id: bad })).targetId).toBeNull();
    }
  });
});

describe('attemptedEmail', () => {
  it('captures the address tried on login and nothing else', () => {
    const r = {
      path: '/api/v1/auth/login',
      body: { email: 'nurse@demo.test', password: 'SuperSecret123' },
    } as unknown as Request;
    expect(attemptedEmail(r)).toBe('nurse@demo.test');
  });

  it('is null off the login route, so a body field cannot smuggle text in', () => {
    const r = {
      path: '/api/v1/patients',
      body: { email: 'patient.private@example.com' },
    } as unknown as Request;
    expect(attemptedEmail(r)).toBeNull();
  });

  it('ignores a non-string email', () => {
    const r = {
      path: '/api/v1/auth/login',
      body: { email: { $ne: null } },
    } as unknown as Request;
    expect(attemptedEmail(r)).toBeNull();
  });
});

/**
 * Derived from the controllers, not from an assumption about them.
 *
 * Every route that names a record must produce a target. If someone adds
 * `appointments/:appointmentId/notes` next year, this fails until the param is
 * mapped — rather than quietly logging accesses with no subject, which is how
 * the original bug survived.
 */
describe('every id-bearing route resolves a target', () => {
  const SRC = resolve(__dirname, '../..');

  function controllers(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return controllers(full);
      return e.isFile() && e.name.endsWith('.controller.ts') ? [full] : [];
    });
  }

  /** Joins the @Controller prefix to each method path, as Nest does. */
  function routes(file: string): string[] {
    const src = readFileSync(file, 'utf8');
    const out: string[] = [];
    let prefix = '';
    for (const line of src.split('\n')) {
      const c = line.match(/@Controller\('([^']*)'\)/);
      if (c) prefix = c[1];
      const m = line.match(/@(?:Get|Post|Patch|Put|Delete)\('([^']*)'\)/);
      if (m) out.push(`/${prefix}/${m[1]}`.replace(/\/+/g, '/'));
      else if (/@(?:Get|Post|Patch|Put|Delete)\(\)/.test(line)) out.push(`/${prefix}`);
    }
    return out;
  }

  /**
   * Routes whose parameter is not a record id, with the reason.
   *
   * Kept as an explicit list rather than a pattern, so adding one is a decision
   * somebody writes down — the rule this repo settled on after three exemption
   * lists grew false reasons nobody rechecked.
   */
  const NOT_A_RECORD_ID: Record<string, string> = {
    '/lab-orders/by-accession/:code':
      'The parameter is a specimen number, not a row id, and the interceptor ' +
      'runs before the service has resolved it — so there is no id to record ' +
      'at that point. The accession itself is in the request path, which the ' +
      'audit row already stores.',
  };

  const all = controllers(SRC).flatMap(routes);
  const withParams = all.filter((p) => p.includes(':') && !(p in NOT_A_RECORD_ID));

  it('states a reason for every route it skips', () => {
    // A list that can hold a bare entry is one that eventually does.
    for (const [route, reason] of Object.entries(NOT_A_RECORD_ID)) {
      expect(all).toContain(route);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('found routes to check', () => {
    // Guards against the suite passing because the parser silently matched none.
    expect(all.length).toBeGreaterThan(40);
    expect(withParams.length).toBeGreaterThan(15);
  });

  it.each(withParams)('%s', (path) => {
    const params = Object.fromEntries(
      [...path.matchAll(/:(\w+)/g)].map(([, name]) => [name, '11']),
    );
    const { targetType, targetId } = resolveAuditTarget(req(path, params));

    expect(targetType).not.toBeNull();
    expect(targetId).toBe(11);
  });
});
