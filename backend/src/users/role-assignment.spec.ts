import { UserRole } from '@prisma/client';
import {
  assignedRoles,
  canActAs,
  checkRoleAssignment,
  resolveActiveRole,
  sortRolesForDisplay,
} from './role-assignment';

const a = (...roles: UserRole[]) => roles.map((role) => ({ role }));

describe('which roles a person may act as', () => {
  it('includes the default even with no assignment rows', () => {
    // Every user who predates this feature. They must keep working unchanged.
    expect(assignedRoles([], UserRole.NURSE)).toEqual([UserRole.NURSE]);
  });

  it('merges assignments with the default, without duplicates', () => {
    const roles = assignedRoles(a(UserRole.DOCTOR, UserRole.ADMIN), UserRole.DOCTOR);
    expect(roles.sort()).toEqual([UserRole.ADMIN, UserRole.DOCTOR].sort());
  });

  it('refuses a role the person does not hold', () => {
    const held = a(UserRole.DOCTOR, UserRole.ADMIN);
    expect(canActAs(UserRole.ADMIN, held, UserRole.DOCTOR)).toBe(true);
    // The whole point: holding two roles is not holding all six.
    expect(canActAs(UserRole.PHARMACIST, held, UserRole.DOCTOR)).toBe(false);
  });
});

describe('which role a session starts in', () => {
  it('honours an explicit, permitted request', () => {
    expect(
      resolveActiveRole(UserRole.ADMIN, a(UserRole.DOCTOR, UserRole.ADMIN), UserRole.DOCTOR),
    ).toBe(UserRole.ADMIN);
  });

  it('ignores a request for a role the person does not hold', () => {
    // A forged or stale token claim must not grant anything.
    expect(
      resolveActiveRole(UserRole.ADMIN, a(UserRole.NURSE), UserRole.NURSE),
    ).toBe(UserRole.NURSE);
  });

  it('falls back to the stored default', () => {
    expect(resolveActiveRole(undefined, a(UserRole.DOCTOR, UserRole.ADMIN), UserRole.DOCTOR)).toBe(
      UserRole.DOCTOR,
    );
  });

  it('lands an owner-doctor in the clinical role, not the dashboard', () => {
    // ADMIN has no patient access at all, so landing there means landing
    // somewhere you cannot do the day's work from.
    expect(resolveActiveRole(undefined, a(UserRole.ADMIN, UserRole.DOCTOR), UserRole.ADMIN)).toBe(
      UserRole.ADMIN,
    );
    // …but when the default is gone, clinical wins over administrative.
    expect(sortRolesForDisplay([UserRole.ADMIN, UserRole.DOCTOR])[0]).toBe(UserRole.DOCTOR);
  });

  it('is deterministic', () => {
    // Landing somewhere different each login would be alarming in a system
    // people live in for a whole shift.
    const held = a(UserRole.BILLING_STAFF, UserRole.RECEPTIONIST);
    const first = resolveActiveRole(undefined, held, UserRole.RECEPTIONIST);
    for (let i = 0; i < 5; i++) {
      expect(resolveActiveRole(undefined, held, UserRole.RECEPTIONIST)).toBe(first);
    }
  });
});

describe('changing what someone may do', () => {
  const base = {
    current: [UserRole.DOCTOR],
    otherAdminHolders: 1,
    hasDoctorProfile: true,
  };

  it('allows an owner-doctor to be granted ADMIN', () => {
    expect(
      checkRoleAssignment({ ...base, next: [UserRole.DOCTOR, UserRole.ADMIN] }),
    ).toBeNull();
  });

  it('refuses to leave a user with no roles', () => {
    expect(checkRoleAssignment({ ...base, next: [] })?.code).toBe('NO_ROLES');
  });

  it('refuses to remove the last administrator', () => {
    expect(
      checkRoleAssignment({
        current: [UserRole.ADMIN, UserRole.DOCTOR],
        next: [UserRole.DOCTOR],
        otherAdminHolders: 0,
        hasDoctorProfile: true,
      })?.code,
    ).toBe('LAST_ADMIN');
  });

  it('counts admins by who HOLDS the role, not whose default it is', () => {
    /*
     * The subtle version of the last-admin bug. An owner whose default role is
     * DOCTOR still holds ADMIN, so removing ADMIN from someone else is safe.
     * Counting `role = ADMIN` would report zero other admins and block a
     * legitimate change — or worse, the inverse: allow the last real holder to
     * be stripped because someone else's *default* said ADMIN.
     */
    expect(
      checkRoleAssignment({
        current: [UserRole.ADMIN],
        next: [UserRole.RECEPTIONIST],
        otherAdminHolders: 1, // an owner-doctor who defaults to DOCTOR
        hasDoctorProfile: false,
      }),
    ).toBeNull();
  });

  it('refuses DOCTOR without a doctor profile', () => {
    // Appointments key on Doctor.id: the account would look right and be
    // impossible to book.
    expect(
      checkRoleAssignment({
        ...base,
        current: [UserRole.RECEPTIONIST],
        next: [UserRole.RECEPTIONIST, UserRole.DOCTOR],
        hasDoctorProfile: false,
      })?.code,
    ).toBe('DOCTOR_NEEDS_PROFILE');
  });

  it('reports no change when the set is the same in a different order', () => {
    expect(
      checkRoleAssignment({
        ...base,
        current: [UserRole.DOCTOR, UserRole.ADMIN],
        next: [UserRole.ADMIN, UserRole.DOCTOR],
      })?.code,
    ).toBe('NO_CHANGE');
  });
});
