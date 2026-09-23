import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_SLOT_MINUTES,
  ClinicSettings,
  describeClinic,
  isOnGrid,
  isValidCurrency,
  isValidTimeZone,
  slotMinutesOfDay,
  slotsPerDay,
  validateClinicSettings,
} from './clinic-settings';

const clinic = (over: Partial<ClinicSettings> = {}): ClinicSettings => ({
  timezone: 'America/Chicago',
  currency: 'GBP',
  taxEnabled: false,
  pricesIncludeTax: false,
  consultationTaxRateId: null,
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
  ...over,
});

describe('slot grid', () => {
  it('gives a hospital the number of slots its settings imply', () => {
    // The point of the feature: two hospitals, two different days.
    expect(slotsPerDay(clinic({ slotMinutes: 30 }))).toBe(16);
    expect(slotsPerDay(clinic({ slotMinutes: 10 }))).toBe(48);
    expect(slotsPerDay(clinic({ slotMinutes: 5, clinicStartHour: 7, clinicEndHour: 13 }))).toBe(72);
  });

  it('starts and ends where the hospital says', () => {
    const times = slotMinutesOfDay(clinic({ clinicStartHour: 7, clinicEndHour: 9, slotMinutes: 30 }));
    expect(times).toEqual([7 * 60, 7 * 60 + 30, 8 * 60, 8 * 60 + 30]);
    // End is exclusive: the last slot begins before closing, never at it.
    expect(times.at(-1)).toBeLessThan(9 * 60);
  });

  it('accepts a time only when it lands on this hospital\'s grid', () => {
    const fiveMin = clinic({ slotMinutes: 5 });
    const halfHour = clinic({ slotMinutes: 30 });

    // 14:05 is a real appointment in a walk-in clinic and nonsense in an
    // outpatient department. Same instant, different answer per hospital.
    expect(isOnGrid(14, 5, fiveMin)).toBe(true);
    expect(isOnGrid(14, 5, halfHour)).toBe(false);
    expect(isOnGrid(14, 30, halfHour)).toBe(true);
  });

  it('rejects times outside opening hours', () => {
    const c = clinic({ clinicStartHour: 8, clinicEndHour: 12 });
    expect(isOnGrid(7, 30, c)).toBe(false);
    expect(isOnGrid(8, 0, c)).toBe(true);
    expect(isOnGrid(11, 30, c)).toBe(true);
    // 12:00 is closing time, not the last slot.
    expect(isOnGrid(12, 0, c)).toBe(false);
  });
});

describe('validation', () => {
  it('allows only slot lengths that divide an hour', () => {
    // A 7-minute slot would drift out of alignment every hour, and the whole
    // grid assumes slots repeat identically.
    for (const m of ALLOWED_SLOT_MINUTES) {
      expect(() => validateClinicSettings({ slotMinutes: m })).not.toThrow();
    }
    for (const bad of [7, 45, 0, -5, 13]) {
      expect(() => validateClinicSettings({ slotMinutes: bad })).toThrow(BadRequestException);
    }
  });

  it('refuses a clinic day that ends before it starts', () => {
    // Saves silently and then no slot exists at all — the booking page just
    // shows nothing, with nothing to explain it.
    expect(() =>
      validateClinicSettings({ clinicStartHour: 17, clinicEndHour: 9 }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateClinicSettings({ clinicStartHour: 9, clinicEndHour: 9 }),
    ).toThrow(BadRequestException);
  });

  it('refuses hours outside a day', () => {
    expect(() => validateClinicSettings({ clinicStartHour: 24 })).toThrow(BadRequestException);
    expect(() => validateClinicSettings({ clinicEndHour: -1 })).toThrow(BadRequestException);
  });

  it('checks the timezone against the real database, not a pattern', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);

    // Plausible-looking and not real — a regex would accept this.
    expect(isValidTimeZone('America/Chicagoo')).toBe(false);

    // Intl DOES accept "CST", which is why this is checked explicitly. It means
    // US Central *and* China Standard — fourteen hours apart — and as a fixed
    // offset it ignores daylight saving, so a clinic set to it drifts an hour
    // twice a year against the staff standing in it.
    expect(isValidTimeZone('CST')).toBe(false);
    expect(isValidTimeZone('EST')).toBe(false);
    expect(() => validateClinicSettings({ timezone: 'Mars/Olympus' })).toThrow(
      BadRequestException,
    );
  });

  it('validates a partial update against the merged result', () => {
    // A PATCH sending only clinicEndHour must still be checked against the
    // start hour already stored, or "end before start" slips through.
    const stored = clinic({ clinicStartHour: 9, clinicEndHour: 17 });
    expect(() => validateClinicSettings({ ...stored, clinicEndHour: 8 })).toThrow(
      BadRequestException,
    );
  });
});

describe('describeClinic', () => {
  it('reads as something you could put in an error message', () => {
    expect(
      describeClinic(
        clinic({ slotMinutes: 10, clinicStartHour: 8, clinicEndHour: 18, currency: 'USD' }),
      ),
    ).toBe('08:00–18:00 America/Chicago, 10-minute slots, USD');
  });
});

describe('currency', () => {
  it('accepts real ISO 4217 codes', () => {
    for (const c of ['GBP', 'USD', 'INR', 'JPY', 'AED', 'NGN']) {
      expect(isValidCurrency(c)).toBe(true);
      expect(() => validateClinicSettings({ currency: c })).not.toThrow();
    }
  });

  it('rejects anything that only looks like one', () => {
    // Right shape, not a currency — a regex alone would let these through.
    expect(isValidCurrency('XYZ')).toBe(false);
    expect(isValidCurrency('gbp')).toBe(false); // callers uppercase first
    expect(isValidCurrency('POUND')).toBe(false);
    expect(isValidCurrency('$')).toBe(false);
    expect(() => validateClinicSettings({ currency: 'XYZ' })).toThrow(BadRequestException);
  });

  it('appears in the summary, so an error message can name it', () => {
    expect(describeClinic(clinic({ currency: 'INR' }))).toContain('INR');
  });
});
