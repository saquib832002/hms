import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SubscriptionStatus } from '@prisma/client';
import { canWrite, daysRemaining, hasExpired, refusalMessage, shouldWarn } from './subscription';

/**
 * A lapsed subscription takes away writes. It must never take away reads, and
 * it must never take away login.
 *
 * WHY THIS IS ASSERTED RATHER THAN TRUSTED
 * ----------------------------------------
 * "Deny access until they pay" is the obvious implementation, it is what most
 * SaaS does, and adding it here would look like a straightforward improvement
 * to anyone who had not thought it through. It would also mean a clinician
 * cannot open a patient's allergy list because a card expired — harm landing on
 * people who have no idea the invoice exists and no way to pay it.
 *
 * `consultation-billing.spec.ts` refuses the same move one level down: software
 * must not decline care over an unpaid balance. Holding that line for a
 * patient's bill and abandoning it for the vendor's would be incoherent, so the
 * absence of a read gate is pinned here the same way.
 */

const GUARD = readFileSync(resolve(__dirname, '../guards/subscription.guard.ts'), 'utf8');
const GUARD_CODE = GUARD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const NOW = new Date('2026-06-15T12:00:00Z');
const state = (status: SubscriptionStatus, endsAt: Date | null = null) => ({ status, endsAt });

describe('who may write', () => {
  it('lets an open-ended contract write', () => {
    /*
     * NULL is not expired. An invoiced hospital contract with no fixed renewal
     * is the normal shape, and treating a missing date as a lapse would turn a
     * data-entry gap into an outage.
     */
    expect(canWrite(state(SubscriptionStatus.ACTIVE, null), NOW)).toBe(true);
    expect(canWrite(state(SubscriptionStatus.TRIAL, null), NOW)).toBe(true);
  });

  it('lets a trial write exactly like an active subscription', () => {
    // A trial that cannot write is a demo of nothing.
    const future = new Date('2026-07-01T00:00:00Z');
    expect(canWrite(state(SubscriptionStatus.TRIAL, future), NOW)).toBe(true);
  });

  it('does not restrict a past-due account on its own', () => {
    /*
     * Chasing an invoice and restricting a hospital are different decisions
     * taken at different times. Collapsing them means the first overdue day
     * silently becomes the restriction, with no human having decided it should.
     */
    expect(canWrite(state(SubscriptionStatus.PAST_DUE, null), NOW)).toBe(true);
  });

  it('stops writes once the period has run out', () => {
    const past = new Date('2026-06-14T12:00:00Z');
    expect(canWrite(state(SubscriptionStatus.ACTIVE, past), NOW)).toBe(false);
    expect(hasExpired(state(SubscriptionStatus.ACTIVE, past), NOW)).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    // The boundary nobody tests and everybody argues about later.
    expect(canWrite(state(SubscriptionStatus.ACTIVE, NOW), NOW)).toBe(false);
  });

  it('stops writes when suspended or cancelled, whatever the date says', () => {
    const future = new Date('2027-01-01T00:00:00Z');
    expect(canWrite(state(SubscriptionStatus.SUSPENDED, future), NOW)).toBe(false);
    expect(canWrite(state(SubscriptionStatus.CANCELLED, future), NOW)).toBe(false);
  });
});

describe('warning before anything stops working', () => {
  it('starts a fortnight out', () => {
    // Being surprised by a restriction is most of the harm. Notice removes it.
    const soon = new Date('2026-06-20T12:00:00Z');
    expect(shouldWarn(state(SubscriptionStatus.ACTIVE, soon), NOW)).toBe(true);
    expect(daysRemaining(state(SubscriptionStatus.ACTIVE, soon), NOW)).toBe(5);
  });

  it('stays quiet when there is nothing to warn about', () => {
    const distant = new Date('2027-01-01T00:00:00Z');
    expect(shouldWarn(state(SubscriptionStatus.ACTIVE, distant), NOW)).toBe(false);
    expect(shouldWarn(state(SubscriptionStatus.ACTIVE, null), NOW)).toBe(false);
  });

  it('warns on past-due even with no date', () => {
    expect(shouldWarn(state(SubscriptionStatus.PAST_DUE, null), NOW)).toBe(true);
  });

  it('does not warn once it has already stopped', () => {
    // At that point it is not a warning, it is a refusal, and the refusal
    // message says the useful thing.
    expect(shouldWarn(state(SubscriptionStatus.SUSPENDED, null), NOW)).toBe(false);
  });
});

describe('what the hospital is told', () => {
  it('says what to do, not just that it failed', () => {
    const msg = refusalMessage(state(SubscriptionStatus.SUSPENDED));
    expect(msg).toContain('readable');
    expect(msg).toMatch(/administrator/i);
  });

  it('carries no invoice numbers or amounts', () => {
    /*
     * A receptionist meeting this has done nothing wrong. What the hospital
     * owes is between the vendor and whoever signed the contract, and putting
     * it on a clerk's screen is both useless to them and a disclosure nobody
     * agreed to.
     */
    for (const status of Object.values(SubscriptionStatus)) {
      const msg = refusalMessage(state(status));
      expect(msg).not.toMatch(/\d/);
      expect(msg.toLowerCase()).not.toContain('invoice');
      expect(msg.toLowerCase()).not.toContain('pay');
    }
  });
});

describe('the guard', () => {
  it('lets every read through, unconditionally', () => {
    /*
     * The single most important line in the feature. If this ever becomes
     * conditional, a hospital loses access to patient records over a billing
     * event — which is the thing this whole design exists to prevent.
     */
    expect(GUARD_CODE).toContain("if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;");
  });

  it('never touches authentication', () => {
    // Login, refresh and logout are @Public, and the guard returns before it
    // looks at anything else. Blocking them is a lockout by another name.
    const publicCheck = GUARD_CODE.indexOf('IS_PUBLIC_KEY');
    const canWriteCheck = GUARD_CODE.indexOf('canWrite(');
    expect(publicCheck).toBeGreaterThan(-1);
    expect(publicCheck).toBeLessThan(canWriteCheck);
  });

  it('leaves the platform routes alone', () => {
    // The vendor restoring a subscription must not be blocked by the
    // subscription. That deadlock is easy to build and impossible to escape.
    const platformCheck = GUARD_CODE.indexOf('IS_PLATFORM_ROUTE_KEY');
    expect(platformCheck).toBeGreaterThan(-1);
    expect(platformCheck).toBeLessThan(GUARD_CODE.indexOf('canWrite('));
  });

  it('always lets a forced password change through', () => {
    // Otherwise a user who must change their password meets a door with no
    // handle: every screen refuses them, including the one that would fix it.
    expect(GUARD_CODE).toContain('MePasswordController.changePassword');
  });

  it('keys on the HTTP method rather than a list of routes', () => {
    /*
     * A route list rots. The first write somebody forgets to add keeps working
     * after a hospital has been suspended, and nothing would say so.
     */
    expect(GUARD_CODE).toMatch(/request\.method/);
  });
});
