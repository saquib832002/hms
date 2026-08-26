import { BadRequestException } from '@nestjs/common';

/**
 * When a vendor may look at a hospital, and for how long.
 *
 * Pure functions, no Prisma. These decide whether someone outside the hospital
 * can see its data at all, which is the last place to want a rule that can
 * only be tested by standing up a database.
 */

export interface GrantWindow {
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * The longest a grant may run.
 *
 * Eight hours, not thirty days. A support incident is measured in hours, and a
 * grant that outlives the incident is standing access with extra paperwork —
 * exactly what break-glass exists to avoid. Extending means opening a new
 * grant, which leaves a second audit row and a second stated reason.
 */
export const MAX_GRANT_MINUTES = 8 * 60;
export const DEFAULT_GRANT_MINUTES = 60;

/** Shortest useful reason. Two words is not a reason. */
const MIN_REASON_LENGTH = 12;

export function validateGrantRequest(input: {
  reason?: string;
  minutes?: number;
}): { reason: string; minutes: number } {
  const reason = (input.reason ?? '').trim();

  if (reason.length < MIN_REASON_LENGTH) {
    // Rejected rather than defaulted. "why was the vendor in our records" is
    // the question this table exists to answer, and a blank reason makes the
    // row worthless at exactly the moment someone needs it.
    throw new BadRequestException(
      `A reason of at least ${MIN_REASON_LENGTH} characters is required — it is what the hospital reads in its audit trail.`,
    );
  }

  const minutes = input.minutes ?? DEFAULT_GRANT_MINUTES;

  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new BadRequestException('minutes must be a positive whole number');
  }
  if (minutes > MAX_GRANT_MINUTES) {
    throw new BadRequestException(
      `A grant may not exceed ${MAX_GRANT_MINUTES} minutes. Open a new grant if the work continues.`,
    );
  }

  return { reason, minutes };
}

/**
 * Is this grant usable right now?
 *
 * Revoked beats expiry, and both are checked on every request rather than at
 * grant time. A token issued while a grant was live must stop working the
 * moment it is revoked — otherwise "revoke" means "revoke in fifteen minutes",
 * which is not what anyone reads it as.
 */
export function isGrantActive(grant: GrantWindow, now: Date = new Date()): boolean {
  if (grant.revokedAt !== null && grant.revokedAt <= now) return false;
  return grant.expiresAt > now;
}

export function grantState(
  grant: GrantWindow,
  now: Date = new Date(),
): 'active' | 'revoked' | 'expired' {
  if (grant.revokedAt !== null && grant.revokedAt <= now) return 'revoked';
  return grant.expiresAt > now ? 'active' : 'expired';
}

/** Minutes left, for display. Never negative. */
export function minutesRemaining(grant: GrantWindow, now: Date = new Date()): number {
  if (!isGrantActive(grant, now)) return 0;
  return Math.ceil((grant.expiresAt.getTime() - now.getTime()) / 60_000);
}

export function expiryFrom(minutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + minutes * 60_000);
}
