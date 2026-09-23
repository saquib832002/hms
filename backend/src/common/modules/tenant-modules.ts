import { TenantModule, UserRole } from '@prisma/client';

/**
 * What a hospital has been sold, and what follows from it.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Not every tenant is a hospital. A standalone laboratory running on this
 * platform receives orders from partner hospitals, results them and bills for
 * them — and has no wards, no appointment book and no doctors to manage. Giving
 * it the full menu is not merely untidy: it is a screen full of features that
 * cannot work, and the first thing a new customer does is click one and find
 * out.
 *
 * WHY THIS IS NOT A ROLE
 * ----------------------
 * Roles say what a *person* may do inside a hospital that has a feature.
 * Modules say whether the hospital has it. The two answer to different people —
 * an administrator grants roles to their own staff; only the vendor grants
 * modules — and collapsing them would mean a hospital administrator could sell
 * themselves the lab.
 *
 * WHY WRITES AND NOT READS
 * ------------------------
 * The same line `SubscriptionGuard` holds, and for the same reason. A hospital
 * whose laboratory module lapses must still be able to open results it already
 * has: a clinician cannot un-know that a test was run, the record is one they
 * are usually required by law to keep, and the people harmed by hiding it are
 * not the people who made the commercial decision. Blocking new work is real
 * leverage and is safe; blocking the record is neither.
 */

/** Every module, in the order a vendor should be offered them. */
export const ALL_MODULES: TenantModule[] = [
  TenantModule.CLINIC,
  TenantModule.WARDS,
  TenantModule.PHARMACY,
  TenantModule.LABORATORY,
  TenantModule.BILLING,
];

export const MODULE_LABEL: Record<TenantModule, string> = {
  CLINIC: 'Outpatient clinic',
  WARDS: 'Inpatient wards',
  PHARMACY: 'Pharmacy',
  LABORATORY: 'Laboratory',
  BILLING: 'Hospital billing',
};

/**
 * What each one actually turns on, in words a salesperson and a hospital
 * administrator would both recognise.
 *
 * Shown on the vendor console beside the switch, because "LABORATORY" on its
 * own does not tell somebody whether it includes the till.
 */
export const MODULE_DESCRIPTION: Record<TenantModule, string> = {
  CLINIC:
    'Appointments, the doctor’s queue, consultation records and prescribing. A hospital without this is a lab or a pharmacy taking work from elsewhere.',
  WARDS:
    'Admissions, the ward board, vitals, the drug round, observation orders and ward requests. Needs the clinic module to be useful — somebody has to admit the patient.',
  PHARMACY:
    'Dispensing, stock, counter sales, the pharmacy till and partner pharmacies. Complete on its own: a standalone chemist can take referrals and sell over the counter.',
  LABORATORY:
    'The test catalogue, the worklist, result entry and authorisation, reports, the lab till and partner labs. Complete on its own: a standalone lab can take referrals and bill for them.',
  BILLING:
    'Hospital invoices, payments, aging and the finance reports. The pharmacy and lab tills come with their own modules — a standalone shop can take money without this.',
};

/**
 * Which module a role is worth having.
 *
 * A tenant without the laboratory must not be able to create a LAB_TECHNICIAN.
 * That is not tidiness — it is the exact failure this project has already had:
 * a role that existed everywhere except where it could be used, and a doctor's
 * order visible to nobody because no account could hold the role that opens the
 * worklist. Here it would be the mirror image: an account created, able to sign
 * in, and met with a menu of nothing.
 *
 * ADMIN is the only role every tenant gets, and it has to be: somebody must be
 * able to administer the hospital, and a tenant nobody can administer is one
 * that needs the vendor for every staff change.
 *
 * RECEPTIONIST FOLLOWS THE CLINIC, AND FIRST DID NOT
 * --------------------------------------------------
 * It was always-on beside ADMIN, on the reasoning that every business has
 * somebody at the door. That is true and is not the same as needing this
 * product's reception role: reception here is the appointment book, the
 * check-in queue and the doctors list, which is the clinic. At a standalone
 * pharmacy or laboratory the person at the counter is the pharmacist or the
 * technician, and offering RECEPTIONIST there created an account whose whole
 * app was the patient list.
 *
 * Reported from use, and the same shape as LAB_TECHNICIAN existing everywhere
 * except where it could be granted — one direction produces a role nobody can
 * hold, the other a role with nothing to do.
 */
const ROLE_REQUIRES: Partial<Record<UserRole, TenantModule>> = {
  DOCTOR: TenantModule.CLINIC,
  NURSE: TenantModule.WARDS,
  RECEPTIONIST: TenantModule.CLINIC,
  PHARMACIST: TenantModule.PHARMACY,
  LAB_TECHNICIAN: TenantModule.LABORATORY,
  BILLING_STAFF: TenantModule.BILLING,
};

export function hasModule(modules: TenantModule[], required: TenantModule): boolean {
  return modules.includes(required);
}

/**
 * The roles a tenant may actually give somebody.
 *
 * Used by the client to build the picker and by the server to refuse — the
 * client list is a usability boundary and this is the real one, exactly as
 * with `@Roles()`.
 */
export function assignableRoles(modules: TenantModule[]): UserRole[] {
  return (Object.keys(ROLE_LABELS) as UserRole[]).filter((role) => {
    const required = ROLE_REQUIRES[role];
    return required === undefined || modules.includes(required);
  });
}

/** Why a role cannot be granted, for a message somebody can act on. */
export function roleBlockedBy(role: UserRole): TenantModule | null {
  return ROLE_REQUIRES[role] ?? null;
}

/**
 * Every role, exhaustively.
 *
 * A `Record<UserRole, true>` rather than an array, so adding a member to the
 * enum is a compile error here until somebody decides which module it belongs
 * to — the same mechanism that stopped `ALL_ROLES` drifting on the clients
 * after LAB_TECHNICIAN was added to the enum and to nothing else.
 */
const ROLE_LABELS: Record<UserRole, true> = {
  DOCTOR: true,
  NURSE: true,
  RECEPTIONIST: true,
  PHARMACIST: true,
  LAB_TECHNICIAN: true,
  BILLING_STAFF: true,
  ADMIN: true,
};

/**
 * The refusal, in words the person reading it can act on.
 *
 * Named after the module rather than the route, and it says who can change it.
 * A receptionist reading "Forbidden" has no idea whether they have done
 * something wrong, whether the system is broken, or whom to telephone.
 */
export function moduleRefusal(module: TenantModule): string {
  return `${MODULE_LABEL[module]} is not part of your hospital’s plan, so this is not available. Your provider can add it.`;
}
