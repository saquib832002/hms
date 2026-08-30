import type { UserRole } from './types';

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
};

export function landingFor(role: UserRole): string {
  return LANDING[role] ?? '/(tabs)/me';
}

export const ROLE_LABEL: Record<UserRole, string> = {
  ADMIN: 'Administrator',
  DOCTOR: 'Doctor',
  NURSE: 'Nurse',
  RECEPTIONIST: 'Reception',
  PHARMACIST: 'Pharmacy',
  BILLING_STAFF: 'Billing',
};
