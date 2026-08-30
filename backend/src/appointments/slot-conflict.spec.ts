import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A patient cannot be in two places at once, and a cancelled slot is free.
 *
 * WHY THIS IS A SOURCE TEST RATHER THAN A UNIT TEST
 * -------------------------------------------------
 * Both rules are enforced by *partial unique indexes*, which is the only place
 * they can be enforced honestly — two receptionists tapping "book" in the same
 * second both pass any application check and both insert. There is nothing to
 * call in isolation; the guarantee lives in Postgres.
 *
 * The SQL proves itself when applied: `appointment-slots.sql` inserts a probe
 * appointment, asserts a second doctor is refused for the same patient, asserts
 * a cancelled slot can be reused, then rolls the probe back. That self-check is
 * the real test and it runs on every `npm run db:constraints`.
 *
 * What this file pins is that the machinery cannot quietly disappear: the
 * indexes stay partial, the service keeps its readable pre-check, and nobody
 * reintroduces the plain `@@unique` that started this.
 */

const BACKEND = resolve(__dirname, '../..');
const SQL = readFileSync(resolve(BACKEND, 'prisma/sql/appointment-slots.sql'), 'utf8');
const SCHEMA = readFileSync(resolve(BACKEND, 'prisma/schema.prisma'), 'utf8');
const SERVICE = readFileSync(resolve(__dirname, './appointments.service.ts'), 'utf8');

describe('appointment slot rules', () => {
  it('enforces both rules in the database, not only in the service', () => {
    expect(SQL).toContain('appointment_doctor_slot_active');
    expect(SQL).toContain('appointment_patient_slot_active');
    // A patient rule scoped by doctor would be meaningless — the point is that
    // the person cannot attend two consultations at once, whoever they are with.
    expect(SQL).not.toMatch(/appointment_patient_slot_active[\s\S]{0,120}"doctorId"/);
  });

  it('excludes cancelled and no-show rows from both indexes', () => {
    /*
     * The bug this prevents, which shipped and was only reachable once mobile
     * gained a Cancel button: with an unfiltered unique index, cancelling an
     * appointment leaves the row holding its slot, so rebooking that time is
     * refused on behalf of an appointment nobody is attending.
     */
    const filters = SQL.match(/WHERE status NOT IN \('CANCELLED', 'NO_SHOW'\)/g) ?? [];
    expect(filters).toHaveLength(2);
  });

  it('has dropped the plain unique constraint it replaced', () => {
    // Left in place, Prisma would recreate an unfiltered unique index on the
    // next migration and silently undo the partial one.
    expect(SCHEMA).not.toMatch(/@@unique\(\[doctorId, scheduledAt\]/);
    expect(SQL).toContain('DROP CONSTRAINT IF EXISTS "appointments_doctorId_scheduledAt_key"');
  });

  it('proves itself when applied rather than asserting in prose', () => {
    // The RLS work taught this twice: an index whose WHERE clause has a typo
    // never fires, and the first symptom is a double-booked patient.
    expect(SQL).toContain('is not enforcing');
    expect(SQL).toContain('still holding its slot');
  });

  it('checks the patient on booking AND on reschedule', () => {
    // Reschedule had no conflict check at all — the only thing in its way was
    // the doctor-slot index, which says nothing about the patient.
    const calls = SERVICE.match(/assertPatientIsFree\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // definition + create + update
  });

  it('tells reception which of the two clashed', () => {
    // "That slot is already booked" covered both cases and sent people to the
    // wrong calendar. Doctor busy and patient busy are different problems.
    expect(SERVICE).toContain('already has an appointment at that time');
    expect(SERVICE).toContain('already booked for this doctor');
  });
});
