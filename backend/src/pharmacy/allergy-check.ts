import { AllergySeverity, DrugClass } from '@prisma/client';

/**
 * Allergy checking, now that there is a catalogue to check against.
 *
 * WHAT CHANGED FROM PHASE 1
 * -------------------------
 * The old check compared strings. It caught "Penicillin V" against a
 * penicillin allergy and sailed straight past "Amoxicillin" — which *is* a
 * penicillin and shares no substring with the word. That check was advisory
 * precisely because it could not be trusted.
 *
 * With `Medicine.drugClass` the check can be about pharmacology rather than
 * spelling, so it can now carry consequences.
 *
 * WHAT IS STILL NOT TRUE
 * ----------------------
 * This is not a drug interaction engine and does not pretend to be. It answers
 * one narrow question: does this medicine belong to a class the patient has a
 * recorded allergy to. It knows nothing about dose, route, renal function,
 * or interactions between two prescribed drugs.
 *
 * A real deployment uses a maintained terminology (dm+d, RxNorm, FDB) with
 * curated cross-sensitivity data. The mapping below is a demonstration. Its
 * job is to make the *mechanism* real — block, override, audit — not to be
 * clinically authoritative.
 */

/**
 * Recorded allergy substances mapped to the classes they implicate.
 *
 * Keys are matched case-insensitively against `Allergy.substance`, which is
 * free text typed by staff, so the common spellings are listed rather than
 * assuming one canonical form.
 */
const SUBSTANCE_TO_CLASSES: { match: RegExp; classes: DrugClass[] }[] = [
  {
    match: /penicillin|amoxicillin|augmentin|flucloxacillin/i,
    // Cephalosporins share a beta-lactam ring with penicillins. Real
    // cross-reactivity is far lower than folklore suggests, but it is a
    // recognised caution, so it is flagged rather than ignored.
    classes: [DrugClass.PENICILLIN, DrugClass.CEPHALOSPORIN],
  },
  { match: /cephalosporin|cefalexin|ceftriaxone/i, classes: [DrugClass.CEPHALOSPORIN] },
  { match: /sulfa|sulpha|sulfonamide|co-?trimoxazole|trimethoprim/i, classes: [DrugClass.SULFONAMIDE] },
  { match: /macrolide|erythromycin|clarithromycin|azithromycin/i, classes: [DrugClass.MACROLIDE] },
  { match: /tetracycline|doxycycline/i, classes: [DrugClass.TETRACYCLINE] },
  { match: /quinolone|ciprofloxacin|levofloxacin/i, classes: [DrugClass.QUINOLONE] },
  {
    match: /nsaid|aspirin|ibuprofen|naproxen|diclofenac/i,
    classes: [DrugClass.NSAID],
  },
  { match: /opioid|morphine|codeine|oxycodone|tramadol/i, classes: [DrugClass.OPIOID] },
  { match: /statin|simvastatin|atorvastatin/i, classes: [DrugClass.STATIN] },
  { match: /ace inhibitor|ramipril|lisinopril|enalapril/i, classes: [DrugClass.ACE_INHIBITOR] },
  { match: /beta.?blocker|atenolol|bisoprolol|propranolol/i, classes: [DrugClass.BETA_BLOCKER] },
  { match: /heparin|warfarin|anticoagulant/i, classes: [DrugClass.ANTICOAGULANT] },
  { match: /steroid|prednisolone|hydrocortisone/i, classes: [DrugClass.CORTICOSTEROID] },
];

export interface AllergyRecord {
  substance: string;
  severity: AllergySeverity;
}

export interface PrescribedMedicine {
  /** As written by the prescriber. */
  medicineName: string;
  /** Null when the item is not linked to the catalogue — see `unmatched`. */
  drugClass: DrugClass | null;
  catalogueName?: string | null;
}

export type ConflictLevel = 'BLOCKING' | 'WARNING';

export interface AllergyConflict {
  medicineName: string;
  substance: string;
  severity: AllergySeverity;
  /** 'class' is pharmacological; 'name' is the old string match, kept as a net. */
  matchedOn: 'class' | 'name';
  level: ConflictLevel;
  message: string;
}

/** Severities serious enough that dispensing stops without an explicit override. */
const BLOCKING_SEVERITIES: AllergySeverity[] = [
  AllergySeverity.SEVERE,
  AllergySeverity.LIFE_THREATENING,
];

function classesImplicatedBy(substance: string): DrugClass[] {
  const out = new Set<DrugClass>();
  for (const entry of SUBSTANCE_TO_CLASSES) {
    if (entry.match.test(substance)) entry.classes.forEach((c) => out.add(c));
  }
  return [...out];
}

export function checkAllergies(
  medicines: PrescribedMedicine[],
  allergies: AllergyRecord[],
): { conflicts: AllergyConflict[]; unmatched: string[] } {
  const conflicts: AllergyConflict[] = [];

  // Items with no catalogue link cannot be class-checked. That is reported,
  // not silently treated as safe — "we did not check" and "we checked and it
  // is fine" are completely different facts.
  const unmatched = medicines.filter((m) => m.drugClass === null).map((m) => m.medicineName);

  for (const med of medicines) {
    for (const allergy of allergies) {
      const implicated = classesImplicatedBy(allergy.substance);
      const byClass = med.drugClass !== null && implicated.includes(med.drugClass);

      // The Phase 1 substring check is kept as a backstop for items that have
      // no catalogue entry — weak, but better than nothing on an unmatched row.
      const name = med.medicineName.toLowerCase();
      const sub = allergy.substance.toLowerCase();
      const byName = !byClass && (name.includes(sub) || sub.includes(name));

      if (!byClass && !byName) continue;

      const blocking = BLOCKING_SEVERITIES.includes(allergy.severity);
      conflicts.push({
        medicineName: med.medicineName,
        substance: allergy.substance,
        severity: allergy.severity,
        matchedOn: byClass ? 'class' : 'name',
        level: blocking ? 'BLOCKING' : 'WARNING',
        message: byClass
          ? `${med.catalogueName ?? med.medicineName} is a ${humanClass(med.drugClass!)} and the patient has a ${human(allergy.severity)} allergy to ${allergy.substance}`
          : `${med.medicineName} matches a ${human(allergy.severity)} allergy to ${allergy.substance}`,
      });
    }
  }

  return { conflicts, unmatched };
}

export function hasBlockingConflict(conflicts: AllergyConflict[]): boolean {
  return conflicts.some((c) => c.level === 'BLOCKING');
}

function human(severity: AllergySeverity): string {
  return severity.replace(/_/g, '-').toLowerCase();
}

function humanClass(drugClass: DrugClass): string {
  return drugClass.replace(/_/g, ' ').toLowerCase();
}
