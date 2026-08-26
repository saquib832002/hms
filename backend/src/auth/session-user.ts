import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/types/auth-user';
import {
  assignedRoles,
  resolveActiveRole,
  sortRolesForDisplay,
} from '../users/role-assignment';

/**
 * The one place the session user is assembled.
 *
 * WHY THIS EXISTS
 * ---------------
 * It was built in two places — once in `AuthService.login` for the login
 * response, once in `JwtStrategy.validate` for every request after that — and
 * they drifted the moment a field was added. `hospital` went onto the second
 * and not the first, so the currency was correct on reload and missing
 * immediately after signing in, which showed up as a dashboard in the wrong
 * currency until the page was refreshed.
 *
 * That is the same class of bug `types.drift.test.ts` exists to prevent between
 * the two clients, and it deserves the same treatment: one function, and a test
 * asserting both callers produce identical shapes.
 */

/** The row shape both callers already load. */
export interface SessionUserRow {
  id: number;
  tenantId: number;
  email: string;
  fullName: string;
  role: UserRole;
  mustChangePassword: boolean;
  doctorProfile?: { id: number } | null;
  /** Every role this person may act as. Absent for a user with none assigned. */
  roleAssignments?: { role: UserRole }[];
  tenant: {
    name: string;
    slug: string;
    timezone: string;
    currency: string;
  };
}

/**
 * @param activeRole the role this session is acting as. Must already have been
 *   checked against the user's assignments — this function trusts it.
 */
export function toSessionUser(user: SessionUserRow, activeRole?: UserRole): AuthUser {
  const available = sortRolesForDisplay(
    assignedRoles(user.roleAssignments ?? [], user.role),
  );
  const role = resolveActiveRole(activeRole, user.roleAssignments ?? [], user.role);

  return {
    userId: user.id,
    tenantId: user.tenantId,
    hospital: {
      name: user.tenant.name,
      slug: user.tenant.slug,
      timezone: user.tenant.timezone,
      currency: user.tenant.currency,
    },
    email: user.email,
    fullName: user.fullName,
    role,
    availableRoles: available,
    mustChangePassword: user.mustChangePassword,

    /*
     * doctorId ONLY while acting as a doctor.
     *
     * It is not an identifier here, it is a capability: services read it to
     * decide whose queue to show and — in PrescriptionsService — whether the
     * caller may issue a prescription at all. Leaving it set while an
     * owner-doctor is acting as ADMIN would let the administrative role
     * prescribe, which is exactly the union of permissions this design exists
     * to avoid.
     */
    ...(role === UserRole.DOCTOR && user.doctorProfile
      ? { doctorId: user.doctorProfile.id }
      : {}),
  };
}

/**
 * What both callers must `include` to satisfy `SessionUserRow`.
 *
 * Shared so a new field on the session user is one edit, not two — the second
 * of which is the one that gets forgotten.
 */
export const SESSION_USER_INCLUDE = {
  doctorProfile: { select: { id: true } },
  roleAssignments: { select: { role: true } },
  tenant: { select: { name: true, slug: true, timezone: true, currency: true } },
} as const;
