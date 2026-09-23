import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SubscriptionStatus, UserRole } from '@prisma/client';
import { SESSION_USER_INCLUDE, SessionUserRow, toSessionUser } from './session-user';

/**
 * The login response and `GET /auth/me` must describe the same user.
 *
 * They did not. Both built the session user inline, and when `hospital` was
 * added it went onto one and not the other — so the dashboard rendered in the
 * wrong currency until the page was reloaded, at which point `/auth/me` filled
 * in what login had omitted.
 *
 * Two things are pinned here: the mapper's output, and the fact that neither
 * caller assembles the object by hand any more. The second is what stops the
 * drift returning, because the first only checks a function nobody is obliged
 * to call.
 */

const row: SessionUserRow = {
  id: 7,
  tenantId: 3,
  email: 'doctor@demo.test',
  fullName: 'Demo Doctor',
  role: UserRole.DOCTOR,
  mustChangePassword: false,
  doctorProfile: { id: 42 },
  tenant: {
    name: "St Mary's",
    slug: 'st-marys',
    timezone: 'America/Chicago',
    currency: 'USD',
    subscriptionStatus: SubscriptionStatus.ACTIVE,
    subscriptionEndsAt: null,
    // Everything, which is what an existing hospital gets — modules narrow only
    // when a vendor decides they should.
    modules: ['CLINIC', 'WARDS', 'PHARMACY', 'LABORATORY', 'BILLING'],
  },
};

describe('toSessionUser', () => {
  it('carries the hospital, which is what the clients format money and times with', () => {
    const user = toSessionUser(row);
    /*
     * The exact key set, not a subset. This test exists because `hospital` was
     * once built in two places and drifted — one gained a field and the other
     * did not, so the currency was right on reload and missing immediately
     * after signing in. A `toMatchObject` here would pass through exactly that.
     */
    expect(user.hospital).toEqual({
      name: "St Mary's",
      slug: 'st-marys',
      timezone: 'America/Chicago',
      currency: 'USD',
      // Carried so `SubscriptionGuard` can answer "may this write?" without a
      // second query, and so both clients can warn before anything stops.
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      subscriptionEndsAt: null,
    // Everything, which is what an existing hospital gets — modules narrow only
    // when a vendor decides they should.
    modules: ['CLINIC', 'WARDS', 'PHARMACY', 'LABORATORY', 'BILLING'],
    });
  });

  it('carries identity, role and tenant', () => {
    const user = toSessionUser(row);
    expect(user.userId).toBe(7);
    expect(user.tenantId).toBe(3);
    expect(user.email).toBe('doctor@demo.test');
    expect(user.role).toBe(UserRole.DOCTOR);
    expect(user.mustChangePassword).toBe(false);
  });

  it('includes doctorId only for a doctor', () => {
    expect(toSessionUser(row).doctorId).toBe(42);
    expect(toSessionUser({ ...row, doctorProfile: null }).doctorId).toBeUndefined();
    expect('doctorId' in toSessionUser({ ...row, doctorProfile: null })).toBe(false);
  });

  it('never leaks the password hash, however the row was loaded', () => {
    // The row handed in comes straight from Prisma and does carry passwordHash.
    // Returning the model directly is the mistake this guards against — the
    // same one `toPatientResponse` exists to prevent for patients.
    const withSecret = { ...row, passwordHash: '$argon2id$secret' } as SessionUserRow;
    expect(JSON.stringify(toSessionUser(withSecret))).not.toContain('argon2');
    expect(JSON.stringify(toSessionUser(withSecret))).not.toContain('passwordHash');
  });

  it('asks for everything it reads', () => {
    // A field added to SessionUserRow but not to SESSION_USER_INCLUDE would be
    // undefined at runtime and typed as present — the worst combination.
    const include = JSON.stringify(SESSION_USER_INCLUDE);
    for (const field of ['name', 'slug', 'timezone', 'currency']) {
      expect(include).toContain(field);
    }
    expect(include).toContain('doctorProfile');
  });
});

describe('both callers use the shared mapper', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

  it.each([
    ['login', 'auth.service.ts'],
    ['/auth/me', 'strategies/jwt.strategy.ts'],
  ])('%s returns toSessionUser(...) rather than an inline object', (_label, file) => {
    const src = read(file);
    expect(src).toContain('toSessionUser(');
    expect(src).toContain('SESSION_USER_INCLUDE');

    // The inline shape that drifted. If either file starts hand-building the
    // session user again, this fails before the clients disagree.
    expect(src).not.toMatch(/userId:\s*user\.id,[\s\S]{0,80}email:\s*user\.email/);
  });
});
