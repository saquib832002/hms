import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ATTENDED_STATUSES,
  patientActivity,
  type ActivityAppointment,
} from './patient-activity';

const appt = (over: Partial<ActivityAppointment> = {}): ActivityAppointment => ({
  doctorId: 1,
  patientId: 100,
  status: 'COMPLETED',
  billedMinor: 50_000,
  collectedMinor: 50_000,
  ...over,
});

const DOCTORS = [
  { id: 1, name: 'Dr Rao' },
  { id: 2, name: 'Dr Chen' },
];

describe('patientActivity', () => {
  it('counts registrations, appointments and attendance', () => {
    const out = patientActivity(
      [
        appt({ status: 'COMPLETED' }),
        appt({ status: 'IN_PROGRESS', patientId: 101 }),
        appt({ status: 'SCHEDULED', patientId: 102 }),
        appt({ status: 'NO_SHOW', patientId: 103 }),
      ],
      DOCTORS,
      12,
    );

    expect(out.registered).toBe(12);
    expect(out.appointments).toBe(4);
    expect(out.attended).toBe(2);
    expect(out.noShows).toBe(1);
    expect(out.noShowRate).toBe(25);
  });

  it('does not count a diary entry as attendance', () => {
    /*
     * SCHEDULED is deliberately absent from `ATTENDED_STATUSES` — tomorrow's
     * bookings must not inflate today's "seen", and the same reasoning keeps
     * SCHEDULED out of `resolveTreatingScope`. CHECKED_IN is arrival without a
     * consultation yet, so it is neither attended nor a no-show.
     */
    expect([...ATTENDED_STATUSES]).toEqual(['COMPLETED', 'IN_PROGRESS']);
    const out = patientActivity(
      [appt({ status: 'SCHEDULED' }), appt({ status: 'CHECKED_IN', patientId: 101 })],
      DOCTORS,
      0,
    );
    expect(out.attended).toBe(0);
    expect(out.noShows).toBe(0);
    expect(out.patientsSeen).toBe(0);
  });

  it('counts a patient once however many times they came', () => {
    const out = patientActivity(
      [
        appt({ patientId: 100 }),
        appt({ patientId: 100 }),
        appt({ patientId: 100 }),
        appt({ patientId: 101 }),
      ],
      DOCTORS,
      0,
    );
    expect(out.patientsSeen).toBe(2);
    // ...while consultations counts the visits, which is the other question.
    expect(out.byDoctor[0].consultations).toBe(4);
    expect(out.byDoctor[0].patientsSeen).toBe(2);
  });

  it('does not double-count a patient seen by two doctors', () => {
    /*
     * The hospital total is a distinct count over the whole period, not the sum
     * of the per-doctor figures. One patient seen by two doctors is one patient
     * here and one in each of their rows; summing the rows gives two, and a
     * hospital total larger than its own patient list is a figure nobody can
     * explain.
     */
    const out = patientActivity(
      [appt({ doctorId: 1, patientId: 100 }), appt({ doctorId: 2, patientId: 100 })],
      DOCTORS,
      0,
    );

    expect(out.patientsSeen).toBe(1);
    expect(out.byDoctor.reduce((n, d) => n + d.patientsSeen, 0)).toBe(2);
  });

  it('keeps a doctor who saw nobody, at zero', () => {
    /*
     * Exactly who an owner reconciling a quiet week wants to see. A missing row
     * and a zero row look identical and mean opposite things — the same
     * argument as the payment-method split listing a method that took nothing.
     */
    const out = patientActivity([appt({ doctorId: 1 })], DOCTORS, 0);
    expect(out.byDoctor).toHaveLength(2);
    const chen = out.byDoctor.find((d) => d.doctorId === 2)!;
    expect(chen.consultations).toBe(0);
    expect(chen.collected).toBe('0.00');
  });

  it('counts an appointment with no doctor in the totals and in no row', () => {
    // A real state, and it must not vanish: the hospital saw that patient.
    const out = patientActivity([appt({ doctorId: null, patientId: 200 })], DOCTORS, 0);
    expect(out.attended).toBe(1);
    expect(out.patientsSeen).toBe(1);
    expect(out.byDoctor.every((d) => d.consultations === 0)).toBe(true);
  });

  it('reports billed and collected side by side, never one alone', () => {
    /*
     * Payment is deliberately not required before a consultation, so the gap
     * between them is real — and reporting only what was charged is how a
     * clinic mistakes invoices raised for money in the bank.
     */
    const out = patientActivity(
      [
        appt({ billedMinor: 50_000, collectedMinor: 50_000 }),
        appt({ patientId: 101, billedMinor: 50_000, collectedMinor: 0 }),
      ],
      DOCTORS,
      0,
    );
    expect(out.billed).toBe('1000.00');
    expect(out.collected).toBe('500.00');
    expect(Object.keys(out.byDoctor[0])).toContain('billed');
    expect(Object.keys(out.byDoctor[0])).toContain('collected');
  });

  it('counts money from attended appointments only', () => {
    // A no-show is revenue invented from an empty chair, and a SCHEDULED
    // appointment has not happened. Neither belongs in a takings figure.
    const out = patientActivity(
      [
        appt({ status: 'NO_SHOW', billedMinor: 50_000, collectedMinor: 50_000 }),
        appt({ status: 'SCHEDULED', patientId: 101, billedMinor: 50_000, collectedMinor: 0 }),
      ],
      DOCTORS,
      0,
    );
    expect(out.billed).toBe('0.00');
    expect(out.collected).toBe('0.00');
  });

  it('orders doctors busiest first, stably', () => {
    const out = patientActivity(
      [appt({ doctorId: 2 }), appt({ doctorId: 2, patientId: 101 }), appt({ doctorId: 1 })],
      DOCTORS,
      0,
    );
    expect(out.byDoctor.map((d) => d.name)).toEqual(['Dr Chen', 'Dr Rao']);
  });

  it('reports zeroes rather than nothing for an empty period', () => {
    const out = patientActivity([], DOCTORS, 0);
    expect(out.appointments).toBe(0);
    expect(out.noShowRate).toBe(0);
    expect(out.collected).toBe('0.00');
    expect(out.byDoctor).toHaveLength(2);
  });
});

describe('it reports attendance and money, never clinical content', () => {
  const SOURCE = readFileSync(resolve(__dirname, './patient-activity.ts'), 'utf8');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('names no clinical field', () => {
    /*
     * `reason` is the field to watch. Typed by reception at booking, routinely
     * "chest pain", and it sits on the same row as everything here — one
     * careless `include` away. The same rule `reports.spec.ts` already enforces
     * for `doctorsReport` and `staffActivityReport`.
     */
    const code = strip(SOURCE);
    for (const forbidden of [
      'reason',
      'diagnosis',
      'allergies',
      'medicineName',
      'testName',
      'notes',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('carries a patient id for counting and never a patient name', () => {
    const code = strip(SOURCE);
    // `patientId` is needed: a distinct count is impossible without it, and an
    // id says nothing about who somebody is.
    expect(code).toMatch(/\bpatientId\b/);
    // A name would make this a patient list, which is what the consultation
    // ledger is for — and that endpoint has its own audit action for the reason.
    expect(code).not.toMatch(/patientName|patient\.fullName/);
  });
});
