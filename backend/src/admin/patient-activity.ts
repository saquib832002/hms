/**
 * How many patients came through, and what each doctor did with them.
 *
 * WHAT WAS ASKED FOR
 * ------------------
 * *"In your dashboard it is missing how many patients registered or had an
 * appointment today, for last seven days or last month, and how many patients a
 * doctor has seen and how much total collection from those patients."*
 *
 * The dashboard had appointment *counts* and a doctor *headcount* and nothing
 * joining the two, so the one question a clinic owner actually opens a
 * dashboard with — did the day's work turn into money, and which doctor did it
 * — was answerable only by reading three screens and doing arithmetic.
 *
 * WHAT CROSSES AND WHAT DOES NOT
 * ------------------------------
 * Counts and money, per doctor. No patient name, no `Appointment.reason`, no
 * diagnosis, no prescription contents. That line is the one
 * `reports.spec.ts` already enforces for `doctorsReport` and
 * `staffActivityReport`, and it is the same here: *"admin sees attendance and
 * money, never clinical content"*.
 *
 * A doctor's name is staff data and crosses freely. `patientsSeen` is a
 * **distinct count**, which says nothing about who they were — and the named
 * drill-down already exists as `GET /admin/reports/consultations`, which
 * carries `ADMIN_CONSULTATION_LEDGER` as its own audit action precisely so
 * *"who looked up our patient list, and when"* stays answerable. Both clients
 * link the counts there rather than this endpoint growing names.
 *
 * `reason` is the field to watch. It is typed by reception at booking, it is
 * routinely "chest pain", and it sits on the same row as everything here — one
 * careless `include` away. The spec asserts the word never appears in the
 * service method that builds this.
 */

/** One appointment, reduced to what a count needs. */
export interface ActivityAppointment {
  doctorId: number | null;
  patientId: number;
  status: string;
  /** Minor units billed against this appointment's invoice, if one was raised. */
  billedMinor: number;
  /** Minor units actually received against it. */
  collectedMinor: number;
}

/**
 * Statuses that mean the patient was actually seen.
 *
 * SCHEDULED is deliberately absent — a diary entry is not attendance, and
 * counting it would let tomorrow's bookings inflate today's "seen". The same
 * reasoning keeps SCHEDULED out of `resolveTreatingScope`.
 */
export const ATTENDED_STATUSES: readonly string[] = ['COMPLETED', 'IN_PROGRESS'];

/** CHECKED_IN is arrival without a consultation yet — counted as neither. */
export const NO_SHOW_STATUS = 'NO_SHOW';

export interface DoctorActivityRow {
  doctorId: number;
  name: string;
  /** Distinct patients with an attended appointment in the period. */
  patientsSeen: number;
  /** Attended appointments, which exceeds `patientsSeen` when somebody returned. */
  consultations: number;
  noShows: number;
  billed: string;
  collected: string;
}

export interface PatientActivity {
  /** `Patient` rows created in the period, excluding referral-origin records. */
  registered: number;
  /** Appointments scheduled to fall inside the period, whatever their outcome. */
  appointments: number;
  attended: number;
  noShows: number;
  /** Blunt but useful: how much clinic time was wasted. */
  noShowRate: number;
  /**
   * Distinct patients seen across the whole hospital.
   *
   * Deliberately **not** the sum of the per-doctor figures: one patient seen by
   * two doctors in the period is one patient here and one in each of their
   * rows. Summing the rows would double-count them, and a hospital total larger
   * than its own patient list is the kind of figure nobody can explain.
   */
  patientsSeen: number;
  billed: string;
  collected: string;
  byDoctor: DoctorActivityRow[];
}

import { fromMinor, sumMinor } from '../billing/money';

/**
 * Totals and a row per doctor.
 *
 * Doctors with nothing in the period are **kept**, at zero. A doctor who saw
 * nobody is exactly who an owner reconciling a quiet week wants to see, and a
 * missing row and a zero row look identical while meaning opposite things —
 * the same argument as the payment-method split listing a method that took
 * nothing.
 *
 * Appointments with no doctor are counted in the hospital totals and in no
 * row, because there is no row they belong to. That is a real state: a booking
 * whose doctor was later deactivated keeps its `doctorId`, but a walk-in
 * recorded against nobody does not.
 */
export function patientActivity(
  appointments: ActivityAppointment[],
  doctors: { id: number; name: string }[],
  registered: number,
): PatientActivity {
  const attended = appointments.filter((a) => ATTENDED_STATUSES.includes(a.status));
  const noShows = appointments.filter((a) => a.status === NO_SHOW_STATUS);

  const byDoctor: DoctorActivityRow[] = doctors
    .map((doctor) => {
      const mine = attended.filter((a) => a.doctorId === doctor.id);
      return {
        doctorId: doctor.id,
        name: doctor.name,
        patientsSeen: new Set(mine.map((a) => a.patientId)).size,
        consultations: mine.length,
        noShows: noShows.filter((a) => a.doctorId === doctor.id).length,
        billed: fromMinor(sumMinor(mine.map((a) => a.billedMinor))),
        collected: fromMinor(sumMinor(mine.map((a) => a.collectedMinor))),
      };
    })
    /*
     * Busiest first, then by name. Stable between two runs of the same report,
     * because a list that reshuffles when nothing changed is one people stop
     * trusting — and alphabetical would bury the figure worth reading.
     */
    .sort(
      (a, b) =>
        b.consultations - a.consultations ||
        b.patientsSeen - a.patientsSeen ||
        a.name.localeCompare(b.name),
    );

  return {
    registered,
    appointments: appointments.length,
    attended: attended.length,
    noShows: noShows.length,
    noShowRate:
      appointments.length > 0 ? Math.round((noShows.length / appointments.length) * 100) : 0,
    patientsSeen: new Set(attended.map((a) => a.patientId)).size,
    billed: fromMinor(sumMinor(attended.map((a) => a.billedMinor))),
    collected: fromMinor(sumMinor(attended.map((a) => a.collectedMinor))),
    byDoctor,
  };
}
