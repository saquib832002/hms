import { AppointmentStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { hospitalDayRange } from '../utils/hospital-time';

/**
 * Which patients a given doctor may write about.
 *
 * WHY THIS IS ONE FILE AND NOT TWO CHECKS
 * ---------------------------------------
 * Prescribing and record-writing each had their own copy of "an appointment
 * with you, today". Two copies of a rule drift, and this repo has already paid
 * for that once: the audit interceptor and the exception filter carried
 * separate target extractors, one of them was wrong for nested routes, and
 * nothing noticed until a live run showed `target=-` on exactly the endpoints
 * where it mattered.
 *
 * They also have to agree for a reason that is not tidiness. A doctor who may
 * prescribe for a patient but may not record why has produced a medication
 * with no clinical justification attached to it — which is worse than either
 * restriction alone, and is what would have happened if only the prescribing
 * rule had been widened.
 *
 * WHAT THE RULE IS
 * ----------------
 * A relationship, not a role. `@Roles(DOCTOR)` says doctors may write records,
 * which is true and insufficient — without this, any doctor could write a
 * diagnosis against any patient in the hospital. Three things establish the
 * relationship:
 *
 *   1. An appointment with this doctor in the last `PRESCRIBING_WINDOW_DAYS`.
 *   2. A currently open admission — the patient is in a bed here.
 *
 * The first used to be "today", which is not how medicine works: a patient
 * rings about a rash that has not settled, or needs another month of the same
 * tablets, and no new appointment exists. The second was missing entirely, so
 * a doctor could not prescribe for or write about somebody admitted to their
 * own hospital.
 *
 * It is deliberately *not* "any patient this doctor has ever seen". That is a
 * list rather than a relationship: somebody seen once three years ago is no
 * longer under this doctor's care, and prescribing for them without seeing
 * them again is precisely the act this check exists to keep deliberate.
 */

/**
 * How long after seeing a patient a doctor may still write for them.
 *
 * 90 days is a judgement, not a regulation — long enough for a course of
 * treatment and its follow-up, short enough that a doctor rewriting for
 * somebody they have lost track of has to see them again. One place, so it
 * cannot mean different things in two services, and the obvious candidate for
 * a per-tenant setting later.
 */
export const PRESCRIBING_WINDOW_DAYS = 90;

/**
 * Statuses that mean the patient actually attended.
 *
 * SCHEDULED is absent: a booking is not an encounter, and treating it as one
 * would let a doctor prescribe for anybody simply by having an appointment put
 * in the diary. CANCELLED and NO_SHOW are absent for the stronger version of
 * the same reason — nobody was seen.
 */
export const ATTENDED = [
  AppointmentStatus.CHECKED_IN,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.COMPLETED,
];

export interface TreatingScope {
  /**
   * The most recent qualifying appointment, or null when the only basis is an
   * open admission.
   */
  appointment: { id: number; scheduledAt: Date; hasPrescription: boolean } | null;

  /** An open admission for this patient, if there is one. */
  admissionId: number | null;

  /**
   * Whether that appointment is happening today.
   *
   * The caller needs this because *linking* is narrower than *permitting*. A
   * repeat written six weeks later must not attach itself to the consultation
   * it followed from: that would put it on that visit's record and, since
   * `Invoice.appointmentId` is unique and billing reads the link, on that
   * visit's bill.
   */
  sameDay: boolean;
}

export async function resolveTreatingScope(
  prisma: PrismaService,
  timezone: string,
  doctorId: number,
  patientId: number,
): Promise<TreatingScope | null> {
  const { start, end } = hospitalDayRange(new Date(), timezone);

  const since = new Date();
  since.setDate(since.getDate() - PRESCRIBING_WINDOW_DAYS);

  const appointment = await prisma.appointment.findFirst({
    where: {
      doctorId,
      patientId,
      scheduledAt: { gte: since },
      status: { in: ATTENDED },
    },
    // Most recent first. With a window rather than a single day there are
    // usually several, and the newest is the one this follows from.
    orderBy: { scheduledAt: 'desc' },
    select: { id: true, scheduledAt: true, prescription: { select: { id: true } } },
  });

  /*
   * `currentPatientId` is the mirrored column that is NULL once discharged and
   * unique while admitted, so this is "in a bed right now" rather than "has
   * ever been admitted".
   *
   * Not restricted to the admitting doctor. Ward cover is the normal case and
   * the doctor on the ward at 3am is routinely not the one who admitted.
   */
  const admission = appointment
    ? null
    : await prisma.admission.findFirst({
        where: { currentPatientId: patientId },
        select: { id: true },
      });

  if (!appointment && !admission) return null;

  return {
    appointment: appointment
      ? {
          id: appointment.id,
          scheduledAt: appointment.scheduledAt,
          hasPrescription: appointment.prescription !== null,
        }
      : null,
    admissionId: admission?.id ?? null,
    sameDay:
      appointment !== null && appointment.scheduledAt >= start && appointment.scheduledAt < end,
  };
}

/** One wording, so the two callers cannot explain the same refusal differently. */
export const NOT_TREATING = `You can only write for patients you have seen in the last ${PRESCRIBING_WINDOW_DAYS} days, or who are admitted here`;
