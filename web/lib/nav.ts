import type { TenantModule, UserRole } from './types';

/**
 * Role → navigation. Mirrors docs/role-navigation.md.
 *
 * This hides things for usability. It is NOT the security boundary — the API
 * enforces that, and assumes any client can call any endpoint directly. If
 * this file and the backend's @Roles() ever disagree, the backend wins and
 * this file is the bug.
 */

export interface NavItem {
  label: string;
  href: string;
  icon: string;
  /**
   * The part of the product this screen belongs to.
   *
   * Absent means always on — patients, staff, settings, the audit log. A
   * "module" nobody can turn off is not a module, it is the product.
   *
   * Hiding a screen here is a usability boundary and nothing more, exactly as
   * with roles: `ModuleGuard` is what actually refuses, and it assumes any
   * client can call any endpoint.
   */
  module?: TenantModule;
  /** Not built yet — rendered as a placeholder rather than a broken link. */
  phase?: number;
}

const NAV: Record<UserRole, NavItem[]> = {
  DOCTOR: [
    // CLINIC, and it was untagged for exactly as long as modules existed. The
    // queue is `GET /me/queue`, which lives under `src/me/` and is gated —
    // so a doctor at a pharmacy-only tenant landed here, first thing after
    // signing in, and met a 403. The menu and the guard disagreeing is worse
    // than either being wrong alone.
    { label: "Today's Queue", href: '/queue', icon: '▤', module: 'CLINIC' },
    // Nurses asking for something not on a patient's chart. A prescriber
    // answers by writing it or declining with a reason — never by the nurse
    // adding it themselves.
    { label: 'Ward Requests', href: '/requests', icon: '✎', module: 'WARDS' },
    // Results the lab has authorised. Unverified values are deliberately not
    // shown here — a number on a bench is not something a clinician should
    // act on, and the API withholds them until the lab stands behind them.
    { label: 'Lab Results', href: '/lab/results', icon: '⌸', module: 'LABORATORY' },
    { label: 'Appointments', href: '/appointments', icon: '▦', module: 'CLINIC' },
    { label: 'Patients', href: '/patients', icon: '◍' },
  ],
  RECEPTIONIST: [
    { label: 'Check-in Queue', href: '/check-in', icon: '▤', module: 'CLINIC' },
    { label: 'Appointments', href: '/appointments', icon: '▦', module: 'CLINIC' },
    { label: 'Register Patient', href: '/patients/new', icon: '+' },
    { label: 'Patients', href: '/patients', icon: '◍' },
    { label: 'Doctors', href: '/doctors', icon: '✚', module: 'CLINIC' },
  ],
  NURSE: [
    { label: 'Ward Board', href: '/ward', icon: '▥', module: 'WARDS' },
    { label: 'Vitals', href: '/vitals', icon: '♥', module: 'WARDS' },
    { label: 'Medications', href: '/medications', icon: '℞', module: 'WARDS' },
    { label: 'Appointments', href: '/appointments', icon: '▦', module: 'CLINIC' },
    { label: 'Patients', href: '/patients', icon: '◍' },
  ],
  PHARMACIST: [
    /*
     * The queue is first because the first item is the landing screen, and a
     * pharmacist's day is the counter rather than the figures. The dashboard
     * went above it when it was added and quietly changed where the role opens
     * — `nav.test.ts` says "lands on the dispensing queue" and was the only
     * thing that noticed. Mobile lands them on Dispense for the same reason.
     */
    { label: 'Prescription Queue', href: '/pharmacy/queue', icon: '▤', module: 'PHARMACY' },
    { label: 'Pharmacy Dashboard', href: '/pharmacy/dashboard', icon: '▨', module: 'PHARMACY' },
    { label: 'Incoming', href: '/pharmacy/referrals', icon: '↧', module: 'PHARMACY' },
    // Wards asking for stock of something already prescribed. Logistics, not
    // a clinical decision — that one goes to a doctor, not here.
    //
    // Tagged WARDS rather than PHARMACY, which reads oddly on a pharmacy
    // screen and is right: a nav item only has to declare the modules its
    // *role* does not already imply, and a PHARMACIST cannot exist without
    // PHARMACY. What this screen actually needs is a ward to ask, so at a
    // standalone pharmacy it is furniture over an endpoint that refuses.
    { label: 'Ward Supply', href: '/pharmacy/supply', icon: '⇧', module: 'WARDS' },
    { label: 'Counter Sale', href: '/pharmacy/sell', icon: '＄', module: 'PHARMACY' },
    { label: 'Pharmacy Invoices', href: '/pharmacy/invoices', icon: '▤', module: 'PHARMACY' },
    { label: 'Inventory', href: '/pharmacy/inventory', icon: '▨', module: 'PHARMACY' },
    { label: 'Patients', href: '/patients', icon: '◍' },
  ],
  /**
   * The lab bench.
   *
   * Its own role rather than an extension of PHARMACIST: a pharmacist who can
   * read every blood result in the hospital is a minimum-necessary failure, and
   * in any hospital bigger than one room these are different people. A small
   * clinic where they are the same person is what multi-role assignment is for.
   */
  LAB_TECHNICIAN: [
    { label: 'Worklist', href: '/lab/worklist', icon: '▤', module: 'LABORATORY' },
    { label: 'Incoming', href: '/lab/referrals', icon: '↧', module: 'LABORATORY' },
    { label: 'Lab Invoices', href: '/lab/invoices', icon: '＄', module: 'LABORATORY' },
    { label: 'Test Catalogue', href: '/lab/catalogue', icon: '⌸', module: 'LABORATORY' },
  ],
  BILLING_STAFF: [
    { label: 'Invoices', href: '/billing/invoices', icon: '▤', module: 'BILLING' },
    { label: 'Payments', href: '/billing/payments', icon: '＄', module: 'BILLING' },
    // What we owe other hospitals for tests we sent out. Money going the other
    // way from everything else on this menu, and invisible from this side
    // until it existed — the lab's invoice lives in the lab's tenant.
    { label: 'Partner Lab Bills', href: '/lab-charges', icon: '⇆', module: 'LABORATORY' },
    { label: 'Patients', href: '/patients', icon: '◍' },
  ],
  ADMIN: [
    { label: 'Dashboard', href: '/admin', icon: '▨' },
    { label: 'Reports', href: '/admin/reports', icon: '◪' },
    { label: 'Daily Activity', href: '/admin/activity', icon: '☰' },
    { label: 'Staff & Users', href: '/admin/users', icon: '◍' },
    { label: 'Departments', href: '/admin/departments', icon: '▢' },
    // Without at least one ward with beds, nobody can be admitted and the
    // nurse's ward board and drug round are both empty. It was seed-only for
    // six phases, which is why that emptiness was reported as a hung backend.
    { label: 'Wards & Beds', href: '/admin/wards', icon: '▥', module: 'WARDS' },
    // What prints at the top of every prescription, invoice and note. The
    // renderer used to hard-code the demo seed's hospital name onto every
    // tenant's documents; this is where a hospital states its own.
    { label: 'Letterhead', href: '/admin/letterhead', icon: '▤' },
    { label: 'Clinic Settings', href: '/admin/settings', icon: '⚙' },
    { label: 'Partner Pharmacies', href: '/admin/partners', icon: '⇄', module: 'PHARMACY' },
    // Both halves of the diagnostics setup a hospital does once, at a desk:
    // what it offers and what it charges, and which other labs it may send
    // work to. Seed-only catalogues have broken this system three times.
    { label: 'Lab Tests', href: '/admin/lab-tests', icon: '⌸', module: 'LABORATORY' },
    { label: 'Partner Labs', href: '/admin/lab-partners', icon: '⇆', module: 'LABORATORY' },
    { label: 'Partner Lab Bills', href: '/lab-charges', icon: '＄', module: 'LABORATORY' },
    { label: 'Tax Rates', href: '/admin/tax', icon: '%', module: 'BILLING' },
    { label: 'Doctors', href: '/doctors', icon: '✚', module: 'CLINIC' },
    { label: 'Appointments', href: '/appointments', icon: '▦', module: 'CLINIC' },
    { label: 'Patients', href: '/patients', icon: '◍' },
    { label: 'Audit Log', href: '/audit', icon: '⌾' },
  ],
};

/**
 * The menu for a role, narrowed to what the hospital has been sold.
 *
 * `modules` is optional so every existing caller keeps its meaning: omitted
 * means "do not narrow", which is what a full hospital sees anyway. The shell
 * passes the real list.
 *
 * A lab-only tenant should not be looking at a ward board it can never use —
 * not because it would leak anything, but because a menu of features that
 * cannot work is how a new customer's first ten minutes go wrong.
 */
export function navFor(role: UserRole, modules?: TenantModule[]): NavItem[] {
  const items = NAV[role] ?? [];
  if (!modules) return items;
  return items.filter((item) => !item.module || modules.includes(item.module));
}

/**
 * Where a role lands after login — the screen it spends the day on.
 *
 * Narrowed too, and it has to be. Landing somebody on the first screen of a
 * menu they cannot see is exactly the bug mobile had, where every role opened
 * on the doctor's queue and met a refusal as its first impression.
 */
export function landingFor(role: UserRole, modules?: TenantModule[]): string {
  return navFor(role, modules)[0]?.href ?? '/patients';
}

/**
 * Does this role have any screen at all here?
 *
 * A role whose every screen belongs to a module the hospital does not have has
 * an empty menu, and `landingFor` then falls back to `/patients` — which
 * `canReach` refuses for a role with no Patients item. The layout redirected to
 * it, was refused, and redirected again: an infinite spinner with nothing on
 * screen saying why.
 *
 * That state is reachable only by a grandfathered account — roles follow
 * modules when they are granted, and somebody who already held one keeps it
 * when the module goes. Rare, and exactly the person least able to guess what
 * happened, so it is answered with a sentence rather than a loop.
 */
export function hasAnyScreen(role: UserRole, modules?: TenantModule[]): boolean {
  const landing = landingFor(role, modules);
  return navFor(role, modules).length > 0 && canReach(role, landing, modules);
}

/**
 * Which roles may reach a given screen, derived from NAV rather than declared
 * separately.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE MENU
 * ----------------------------------------
 * Hiding a link stops nobody from arriving at the URL. An administrator signed
 * in with `?next=/queue` still in the address bar — carried over from whoever
 * used the browser last — landed on the doctor's queue, which called
 * `GET /me/queue` and got a 403. The API refused, exactly as designed, so
 * nothing leaked. But the screen was broken, and the attempt was written into
 * the hospital's audit log as a denied clinical access by an admin: a security
 * event that reads as somebody probing, generated by the app itself.
 *
 * A rule that only shapes a menu is a rule that holds until the first URL is
 * typed.
 *
 * NOT A SECURITY BOUNDARY, STILL
 * ------------------------------
 * The API remains the boundary and assumes any client can call any endpoint.
 * This stops the app from *asking* for what its own role cannot have.
 */
const ROUTE_ROLES: Record<string, UserRole[]> = (() => {
  const map: Record<string, UserRole[]> = {};
  for (const role of Object.keys(NAV) as UserRole[]) {
    for (const item of NAV[role]) (map[item.href] ??= []).push(role);
  }
  return map;
})();

/** Every screen the app renders. Unknown paths are 404s, not denials. */
export function isKnownRoute(path: string): boolean {
  return normalise(path) in ROUTE_ROLES;
}

/**
 * May this role open this screen?
 *
 * Unknown paths return `true`: a typo should reach Next's not-found page, not
 * be silently rewritten to the role's landing screen as though it were
 * forbidden. Only a route that exists *and* belongs to other roles is refused.
 */
export function canReach(role: UserRole, path: string, modules?: TenantModule[]): boolean {
  const roles = ROUTE_ROLES[normalise(path)];
  if (!roles) return true;
  if (!roles.includes(role)) return false;

  /*
   * A screen belonging to a module the hospital has not bought is unreachable
   * for the same reason one belonging to another role is: the app should not
   * ask for what it cannot have. Without this a bookmarked `/lab/worklist` at a
   * pharmacy-only tenant renders an empty screen and fills their audit log with
   * refusals nobody caused — the same failure `?next=/queue` produced for an
   * administrator.
   */
  if (!modules) return true;
  const required = ROUTE_MODULE[normalise(path)];
  return !required || modules.includes(required);
}

/** Screen → the module it belongs to, derived from NAV exactly as ROUTE_ROLES is. */
const ROUTE_MODULE: Record<string, TenantModule> = (() => {
  const map: Record<string, TenantModule> = {};
  for (const role of Object.keys(NAV) as UserRole[]) {
    for (const item of NAV[role]) if (item.module) map[item.href] = item.module;
  }
  return map;
})();

/** Strips the query, hash and any trailing slash. `/patients/` is `/patients`. */
function normalise(path: string): string {
  const bare = path.split(/[?#]/)[0];
  return bare.length > 1 && bare.endsWith('/') ? bare.slice(0, -1) : bare;
}

/**
 * Every role, in the order a person should be offered them.
 *
 * A `Record<UserRole, string>`, which is the point: adding a member to
 * `UserRole` is a **compile error** here until somebody decides what it is
 * called. Every list of roles in the app is derived from this, so there is one
 * place to change and no way to half-change it.
 *
 * WHY THAT MATTERS MORE THAN IT LOOKS
 * -----------------------------------
 * `LAB_TECHNICIAN` was added to the enum, given a nav menu, a landing screen
 * and four working screens — and could not be *created*. Three separate screens
 * hand-wrote their own array of roles, none of them knew about the new one, so
 * no account could ever hold it. The result: a doctor could order a test, the
 * order was written correctly, and it was visible to nobody, because the only
 * role that can open the worklist could not exist.
 *
 * Clinical roles first and ADMIN last, deliberately: on a form where somebody
 * picks a role for a new member of staff, the most powerful one should not be
 * the first thing under the cursor.
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

/**
 * The roles a screen may offer, derived rather than retyped.
 *
 * Never write this list out by hand again. A hand-written copy compiles
 * perfectly while being wrong, and the thing it breaks is invisible from the
 * screen that contains it.
 */
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
 * ADMIN is absent deliberately and is the only one: somebody must be able to
 * administer the hospital whatever it was sold.
 *
 * RECEPTIONIST requires the clinic, which it did not at first. Reception here
 * is the appointment book, the check-in queue and the doctors list — the
 * clinic. At a standalone pharmacy or laboratory the person at the counter is
 * the pharmacist or the technician, and offering the role there produced an
 * account whose entire app was the patient list.
 *
 * Mirrors `backend/src/common/modules/tenant-modules.ts`. The server refuses
 * too; this only stops the app offering what it cannot have.
 */
const ROLE_REQUIRES: Partial<Record<UserRole, TenantModule>> = {
  DOCTOR: 'CLINIC',
  NURSE: 'WARDS',
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
 * `availableRoles` is what the person was granted; this is what is worth
 * wearing at this hospital today. The two differ because a module removed at
 * the vendor never strips an assignment — doing that would take a role off a
 * member of staff mid-shift as a side effect of a commercial decision — so an
 * owner-doctor at a hospital that gave up the clinic still *holds* DOCTOR.
 *
 * Offering it in the switcher was the reported bug: every role the account had
 * ever been granted appeared under "Acting as", including ones whose every
 * screen is now refused. Switching into one lands on a session with no menu.
 *
 * `POST /auth/switch-role` refuses the same set. This only stops the app
 * offering what it cannot use.
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
 * What each module is, in the words a vendor would use to a customer.
 *
 * Same shape and same reason as `ROLE_LABEL`: a `Record<TenantModule, …>` so a
 * sixth module is a compile error until somebody names it, and `ALL_MODULES` is
 * derived from it rather than retyped. The role list was hand-written in four
 * places and three of them did not know about LAB_TECHNICIAN — an account that
 * could not be created for a role that existed everywhere else. Modules are the
 * same shape of list and would fail the same way.
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

/** What a hospital loses when a module is taken away, said plainly. */
export const MODULE_DESCRIPTION: Record<TenantModule, string> = {
  CLINIC: 'Appointments, the queue, consultation records and prescribing.',
  WARDS: 'Admissions, the ward board, vitals, the drug round and ward requests.',
  PHARMACY: 'Dispensing, stock, counter sales, the pharmacy till and partner pharmacies.',
  LABORATORY: 'The test catalogue, worklist, results, the lab till and partner labs.',
  BILLING: 'Hospital invoices, payments, aging and the finance reports.',
};
