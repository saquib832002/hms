/**
 * Reference ranges for adult observations.
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * This flags values outside broad adult reference ranges so an entry screen
 * can highlight them as the nurse types. It is a data-entry aid, not clinical
 * decision support, and it deliberately does not compute an early-warning
 * score.
 *
 * A real deployment would use NEWS2 (or the local equivalent), which is
 * age-adjusted, accounts for supplemental oxygen and level of consciousness,
 * and is a governed clinical tool — the kind of thing a hospital validates and
 * signs off, not something to improvise in a codebase. Producing a number that
 * *looks* like an early-warning score without that provenance is worse than
 * producing none, because staff would act on it.
 *
 * The ranges below are also adults-only. Paediatric vitals differ enormously
 * by age, and applying adult thresholds to a child gives dangerous answers —
 * so `flagVitals` refuses to judge anyone under 16 rather than guessing.
 */

export interface VitalReading {
  systolic?: number | null;
  diastolic?: number | null;
  pulse?: number | null;
  temperatureC?: number | null;
  respiratoryRate?: number | null;
  spo2?: number | null;
  painScore?: number | null;
}

export type FlagLevel = 'normal' | 'high' | 'low' | 'critical';

export interface VitalFlag {
  field: keyof VitalReading;
  value: number;
  level: FlagLevel;
  note: string;
}

interface Range {
  low: number;
  high: number;
  criticalLow?: number;
  criticalHigh?: number;
  /** Plausible input bounds — outside these it is a typo, not a patient. */
  plausible: [number, number];
}

const ADULT: Record<string, Range> = {
  systolic: { low: 90, high: 140, criticalLow: 80, criticalHigh: 180, plausible: [40, 300] },
  diastolic: { low: 60, high: 90, criticalLow: 40, criticalHigh: 120, plausible: [20, 200] },
  pulse: { low: 50, high: 100, criticalLow: 40, criticalHigh: 130, plausible: [20, 250] },
  temperatureC: { low: 36.0, high: 38.0, criticalLow: 35.0, criticalHigh: 39.5, plausible: [25, 45] },
  respiratoryRate: { low: 12, high: 20, criticalLow: 8, criticalHigh: 25, plausible: [4, 60] },
  spo2: { low: 95, high: 100, criticalLow: 90, plausible: [50, 100] },
  painScore: { low: 0, high: 3, criticalHigh: 8, plausible: [0, 10] },
};

export const ADULT_MIN_AGE = 16;

/**
 * Values that are almost certainly mistyped rather than measured.
 * A temperature of 370 is a misplaced decimal; a pulse of 7 is a dropped digit.
 * These are rejected at the API rather than flagged, because storing them
 * pollutes the observation chart a clinician reads at a glance.
 */
export function implausible(reading: VitalReading): string[] {
  const problems: string[] = [];
  for (const [field, range] of Object.entries(ADULT)) {
    const value = reading[field as keyof VitalReading];
    if (value === null || value === undefined) continue;
    const [min, max] = range.plausible;
    if (value < min || value > max) {
      problems.push(`${field} of ${value} is outside the plausible range ${min}–${max}`);
    }
  }

  if (
    reading.systolic != null &&
    reading.diastolic != null &&
    reading.diastolic >= reading.systolic
  ) {
    problems.push('diastolic pressure cannot be greater than or equal to systolic');
  }

  return problems;
}

/**
 * Flags out-of-range values. Returns an empty list — not a guess — for
 * patients under 16, where adult ranges do not apply.
 */
export function flagVitals(reading: VitalReading, ageYears: number): VitalFlag[] {
  if (ageYears < ADULT_MIN_AGE) return [];

  const flags: VitalFlag[] = [];

  for (const [field, range] of Object.entries(ADULT)) {
    const value = reading[field as keyof VitalReading];
    if (value === null || value === undefined) continue;

    if (range.criticalHigh !== undefined && value >= range.criticalHigh) {
      flags.push({ field: field as keyof VitalReading, value, level: 'critical', note: `${label(field)} is very high` });
    } else if (range.criticalLow !== undefined && value <= range.criticalLow) {
      flags.push({ field: field as keyof VitalReading, value, level: 'critical', note: `${label(field)} is very low` });
    } else if (value > range.high) {
      flags.push({ field: field as keyof VitalReading, value, level: 'high', note: `${label(field)} is above normal` });
    } else if (value < range.low) {
      flags.push({ field: field as keyof VitalReading, value, level: 'low', note: `${label(field)} is below normal` });
    }
  }

  return flags;
}

/** True when a set contains no observation at all. */
export function isEmptyReading(reading: VitalReading): boolean {
  return Object.values(reading).every((v) => v === null || v === undefined);
}

function label(field: string): string {
  return (
    {
      systolic: 'Systolic pressure',
      diastolic: 'Diastolic pressure',
      pulse: 'Pulse',
      temperatureC: 'Temperature',
      respiratoryRate: 'Respiratory rate',
      spo2: 'Oxygen saturation',
      painScore: 'Pain score',
    }[field] ?? field
  );
}
