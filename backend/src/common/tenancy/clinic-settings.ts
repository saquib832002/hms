import { BadRequestException } from '@nestjs/common';

/**
 * A hospital's clinic day: the timezone it runs on, when it opens, and how long
 * an appointment slot is.
 *
 * These were three hard-coded constants and one global env var. Under
 * multi-tenancy they are per-hospital, because they are not preferences —
 * they decide which appointment slots exist at all. A hospital left on another
 * hospital's timezone gets a booking page offering only times that have already
 * passed, and the failure looks like a bug in booking rather than a wrong
 * setting. (That is exactly how it presented in development.)
 *
 * Pure functions, no Prisma, so the rules are testable without a database.
 */

export interface ClinicSettings {
  timezone: string;
  slotMinutes: number;
  clinicStartHour: number;
  clinicEndHour: number;
  /** ISO 4217. Display only — see the note on Tenant.currency. */
  currency: string;
}

/** What the constants used to be. A tenant row missing values behaves as before. */
export const DEFAULT_CLINIC: ClinicSettings = {
  timezone: 'UTC',
  slotMinutes: 30,
  clinicStartHour: 9,
  clinicEndHour: 17,
  currency: 'GBP',
};

/**
 * Slot lengths that divide an hour exactly.
 *
 * A 7-minute slot would drift: 09:00, 09:07 … 09:56, and then the next hour
 * starts mid-slot. Every part of this system assumes slots repeat identically
 * each hour — the availability grid, the "is this time on the grid" check, and
 * the unique index on (doctorId, scheduledAt). Restricting the choice keeps
 * that assumption true rather than leaving it implied.
 */
export const ALLOWED_SLOT_MINUTES = [5, 10, 15, 20, 30, 60] as const;

export function validateClinicSettings(s: Partial<ClinicSettings>): void {
  if (s.slotMinutes !== undefined) {
    if (!ALLOWED_SLOT_MINUTES.includes(s.slotMinutes as (typeof ALLOWED_SLOT_MINUTES)[number])) {
      throw new BadRequestException(
        `slotMinutes must be one of ${ALLOWED_SLOT_MINUTES.join(', ')} — it has to divide an hour exactly`,
      );
    }
  }

  const start = s.clinicStartHour;
  const end = s.clinicEndHour;

  for (const [name, v] of [
    ['clinicStartHour', start],
    ['clinicEndHour', end],
  ] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 23)) {
      throw new BadRequestException(`${name} must be an integer from 0 to 23`);
    }
  }

  if (start !== undefined && end !== undefined && end <= start) {
    // Rejected rather than silently producing an empty day: a hospital that
    // saves 17–9 by mistake would otherwise find booking impossible with no
    // explanation anywhere.
    throw new BadRequestException('clinicEndHour must be after clinicStartHour');
  }

  if (s.currency !== undefined && !isValidCurrency(s.currency)) {
    throw new BadRequestException(
      `"${s.currency}" is not a recognised ISO 4217 currency code (for example USD, GBP, INR)`,
    );
  }

  if (s.timezone !== undefined && !isValidTimeZone(s.timezone)) {
    throw new BadRequestException(
      `"${s.timezone}" is not a recognised IANA timezone (for example America/Chicago)`,
    );
  }
}

/**
 * Checked against Intl, the same way timezones are.
 *
 * Three uppercase letters is the shape, but "XYZ" has that shape and is not a
 * currency. Intl knows the real list, and it is the same table that will render
 * the symbol.
 */
export function isValidCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;

  /*
   * `new Intl.NumberFormat({ currency: 'XYZ' })` does NOT throw — it accepts
   * any well-formed three-letter code and renders it verbatim. So constructing
   * a formatter proves only that the string has the right shape, which the
   * regex above already established.
   *
   * `Intl.supportedValuesOf('currency')` is the actual ISO 4217 list (162
   * entries), and is the only check here that rejects "XYZ".
   */
  const intl = Intl as typeof Intl & { supportedValuesOf?: (k: string) => string[] };
  const known = intl.supportedValuesOf?.('currency');
  if (known) return known.includes(code);

  // Older runtime with no list to consult. Shape-checked only — better than
  // refusing every currency on a platform that cannot enumerate them.
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks the platform rather than matching a pattern.
 *
 * A regex accepts "America/Chicagoo"; only the Intl database knows the real
 * list, and it is the same database that will later render the times.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
  } catch {
    return false;
  }

  /*
   * Intl accepts legacy abbreviations like "CST", and they are rejected here.
   *
   * "CST" is US Central Standard Time and also China Standard Time — fourteen
   * hours apart. Worse, abbreviations name a fixed offset rather than a place,
   * so they do not follow daylight saving: a clinic set to "CST" would silently
   * shift by an hour twice a year relative to the staff standing in it.
   *
   * Only Area/Location names, plus UTC, carry the rules needed to be correct
   * across a DST boundary.
   */
  return tz === 'UTC' || tz.includes('/');
}

/** Slot start times, in minutes past midnight, for one clinic day. */
export function slotMinutesOfDay(s: ClinicSettings): number[] {
  const out: number[] = [];
  for (let h = s.clinicStartHour; h < s.clinicEndHour; h++) {
    for (let m = 0; m < 60; m += s.slotMinutes) out.push(h * 60 + m);
  }
  return out;
}

/** How many appointments a single doctor's day can hold. */
export function slotsPerDay(s: ClinicSettings): number {
  return (s.clinicEndHour - s.clinicStartHour) * (60 / s.slotMinutes);
}

/**
 * Is this wall-clock time a real slot for this hospital?
 *
 * Checked on booking as well as generated for the picker. The picker only
 * offers valid times, but the API is the security boundary and a client can
 * post whatever it likes — an off-grid appointment would be invisible in the
 * availability view and impossible to cancel from it.
 */
export function isOnGrid(hour: number, minute: number, s: ClinicSettings): boolean {
  if (hour < s.clinicStartHour || hour >= s.clinicEndHour) return false;
  return minute % s.slotMinutes === 0;
}

/** Human-readable, for error messages and the settings screen. */
export function describeClinic(s: ClinicSettings): string {
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return `${hh(s.clinicStartHour)}–${hh(s.clinicEndHour)} ${s.timezone}, ${s.slotMinutes}-minute slots, ${s.currency}`;
}
