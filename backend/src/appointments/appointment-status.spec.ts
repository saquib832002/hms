import { AppointmentStatus, UserRole } from '@prisma/client';
import {
  ALLOWED_TRANSITIONS,
  isTerminal,
  isValidTransition,
  roleMayTransitionTo,
} from './appointment-status';

const { SCHEDULED, CHECKED_IN, IN_PROGRESS, COMPLETED, CANCELLED, NO_SHOW } = AppointmentStatus;

describe('appointment status machine', () => {
  describe('valid transitions', () => {
    it.each([
      [SCHEDULED, CHECKED_IN],
      [SCHEDULED, CANCELLED],
      [SCHEDULED, NO_SHOW],
      [CHECKED_IN, IN_PROGRESS],
      [CHECKED_IN, NO_SHOW],
      [CHECKED_IN, CANCELLED],
      [IN_PROGRESS, COMPLETED],
    ])('%s → %s is allowed', (from, to) => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  });

  describe('the transitions that must never be possible', () => {
    it.each([
      // Nothing moves backwards. A completed consultation has a record and
      // possibly a prescription written against it.
      [COMPLETED, IN_PROGRESS],
      [COMPLETED, SCHEDULED],
      [COMPLETED, CHECKED_IN],
      [IN_PROGRESS, CHECKED_IN],
      [CHECKED_IN, SCHEDULED],
      // Terminal states stay terminal.
      [CANCELLED, SCHEDULED],
      [CANCELLED, CHECKED_IN],
      [NO_SHOW, CHECKED_IN],
      [NO_SHOW, COMPLETED],
      // No skipping the middle: a patient cannot be completed without ever
      // being seen.
      [SCHEDULED, IN_PROGRESS],
      [SCHEDULED, COMPLETED],
      [CHECKED_IN, COMPLETED],
    ])('%s → %s is rejected', (from, to) => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  });

  it('treats COMPLETED, CANCELLED and NO_SHOW as terminal', () => {
    expect(isTerminal(COMPLETED)).toBe(true);
    expect(isTerminal(CANCELLED)).toBe(true);
    expect(isTerminal(NO_SHOW)).toBe(true);
    expect(isTerminal(SCHEDULED)).toBe(false);
    expect(isTerminal(CHECKED_IN)).toBe(false);
    expect(isTerminal(IN_PROGRESS)).toBe(false);
  });

  it('covers every status in the enum', () => {
    // Adding a status to the Prisma enum without deciding where it can go
    // should fail here rather than throwing at runtime.
    for (const status of Object.values(AppointmentStatus)) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
  });

  describe('who may do what', () => {
    it('lets reception run the front desk', () => {
      expect(roleMayTransitionTo(UserRole.RECEPTIONIST, CHECKED_IN)).toBe(true);
      expect(roleMayTransitionTo(UserRole.RECEPTIONIST, NO_SHOW)).toBe(true);
      expect(roleMayTransitionTo(UserRole.RECEPTIONIST, CANCELLED)).toBe(true);
    });

    it('does not let reception declare clinical progress', () => {
      // Reception is not the one who saw the patient.
      expect(roleMayTransitionTo(UserRole.RECEPTIONIST, IN_PROGRESS)).toBe(false);
      expect(roleMayTransitionTo(UserRole.RECEPTIONIST, COMPLETED)).toBe(false);
    });

    it('lets doctors progress and complete consultations', () => {
      expect(roleMayTransitionTo(UserRole.DOCTOR, IN_PROGRESS)).toBe(true);
      expect(roleMayTransitionTo(UserRole.DOCTOR, COMPLETED)).toBe(true);
    });

    it('does not let doctors check patients in or mark no-shows', () => {
      expect(roleMayTransitionTo(UserRole.DOCTOR, CHECKED_IN)).toBe(false);
      expect(roleMayTransitionTo(UserRole.DOCTOR, NO_SHOW)).toBe(false);
    });

    it.each([UserRole.NURSE, UserRole.PHARMACIST, UserRole.BILLING_STAFF])(
      'gives %s no appointment transitions at all',
      (role) => {
        for (const to of Object.values(AppointmentStatus)) {
          expect(roleMayTransitionTo(role, to)).toBe(false);
        }
      },
    );
  });
});
