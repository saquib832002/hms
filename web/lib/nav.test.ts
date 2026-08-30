import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canReach, isKnownRoute, landingFor, navFor, ROLE_LABEL } from './nav';
import type { UserRole } from './types';

/**
 * The client-side mirror of the backend's access-matrix test.
 *
 * This nav is not the security boundary — the API is. But a receptionist
 * seeing a "Prescriptions" link they cannot open is still a bug: it is a
 * broken promise, and it hints at clinical data the role has no business
 * knowing exists for that patient.
 */

const ALL_ROLES: UserRole[] = [
  'ADMIN',
  'DOCTOR',
  'NURSE',
  'RECEPTIONIST',
  'PHARMACIST',
  'BILLING_STAFF',
];

/** Routes that render diagnoses, prescriptions, vitals or the clinical queue. */
const CLINICAL_ROUTES = ['/queue', '/vitals', '/medications', '/ward'];

/** Nurses gained a real ward in Phase 3 — these must now be live, not stubs. */
const NURSE_LIVE_ROUTES = ['/ward', '/vitals', '/medications'];

describe('role navigation', () => {
  it('gives every role a non-empty menu', () => {
    for (const role of ALL_ROLES) {
      expect(navFor(role).length, `${role} has no navigation`).toBeGreaterThan(0);
    }
  });

  it('gives every role a landing route inside its own menu', () => {
    for (const role of ALL_ROLES) {
      const nav = navFor(role);
      expect(nav.map((n) => n.href)).toContain(landingFor(role));
    }
  });

  it('labels every role', () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_LABEL[role]).toBeTruthy();
    }
  });

  describe('RECEPTIONIST', () => {
    const hrefs = navFor('RECEPTIONIST').map((n) => n.href);

    it('sees no clinical route', () => {
      for (const route of CLINICAL_ROUTES) {
        expect(hrefs, `reception should not see ${route}`).not.toContain(route);
      }
    });

    it('lands on the check-in queue', () => {
      expect(landingFor('RECEPTIONIST')).toBe('/check-in');
    });

    it('can still register patients and book appointments', () => {
      expect(hrefs).toContain('/patients/new');
      expect(hrefs).toContain('/appointments');
    });
  });

  describe('BILLING_STAFF', () => {
    const hrefs = navFor('BILLING_STAFF').map((n) => n.href);

    it('sees no clinical route', () => {
      for (const route of CLINICAL_ROUTES) {
        expect(hrefs).not.toContain(route);
      }
    });

    it('cannot reach appointments at all', () => {
      expect(hrefs).not.toContain('/appointments');
    });
  });

  describe('NURSE', () => {
    const nav = navFor('NURSE');

    it('lands on the ward board', () => {
      expect(landingFor('NURSE')).toBe('/ward');
    });

    it('has real screens for ward, vitals and medications', () => {
      // These were Phase 3 placeholders. If one regains a `phase` marker it
      // means a screen was reverted to a stub without anyone noticing.
      for (const href of NURSE_LIVE_ROUTES) {
        const item = nav.find((n) => n.href === href);
        expect(item).toBeDefined();
        expect(item?.phase).toBeUndefined();
      }
    });
  });

  describe('PHARMACIST', () => {
    const nav = navFor('PHARMACIST');

    it('lands on the dispensing queue', () => {
      expect(landingFor('PHARMACIST')).toBe('/pharmacy/queue');
    });

    it('has real screens for the queue and inventory', () => {
      for (const href of ['/pharmacy/queue', '/pharmacy/inventory']) {
        const item = nav.find((n) => n.href === href);
        expect(item).toBeDefined();
        expect(item?.phase).toBeUndefined();
      }
    });

    it('still sees no ward or clinical queue', () => {
      const hrefs = nav.map((n) => n.href);
      expect(hrefs).not.toContain('/ward');
      expect(hrefs).not.toContain('/queue');
    });
  });

  describe('BILLING_STAFF screens', () => {
    const nav = navFor('BILLING_STAFF');

    it('lands on invoices', () => {
      expect(landingFor('BILLING_STAFF')).toBe('/billing/invoices');
    });

    it('has real screens for invoices and payments', () => {
      for (const href of ['/billing/invoices', '/billing/payments']) {
        const item = nav.find((n) => n.href === href);
        expect(item).toBeDefined();
        expect(item?.phase).toBeUndefined();
      }
    });
  });

  describe('DOCTOR', () => {
    const hrefs = navFor('DOCTOR').map((n) => n.href);

    it('lands on the queue', () => {
      expect(landingFor('DOCTOR')).toBe('/queue');
    });

    it('is not offered patient registration — that is reception work', () => {
      expect(hrefs).not.toContain('/patients/new');
    });

    it('cannot reach the audit log', () => {
      expect(hrefs).not.toContain('/audit');
    });
  });

  describe('ADMIN', () => {
    const hrefs = navFor('ADMIN').map((n) => n.href);

    it('is the only role offered the audit log', () => {
      expect(hrefs).toContain('/audit');
      for (const role of ALL_ROLES.filter((r) => r !== 'ADMIN')) {
        expect(navFor(role).map((n) => n.href)).not.toContain('/audit');
      }
    });

    it('is not offered the clinical queue — admin is operational, not clinical', () => {
      expect(hrefs).not.toContain('/queue');
    });
  });

  it('has no unbuilt routes left — the roadmap is finished', () => {
    // Every phase is shipped, so nothing should still be advertising itself as
    // a placeholder. If a `phase` marker reappears, a screen was reverted to a
    // stub without anyone noticing.
    const placeholders = ALL_ROLES.flatMap((role) =>
      navFor(role)
        .filter((item) => item.phase !== undefined)
        .map((item) => `${role}: ${item.href}`),
    );
    expect(placeholders).toEqual([]);
  });

  describe('ADMIN screens', () => {
    const hrefs = navFor('ADMIN').map((n) => n.href);

    it('lands on the dashboard', () => {
      expect(landingFor('ADMIN')).toBe('/admin');
    });

    it('can manage staff and departments', () => {
      expect(hrefs).toContain('/admin/users');
      expect(hrefs).toContain('/admin/departments');
    });

    it('still has no clinical screen', () => {
      // Admin is operational, not clinical — that has held since Phase 1 and
      // gaining a dashboard must not change it.
      for (const clinical of CLINICAL_ROUTES) {
        expect(hrefs).not.toContain(clinical);
      }
    });
  });
});

/**
 * Reaching a screen, as distinct from being offered it.
 *
 * The menu was the only thing shaping this, and a menu holds until the first
 * URL is typed. It stopped holding for real: an admin signed in with a stale
 * `?next=/queue` in the address bar, landed on the doctor's queue, and the
 * resulting `GET /me/queue` was refused by the API — correctly — and written
 * into the hospital's audit log as a denied clinical access by an
 * administrator. The refusal worked. The trail is what suffered: a denial row
 * that means "somebody tried to reach clinical data they should not" is worth
 * much less once the app generates them by accident.
 */
describe('route access', () => {
  it('lets each role reach every screen in its own menu', () => {
    for (const role of ALL_ROLES) {
      for (const item of navFor(role)) {
        expect(canReach(role, item.href), `${role} cannot reach its own ${item.href}`).toBe(true);
      }
    }
  });

  it('refuses a role a screen no menu offers it', () => {
    // The exact case that happened. /me/queue is a doctor endpoint and the
    // admin's 403 was the API doing its job — the app should not have asked.
    expect(canReach('ADMIN', '/queue')).toBe(false);
    expect(canReach('RECEPTIONIST', '/ward')).toBe(false);
    expect(canReach('BILLING_STAFF', '/audit')).toBe(false);
    expect(canReach('PHARMACIST', '/admin/users')).toBe(false);
  });

  it('ignores a query string and a trailing slash', () => {
    // `usePathname()` gives neither, but `?next=` carries both, and a rule that
    // a question mark defeats is not a rule.
    expect(canReach('ADMIN', '/queue?date=2026-08-29')).toBe(false);
    expect(canReach('ADMIN', '/queue/')).toBe(false);
    expect(canReach('DOCTOR', '/queue?date=2026-08-29')).toBe(true);
  });

  it('treats an unknown path as a 404, not as a denial', () => {
    /*
     * A typo must reach Next's not-found page. Redirecting it to the role's
     * landing screen would make every mistyped URL look like an access refusal
     * and hide genuine broken links behind a silent bounce.
     */
    expect(isKnownRoute('/nonsense')).toBe(false);
    for (const role of ALL_ROLES) expect(canReach(role, '/nonsense')).toBe(true);
  });

  it('gives every screen in the app at least one role', () => {
    /*
     * The load-bearing one. `canReach` is derived from NAV, so a page nobody
     * has a menu entry for is reachable by everybody — the guard would wave it
     * through while looking like it was checking. This fails the day a page is
     * added without deciding who it is for, which is the moment to decide.
     */
    const here = fileURLToPath(new URL('.', import.meta.url));
    const appDir = resolve(here, '../app/(app)');
    const pages: string[] = [];

    const walk = (dir: string, route: string) => {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) {
          // (groups) do not appear in the URL; [dynamic] segments would need a
          // pattern match rather than an exact one, so flag them here.
          walk(full, entry.startsWith('(') ? route : `${route}/${entry}`);
        } else if (entry === 'page.tsx') {
          pages.push(route || '/');
        }
      }
    };
    walk(appDir, '');

    expect(pages.length).toBeGreaterThan(10); // the walk actually found something
    const orphans = pages.filter((p) => !isKnownRoute(p));
    expect(orphans, 'screens with no role in nav.ts').toEqual([]);
  });
});
