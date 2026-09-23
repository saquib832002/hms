import type { TenantModule, UserRole } from './types';

/**
 * Where each role lands, and which tabs it gets.
 *
 * WHY THIS EXISTS
 * ---------------
 * It didn't, and that was a bug nobody could see without a device. Expo Router
 * makes `index` the default route for the tab group, so *every* role landed on
 * the doctor's queue regardless of who signed in. A nurse or receptionist was
 * met with "The patient queue belongs to doctors" — a refusal message on the
 * first screen after login, on a tab they could not see in the bar.
 *
 * The web app has had `landingFor()` since Phase 1. Mobile never got the
 * equivalent; the queue being the doctor's landing screen was simply assumed to
 * be everyone's, because doctors were the only role the app was ever opened
 * with.
 *
 * Kept next to the tab definitions on purpose: a role's landing screen must be
 * a tab that role can actually see, and `role-screens.test.ts` asserts exactly
 * that.
 *
 * Reception lands on Patients rather than Today. Both are defensible — Today is
 * where check-in happens — but Patients is the screen reception reaches for
 * first: look someone up, register a new one, start a booking. Today is one tap
 * away and carries its own check-in queue.
 */

/** The tab route each role opens on. Must be a tab that role's bar shows. */
export const LANDING: Record<UserRole, string> = {
  DOCTOR: '/(tabs)',
  NURSE: '/(tabs)/ward',
  PHARMACIST: '/(tabs)/pharmacy',
  RECEPTIONIST: '/(tabs)/patients',
  BILLING_STAFF: '/(tabs)/invoices',
  ADMIN: '/(tabs)/overview',
  // The bench, not a dashboard: a technician opens the app to see what is
  // waiting for them, exactly as a pharmacist opens it on the dispensing queue.
  LAB_TECHNICIAN: '/(tabs)/lab',
};

export function landingFor(role: UserRole): string {
  return LANDING[role] ?? '/(tabs)/me';
}

/**
 * Every role, in the order a person should be offered them.
 *
 * A `Record<UserRole, string>`, which is the point: adding a member to
 * `UserRole` is a compile error here until somebody names it, and every list of
 * roles in the app derives from this rather than retyping it.
 *
 * `LAB_TECHNICIAN` was added to the enum with screens, a nav entry and a
 * landing route — and could not be *created*, because three screens across the
 * two clients hand-wrote their own arrays and none of them knew about it. A
 * doctor could raise a lab order and it was visible to nobody.
 *
 * ADMIN last, deliberately: the most powerful role should not be the first
 * thing under the cursor on a form for a new member of staff.
 */
export const ROLE_LABEL: Record<UserRole, string> = {
  DOCTOR: 'Doctor',
  NURSE: 'Nurse',
  RECEPTIONIST: 'Reception',
  PHARMACIST: 'Pharmacy',
  LAB_TECHNICIAN: 'Laboratory',
  BILLING_STAFF: 'Billing',
  ADMIN: 'Administrator',
};

/** The roles a screen may offer. Derived — never write this list by hand. */
export const ALL_ROLES = Object.keys(ROLE_LABEL) as UserRole[];

/**
 * Which module a role is worth having.
 *
 * A tenant without the laboratory must not be offered LAB_TECHNICIAN. That is
 * not tidiness — it is the mirror of a bug this project already had, where a
 * role existed everywhere except where it could be granted and a doctor's lab
 * order was visible to nobody. Here it would be an account created, able to
 * sign in, and met with a menu of nothing.
 *
 * ADMIN and RECEPTIONIST are absent deliberately: every tenant needs somebody
 * to administer it and somebody to deal with the person at the door, whatever
 * they have been sold.
 *
 * The server refuses too. This only stops the app offering what it cannot have.
 */
const ROLE_REQUIRES: Partial<Record<UserRole, TenantModule>> = {
  DOCTOR: 'CLINIC',
  NURSE: 'WARDS',
  // Reception here is the appointment book, the check-in queue and the doctors
  // list — the clinic. At a standalone pharmacy or lab the person at the
  // counter is the pharmacist or the technician.
  RECEPTIONIST: 'CLINIC',
  PHARMACIST: 'PHARMACY',
  LAB_TECHNICIAN: 'LABORATORY',
  BILLING_STAFF: 'BILLING',
};

/** The roles this hospital may actually give somebody. */
export function assignableRoles(modules?: TenantModule[]): UserRole[] {
  if (!modules) return ALL_ROLES;
  return ALL_ROLES.filter((role) => {
    const required = ROLE_REQUIRES[role];
    return required === undefined || modules.includes(required);
  });
}

/**
 * Which of the roles somebody holds they can actually act as here.
 *
 * Mirrors `web/lib/nav.ts`. A module removed at the vendor never strips an
 * assignment, so an account can still hold a role whose every screen is now
 * refused; offering it in the switcher lands them in an app with no tabs.
 */
export function actableRoles(
  available: UserRole[],
  modules?: TenantModule[],
): UserRole[] {
  const allowed = assignableRoles(modules);
  return available.filter((role) => allowed.includes(role));
}

/** Why a role is not on offer, so the screen can say rather than just omit. */
export function roleRequiresModule(role: UserRole): TenantModule | null {
  return ROLE_REQUIRES[role] ?? null;
}

/**
 * The modules, named for a human.
 *
 * A `Record<TenantModule, string>` rather than a lookup with a fallback, so a
 * sixth module is a compile error until somebody names it — the rule
 * `ROLE_LABEL` settled on after `LAB_TECHNICIAN` shipped with a menu, four
 * screens and a green suite, and no account that could hold it.
 *
 * Byte-equal to `web/lib/nav.ts`'s copy on purpose: an administrator reading
 * "Laboratory" on the desktop and something else on the phone has no way to
 * tell whether they are looking at one plan or two.
 *
 * Ordered as a hospital grows into them rather than alphabetically.
 */
export const MODULE_LABEL: Record<TenantModule, string> = {
  CLINIC: 'Clinic',
  WARDS: 'Wards',
  PHARMACY: 'Pharmacy',
  LABORATORY: 'Laboratory',
  BILLING: 'Billing',
};

/** Every module, derived. Never write this list out by hand. */
export const ALL_MODULES = Object.keys(MODULE_LABEL) as TenantModule[];
