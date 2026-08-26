import type { UserRole } from './types';

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
  /** Not built yet — rendered as a placeholder rather than a broken link. */
  phase?: number;
}

const NAV: Record<UserRole, NavItem[]> = {
  DOCTOR: [
    { label: "Today's Queue", href: '/queue', icon: '▤' },
    { label: 'Appointments', href: '/appointments', icon: '▦' },
    { label: 'Patients', href: '/patients', icon: '◍' },
  ],
  RECEPTIONIST: [
    { label: 'Check-in Queue', href: '/check-in', icon: '▤' },
    { label: 'Appointments', href: '/appointments', icon: '▦' },
    { label: 'Register Patient', href: '/patients/new', icon: '+' },
    { label: 'Patients', href: '/patients', icon: '◍' },
    { label: 'Doctors', href: '/doctors', icon: '✚' },
  ],
  NURSE: [
    { label: 'Ward Board', href: '/ward', icon: '▥' },
    { label: 'Vitals', href: '/vitals', icon: '♥' },
    { label: 'Medications', href: '/medications', icon: '℞' },
    { label: 'Appointments', href: '/appointments', icon: '▦' },
    { label: 'Patients', href: '/patients', icon: '◍' },
  ],
  PHARMACIST: [
    { label: 'Prescription Queue', href: '/pharmacy/queue', icon: '▤' },
    { label: 'Inventory', href: '/pharmacy/inventory', icon: '▨' },
    { label: 'Patients', href: '/patients', icon: '◍' },
  ],
  BILLING_STAFF: [
    { label: 'Invoices', href: '/billing/invoices', icon: '▤' },
    { label: 'Payments', href: '/billing/payments', icon: '＄' },
    { label: 'Patients', href: '/patients', icon: '◍' },
  ],
  ADMIN: [
    { label: 'Dashboard', href: '/admin', icon: '▨' },
    { label: 'Staff & Users', href: '/admin/users', icon: '◍' },
    { label: 'Departments', href: '/admin/departments', icon: '▢' },
    { label: 'Clinic Settings', href: '/admin/settings', icon: '⚙' },
    { label: 'Doctors', href: '/doctors', icon: '✚' },
    { label: 'Appointments', href: '/appointments', icon: '▦' },
    { label: 'Patients', href: '/patients', icon: '◍' },
    { label: 'Audit Log', href: '/audit', icon: '⌾' },
  ],
};

export function navFor(role: UserRole): NavItem[] {
  return NAV[role] ?? [];
}

/** Where a role lands after login — the screen it spends the day on. */
export function landingFor(role: UserRole): string {
  return navFor(role)[0]?.href ?? '/patients';
}

export const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: 'Administrator',
  DOCTOR: 'Doctor',
  NURSE: 'Nurse',
  RECEPTIONIST: 'Reception',
  PHARMACIST: 'Pharmacy',
  BILLING_STAFF: 'Billing',
};
