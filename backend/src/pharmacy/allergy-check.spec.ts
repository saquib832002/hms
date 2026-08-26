import { AllergySeverity, DrugClass } from '@prisma/client';
import { checkAllergies, hasBlockingConflict, PrescribedMedicine } from './allergy-check';

const penicillinAllergy = { substance: 'Penicillin', severity: AllergySeverity.SEVERE };
const mildLatex = { substance: 'Latex', severity: AllergySeverity.MILD };

const med = (name: string, drugClass: DrugClass | null): PrescribedMedicine => ({
  medicineName: name,
  drugClass,
  catalogueName: name,
});

describe('checkAllergies', () => {
  it('finds nothing when there is nothing to find', () => {
    const { conflicts } = checkAllergies([med('Paracetamol', DrugClass.OTHER)], [penicillinAllergy]);
    expect(conflicts).toEqual([]);
  });

  describe('the case Phase 1 could not catch', () => {
    it('flags Amoxicillin against a penicillin allergy', () => {
      // This is the whole point of the catalogue. "Amoxicillin" shares no
      // substring with "Penicillin" — the Phase 1 string check missed it
      // completely, and it is a genuine and dangerous conflict.
      const { conflicts } = checkAllergies(
        [med('Amoxicillin', DrugClass.PENICILLIN)],
        [penicillinAllergy],
      );

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].matchedOn).toBe('class');
      expect(conflicts[0].level).toBe('BLOCKING');
    });

    it('flags Flucloxacillin too', () => {
      const { conflicts } = checkAllergies(
        [med('Flucloxacillin', DrugClass.PENICILLIN)],
        [penicillinAllergy],
      );
      expect(conflicts).toHaveLength(1);
    });

    it('flags a cephalosporin against a penicillin allergy', () => {
      // Shared beta-lactam ring. Real cross-reactivity is lower than folklore
      // suggests, but it is a recognised caution and should not pass silently.
      const { conflicts } = checkAllergies(
        [med('Cefalexin', DrugClass.CEPHALOSPORIN)],
        [penicillinAllergy],
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].matchedOn).toBe('class');
    });

    it('recognises the allergy however staff typed it', () => {
      // `Allergy.substance` is free text, so the same allergy arrives spelled
      // several ways.
      for (const substance of ['Penicillin', 'penicillin V', 'Amoxicillin', 'AUGMENTIN']) {
        const { conflicts } = checkAllergies(
          [med('Amoxicillin', DrugClass.PENICILLIN)],
          [{ substance, severity: AllergySeverity.SEVERE }],
        );
        expect(conflicts.length).toBeGreaterThan(0);
      }
    });

    it('catches ibuprofen against an aspirin allergy', () => {
      const { conflicts } = checkAllergies(
        [med('Ibuprofen', DrugClass.NSAID)],
        [{ substance: 'Aspirin', severity: AllergySeverity.MODERATE }],
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].matchedOn).toBe('class');
    });

    it('catches co-trimoxazole against a sulfa allergy', () => {
      const { conflicts } = checkAllergies(
        [med('Co-trimoxazole', DrugClass.SULFONAMIDE)],
        [{ substance: 'Sulfa drugs', severity: AllergySeverity.MODERATE }],
      );
      expect(conflicts).toHaveLength(1);
    });
  });

  describe('severity decides whether it blocks', () => {
    it.each([AllergySeverity.SEVERE, AllergySeverity.LIFE_THREATENING])(
      '%s blocks',
      (severity) => {
        const { conflicts } = checkAllergies(
          [med('Amoxicillin', DrugClass.PENICILLIN)],
          [{ substance: 'Penicillin', severity }],
        );
        expect(conflicts[0].level).toBe('BLOCKING');
        expect(hasBlockingConflict(conflicts)).toBe(true);
      },
    );

    it.each([AllergySeverity.MILD, AllergySeverity.MODERATE])('%s warns but does not block', (severity) => {
      // A mild recorded intolerance should not stop a pharmacist working. It
      // should make them look.
      const { conflicts } = checkAllergies(
        [med('Amoxicillin', DrugClass.PENICILLIN)],
        [{ substance: 'Penicillin', severity }],
      );
      expect(conflicts[0].level).toBe('WARNING');
      expect(hasBlockingConflict(conflicts)).toBe(false);
    });
  });

  describe('items with no catalogue entry', () => {
    it('reports them as unchecked rather than treating them as safe', () => {
      // "We did not check" and "we checked and it is fine" are completely
      // different facts, and collapsing them is how something gets missed.
      const { unmatched } = checkAllergies(
        [med('Some Unlisted Syrup', null)],
        [penicillinAllergy],
      );
      expect(unmatched).toEqual(['Some Unlisted Syrup']);
    });

    it('still applies the old name match as a backstop', () => {
      const { conflicts } = checkAllergies([med('Penicillin V', null)], [penicillinAllergy]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].matchedOn).toBe('name');
    });

    it('reports nothing unmatched when everything is catalogued', () => {
      const { unmatched } = checkAllergies([med('Amoxicillin', DrugClass.PENICILLIN)], []);
      expect(unmatched).toEqual([]);
    });
  });

  it('checks every medicine against every allergy', () => {
    const { conflicts } = checkAllergies(
      [med('Amoxicillin', DrugClass.PENICILLIN), med('Ibuprofen', DrugClass.NSAID)],
      [penicillinAllergy, { substance: 'Aspirin', severity: AllergySeverity.SEVERE }],
    );
    expect(conflicts).toHaveLength(2);
  });

  it('does not invent a conflict for an unrelated allergy', () => {
    const { conflicts } = checkAllergies([med('Amoxicillin', DrugClass.PENICILLIN)], [mildLatex]);
    expect(conflicts).toEqual([]);
  });

  it('explains the conflict in terms a pharmacist can act on', () => {
    const { conflicts } = checkAllergies(
      [med('Amoxicillin', DrugClass.PENICILLIN)],
      [penicillinAllergy],
    );
    expect(conflicts[0].message).toMatch(/amoxicillin/i);
    expect(conflicts[0].message).toMatch(/penicillin/i);
    expect(conflicts[0].message).toMatch(/severe/i);
  });
});
