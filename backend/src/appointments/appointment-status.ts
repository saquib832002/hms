import { AppointmentStatus, UserRole } from '@prisma/client';

/**
 * The appointment lifecycle, as a table rather than a pile of if-statements.
 *
 *   SCHEDULED ──► CHECKED_IN ──► IN_PROGRESS ──► COMPLETED
 *       │              │
 *       ├──► CANCELLED ┤
 *       └──► NO_SHOW ◄─┘
 *
 * COMPLETED, CANCELLED and NO_SHOW are terminal. Nothing moves backwards:
 * an appointment marked COMPLETED cannot be reopened, because a record and
 * possibly a prescription have already been written against it, and quietly
 * rewinding the state would leave those orphaned.
 *
 * Correcting a genuine mistake is a new appointment, not an edit — that keeps
 * the audit trail honest about what actually happened.
 */
export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  [AppointmentStatus.SCHEDULED]: [
    AppointmentStatus.CHECKED_IN,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  [AppointmentStatus.CHECKED_IN]: [
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  [AppointmentStatus.IN_PROGRESS]: [AppointmentStatus.COMPLETED],
  [AppointmentStatus.COMPLETED]: [],
  [AppointmentStatus.CANCELLED]: [],
  [AppointmentStatus.NO_SHOW]: [],
};

/**
 * Which role may perform which transition.
 *
 * Reception runs the front desk: arrivals, no-shows, cancellations. Clinical
 * progress is the doctor's to declare — reception cannot mark a consultation
 * complete, because they are not the one who did it.
 */
const TRANSITION_ROLES: Partial<Record<AppointmentStatus, UserRole[]>> = {
  [AppointmentStatus.CHECKED_IN]: [UserRole.ADMIN, UserRole.RECEPTIONIST],
  [AppointmentStatus.NO_SHOW]: [UserRole.ADMIN, UserRole.RECEPTIONIST],
  [AppointmentStatus.CANCELLED]: [UserRole.ADMIN, UserRole.RECEPTIONIST],
  [AppointmentStatus.IN_PROGRESS]: [UserRole.ADMIN, UserRole.DOCTOR],
  [AppointmentStatus.COMPLETED]: [UserRole.ADMIN, UserRole.DOCTOR],
};

export function isValidTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function roleMayTransitionTo(role: UserRole, to: AppointmentStatus): boolean {
  return TRANSITION_ROLES[to]?.includes(role) ?? false;
}

export function isTerminal(status: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
