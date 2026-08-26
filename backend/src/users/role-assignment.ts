import { UserRole } from '@prisma/client';

/**
 * Which roles a person may act as, and which one they are acting as now.
 *
 * Pure functions, no Prisma — the rules here decide who can reach patient
 * records, and they should be testable without a database standing up.
 *
 * THE RULE THAT SHAPES EVERYTHING ELSE
 * ------------------------------------
 * A user may hold several roles and acts as exactly ONE at a time. The union
 * is never granted. `CLAUDE.md` puts ADMIN outside clinical access, and an
 * owner-doctor holding both at once would make the admin surface clinical —
 * retiring minimum-necessary and invalidating `access-matrix.spec.ts`, which
 * describes routes in terms of a single role.
 */

/** Roles a person may switch into: their assignments, plus their default. */
export function assignedRoles(
  assignments: { role: UserRole }[],
  defaultRole: UserRole,
): UserRole[] {
  const set = new Set<UserRole>(assignments.map((a) => a.role));
  // The default is always available even if no assignment row exists — that is
  // every user who predates this feature, and they must keep working.
  set.add(defaultRole);
  return [...set];
}

/** May this person act as this role right now? */
export function canActAs(
  role: UserRole,
  assignments: { role: UserRole }[],
  defaultRole: UserRole,
): boolean {
  return assignedRoles(assignments, defaultRole).includes(role);
}

export interface RoleChangeViolation {
  code:
    | 'LAST_ADMIN'
    | 'NO_ROLES'
    | 'NOT_ASSIGNED'
    | 'DOCTOR_NEEDS_PROFILE'
    | 'NO_CHANGE';
  message: string;
}

/**
 * Can this set of roles be saved for this user?
 *
 * @param otherAdminHolders how many OTHER active users *hold* ADMIN — held,
 *   not defaulted to. Counting `role = ADMIN` instead is the subtle version of
 *   this bug: an owner-doctor whose default is DOCTOR still holds ADMIN, and
 *   counting defaults would let the last real administrator be removed while
 *   the count looked healthy.
 */
export function checkRoleAssignment(input: {
  next: UserRole[];
  current: UserRole[];
  otherAdminHolders: number;
  hasDoctorProfile: boolean;
}): RoleChangeViolation | null {
  const { next, current, otherAdminHolders, hasDoctorProfile } = input;

  if (next.length === 0) {
    return {
      code: 'NO_ROLES',
      message: 'A user must keep at least one role. Deactivate the account instead.',
    };
  }

  const same =
    next.length === current.length && next.every((r) => current.includes(r));
  if (same) return { code: 'NO_CHANGE', message: 'No change' };

  // Removing ADMIN from the only person who holds it locks everyone out of
  // user management — recoverable only from a database console.
  if (current.includes(UserRole.ADMIN) && !next.includes(UserRole.ADMIN) && otherAdminHolders === 0) {
    return {
      code: 'LAST_ADMIN',
      message:
        'This is the only administrator. Give someone else the ADMIN role first.',
    };
  }

  // A DOCTOR role without a Doctor profile cannot hold a clinic: appointments
  // key on Doctor.id, so the account would look fine and be unbookable.
  if (next.includes(UserRole.DOCTOR) && !hasDoctorProfile) {
    return {
      code: 'DOCTOR_NEEDS_PROFILE',
      message:
        'Create the doctor profile before granting the DOCTOR role — without one they cannot be booked.',
    };
  }

  return null;
}

/**
 * Where a person lands when they sign in.
 *
 * Their stored default if they still hold it, otherwise the first assigned
 * role in a fixed order. Never arbitrary: landing somewhere different each
 * login would be alarming in a system people use for eight-hour shifts.
 */
const LANDING_ORDER: UserRole[] = [
  UserRole.DOCTOR,
  UserRole.NURSE,
  UserRole.RECEPTIONIST,
  UserRole.PHARMACIST,
  UserRole.BILLING_STAFF,
  UserRole.ADMIN,
];

export function resolveActiveRole(
  requested: UserRole | undefined,
  assignments: { role: UserRole }[],
  defaultRole: UserRole,
): UserRole {
  const available = assignedRoles(assignments, defaultRole);

  if (requested && available.includes(requested)) return requested;
  if (available.includes(defaultRole)) return defaultRole;

  return LANDING_ORDER.find((r) => available.includes(r)) ?? defaultRole;
}

/**
 * ADMIN last, deliberately.
 *
 * If someone is both an owner and a doctor, the clinical role is the one they
 * spend the day in; landing them on a management dashboard would be wrong more
 * often than not, and it is the role with no patient access to get work done in.
 */
export function sortRolesForDisplay(roles: UserRole[]): UserRole[] {
  return [...roles].sort(
    (a, b) => LANDING_ORDER.indexOf(a) - LANDING_ORDER.indexOf(b),
  );
}
