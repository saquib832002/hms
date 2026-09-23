import { AllergySeverity, Gender, UserRole } from '@prisma/client';
import { toPatientListItem, toPatientResponse } from './patient-response';

/**
 * The test that actually protects patient data.
 *
 * It asserts on *absence*, not presence. A test that only checks the doctor
 * gets allergies would still pass if the receptionist got them too — which is
 * the bug that matters.
 */

const patient = {
  id: 1,
  // Tenancy is irrelevant to response shaping — the point of these tests — but
  // the row type carries it, so the fixture must look like a real row.
  tenantId: 1,
  fullName: 'Testpatient Alpha',
  dob: new Date('1990-06-15T00:00:00Z'),
  gender: Gender.FEMALE,
  phone: '+44 7700 900000',
  email: 'alpha@example.test',
  address: '1 Test Street',
  bloodGroup: 'O+',
  emergencyContactName: 'Testcontact Beta',
  emergencyContactPhone: '+44 7700 900001',
  insurerName: 'Demo Health Cover',
  insurancePolicyNumber: 'POL-123456',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  isReferralOrigin: false,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  allergies: [
    {
      id: 1,
      tenantId: 1,
      patientId: 1,
      substance: 'Penicillin',
      severity: AllergySeverity.SEVERE,
      notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ],
};

const CLINICAL_FIELDS = ['bloodGroup', 'allergies'] as const;

describe('toPatientResponse', () => {
  describe.each([UserRole.RECEPTIONIST, UserRole.BILLING_STAFF, UserRole.ADMIN])(
    'non-clinical role: %s',
    (role) => {
      it('returns no clinical fields at all', () => {
        const res = toPatientResponse(patient, role) as Record<string, unknown>;
        for (const field of CLINICAL_FIELDS) {
          expect(res).not.toHaveProperty(field);
        }
      });

      it('still returns the demographics the role needs to do its job', () => {
        const res = toPatientResponse(patient, role) as Record<string, unknown>;
        expect(res.fullName).toBe('Testpatient Alpha');
        expect(res.phone).toBe('+44 7700 900000');
        expect(res.id).toBe(1);
      });
    },
  );

  describe.each([UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST])(
    'clinical role: %s',
    (role) => {
      it('returns allergies', () => {
        const res = toPatientResponse(patient, role) as Record<string, unknown>;
        expect(res.allergies).toHaveLength(1);
        expect((res.allergies as { substance: string }[])[0].substance).toBe('Penicillin');
      });

      it('returns blood group', () => {
        const res = toPatientResponse(patient, role) as Record<string, unknown>;
        expect(res.bloodGroup).toBe('O+');
      });
    },
  );

  it('never returns medical records, prescriptions or invoices for any role', () => {
    // These relations used to be eagerly included by findOne for every caller.
    // They now live behind their own role-guarded endpoints.
    for (const role of Object.values(UserRole)) {
      const res = toPatientResponse(patient, role) as Record<string, unknown>;
      expect(res).not.toHaveProperty('medicalRecords');
      expect(res).not.toHaveProperty('prescriptions');
      expect(res).not.toHaveProperty('invoices');
      expect(res).not.toHaveProperty('appointments');
    }
  });

  it('computes age from date of birth', () => {
    const res = toPatientResponse(patient, UserRole.DOCTOR) as Record<string, unknown>;
    expect(typeof res.age).toBe('number');
    expect(res.age as number).toBeGreaterThan(30);
  });
});

describe('insurance details', () => {
  // Minimum-necessary cuts both ways: billing gets the policy number and no
  // diagnosis; a doctor gets the diagnosis and no policy number.
  it.each([UserRole.BILLING_STAFF, UserRole.RECEPTIONIST])('%s receives insurance', (role) => {
    const res = toPatientResponse(patient, role) as Record<string, unknown>;
    expect(res.insurerName).toBe('Demo Health Cover');
    expect(res.insurancePolicyNumber).toBe('POL-123456');
  });

  it.each([UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST])(
    '%s does not receive insurance',
    (role) => {
      const res = toPatientResponse(patient, role) as Record<string, unknown>;
      expect(res).not.toHaveProperty('insurerName');
      expect(res).not.toHaveProperty('insurancePolicyNumber');
    },
  );

  it('still keeps clinical data away from billing', () => {
    const res = toPatientResponse(patient, UserRole.BILLING_STAFF) as Record<string, unknown>;
    expect(res).not.toHaveProperty('allergies');
    expect(res).not.toHaveProperty('bloodGroup');
  });

  it('never includes insurance in a list response', () => {
    for (const role of Object.values(UserRole)) {
      expect(toPatientListItem(patient, role)).not.toHaveProperty('insurancePolicyNumber');
    }
  });
});

describe('toPatientListItem', () => {
  it('gives clinical roles a boolean flag, not the allergy details', () => {
    const res = toPatientListItem(patient, UserRole.DOCTOR) as Record<string, unknown>;
    expect(res.hasAllergies).toBe(true);
    expect(res).not.toHaveProperty('allergies');
  });

  it('gives non-clinical roles no allergy signal at all', () => {
    const res = toPatientListItem(patient, UserRole.RECEPTIONIST) as Record<string, unknown>;
    expect(res).not.toHaveProperty('hasAllergies');
    expect(res).not.toHaveProperty('allergies');
  });

  it('never includes the address in a list response', () => {
    for (const role of Object.values(UserRole)) {
      expect(toPatientListItem(patient, role)).not.toHaveProperty('address');
    }
  });
});
