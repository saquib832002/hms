import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_GRANT_MINUTES,
  MAX_GRANT_MINUTES,
  expiryFrom,
  grantState,
  isGrantActive,
  minutesRemaining,
  validateGrantRequest,
} from './break-glass';

const NOW = new Date('2026-08-24T12:00:00Z');
const at = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000);

describe('opening a grant', () => {
  it('requires a real reason', () => {
    // A blank or token reason makes the audit row worthless at exactly the
    // moment a hospital asks why the vendor was in their records.
    for (const reason of [undefined, '', '   ', 'debug', 'looking']) {
      expect(() => validateGrantRequest({ reason })).toThrow(BadRequestException);
    }
    expect(validateGrantRequest({ reason: 'Investigating ticket 4471, booking grid empty' }))
      .toEqual({ reason: 'Investigating ticket 4471, booking grid empty', minutes: DEFAULT_GRANT_MINUTES });
  });

  it('caps the duration', () => {
    const reason = 'Investigating ticket 4471, booking grid empty';
    expect(validateGrantRequest({ reason, minutes: MAX_GRANT_MINUTES }).minutes).toBe(
      MAX_GRANT_MINUTES,
    );
    // A month-long grant is standing access wearing a break-glass label.
    expect(() => validateGrantRequest({ reason, minutes: MAX_GRANT_MINUTES + 1 })).toThrow(
      BadRequestException,
    );
    expect(() => validateGrantRequest({ reason, minutes: 30 * 24 * 60 })).toThrow(
      BadRequestException,
    );
  });

  it('rejects nonsense durations', () => {
    const reason = 'Investigating ticket 4471, booking grid empty';
    for (const minutes of [0, -60, 1.5]) {
      expect(() => validateGrantRequest({ reason, minutes })).toThrow(BadRequestException);
    }
  });
});

describe('whether a grant is usable', () => {
  it('is active before it expires', () => {
    expect(isGrantActive({ expiresAt: at(30), revokedAt: null }, NOW)).toBe(true);
    expect(grantState({ expiresAt: at(30), revokedAt: null }, NOW)).toBe('active');
  });

  it('expires on its own, with nobody having to remember', () => {
    expect(isGrantActive({ expiresAt: at(-1), revokedAt: null }, NOW)).toBe(false);
    expect(grantState({ expiresAt: at(-1), revokedAt: null }, NOW)).toBe('expired');
  });

  it('treats revocation as immediate, not at expiry', () => {
    /*
     * The important one. A token issued while the grant was live must stop
     * working the moment the grant is revoked — checked per request, not at
     * grant time. Otherwise "revoke" quietly means "revoke when the access
     * token expires", which is not what anyone reads it as.
     */
    const revoked = { expiresAt: at(120), revokedAt: at(-5) };
    expect(isGrantActive(revoked, NOW)).toBe(false);
    expect(grantState(revoked, NOW)).toBe('revoked');
  });

  it('does not treat a future-dated revocation as already revoked', () => {
    const grant = { expiresAt: at(120), revokedAt: at(30) };
    expect(isGrantActive(grant, NOW)).toBe(true);
    expect(isGrantActive(grant, at(31))).toBe(false);
  });

  it('reports remaining time without going negative', () => {
    expect(minutesRemaining({ expiresAt: at(45), revokedAt: null }, NOW)).toBe(45);
    expect(minutesRemaining({ expiresAt: at(-45), revokedAt: null }, NOW)).toBe(0);
    expect(minutesRemaining({ expiresAt: at(45), revokedAt: at(-1) }, NOW)).toBe(0);
  });

  it('computes expiry from a duration', () => {
    expect(expiryFrom(60, NOW).toISOString()).toBe('2026-08-24T13:00:00.000Z');
  });
});
