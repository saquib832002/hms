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
  /** SEPARATE or COMBINED — see `PharmacyBillingMode` in the schema. */
  pharmacyBilling: 'SEPARATE' | 'COMBINED';
  /**
   * Does this hospital run a pharmacy at all?
   *
   * When false the doctor is never asked where a prescription goes — every one
   * is external — and the dispensing screens have nothing to show.
   */
  hasPharmacy: boolean;

  /**
   * Tax off entirely, and off by default.
   *
   * Explicit rather than inferred from "are any rates defined", so a hospital
   * can build and check its rate table before any of it reaches a bill — and
   * so the screens have something to gate on, letting a clinic that charges no
   * tax never see a tax column at all.
   */
  taxEnabled: boolean;

  /**
   * Whether the prices staff type already contain tax.
   *
   * India: the MRP on the box includes GST and is what the patient expects to
   * pay, so tax is extracted from it. United States: the shelf price is net
   * and tax is added at the till. Both are "the price is 10.00" and they mean
   * different amounts of money.
   */
  pricesIncludeTax: boolean;

  /**
   * The rate applied to consultation fees, or null for untaxed.
   *
   * Separate from the medicine default deliberately. Indian healthcare
   * services are largely exempt while the medicines dispensed at the same
   * visit are not; one rate covering both would be wrong for whichever was
   * configured second.
   */
  consultationTaxRateId: number | null;
  /**
   * Will this pharmacy accept prescriptions written at another hospital?
   *
   * The receiving half of a two-sided opt-in, and the only thing that makes
   * this tenant findable by a partner. Off by default.
   */
  acceptsExternalPrescriptions: boolean;

  /** SEPARATE or COMBINED — see `LabBillingMode` in the schema. */
  labBilling: 'SEPARATE' | 'COMBINED';

  /**
   * Does this hospital run a lab at all?
   *
   * When false the doctor is never offered an in-house destination — every
   * order leaves the building — and the worklist has nothing to show. Most
   * small clinics draw the blood and send it out.
   */
  hasLab: boolean;

  /**
   * Will this lab accept test orders raised at another hospital?
   *
   * The receiving half of a two-sided opt-in, and the only thing that makes
   * this tenant findable by a partner. Off by default.
   *
   * IT HAS TO BE ON A SCREEN, AND FOR A WHILE IT WAS NOT. Adding the column and
   * the lookup without the switch made every `POST /lab-partners` refuse with
   * "no lab is accepting orders under that code" — a refusal that is correct,
   * unexplainable, and impossible to clear. Exactly the shape this project has
   * hit repeatedly: a precondition the system names and nobody can satisfy.
   */
  acceptsExternalLabOrders: boolean;

  /**
   * Which billing arrangements this lab will take referred work under.
   *
   * The receiving half of a two-sided decision about *money*, which is what
   * makes it different from the flag above. `acceptsExternalLabOrders` answers
   * "will you do work for other hospitals"; this answers "and who settles it" —
   * and a lab with no accounts-receivable function genuinely cannot take an
   * institutional debt, however willing it is to run the test.
   *
   * An empty array is legal and means exactly that: work accepted under no
   * arrangement, which is a real state while a lab is being set up. The partner
   * lookup says so rather than reporting the lab as not found — the refusal
   * that has to name what is missing, because the person meeting it is at the
   * other company and cannot see this screen.
   */
  acceptedReferralBilling: ('ORIGIN_PAYS' | 'PATIENT_PAYS')[];

  /** ISO 4217. Display only — see the note on Tenant.currency. */
  currency: string;
}

/** What the constants used to be. A tenant row missing values behaves as before. */
export const DEFAULT_CLINIC: ClinicSettings = {
  timezone: 'UTC',
  slotMinutes: 30,
  clinicStartHour: 9,
  clinicEndHour: 17,
  pharmacyBilling: 'SEPARATE',
  hasPharmacy: true,
  acceptsExternalPrescriptions: false,
  labBilling: 'SEPARATE',
  hasLab: true,
  acceptsExternalLabOrders: false,
  acceptedReferralBilling: ['ORIGIN_PAYS'],
  currency: 'GBP',
  // Tax off, exclusive, no consultation rate. Every hospital that has not
  // deliberately switched tax on behaves exactly as it did before tax existed.
  taxEnabled: false,
  pricesIncludeTax: false,
  consultationTaxRateId: null,
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
