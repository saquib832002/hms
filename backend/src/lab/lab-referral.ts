import { LabCategory, LabPriority, LabResultFlag, LabSpecimenType } from '@prisma/client';

/**
 * What crosses a company boundary when a test is sent to another lab — and what
 * comes back.
 *
 * TWO DIRECTIONS, AND THAT IS THE DIFFERENCE FROM PRESCRIBING
 * ----------------------------------------------------------
 * `PrescriptionReferral` is deliberately one-way. The medicine handed to the
 * patient is the deliverable, and making the receiving pharmacy write into the
 * sender's rows would double the blast radius of that feature for a
 * convenience. That is written down in CLAUDE.md as a real gap, honestly, and
 * it is the right trade there.
 *
 * A lab referral cannot be built that way, because **the result is the
 * deliverable**. An order that goes out and never comes back is a doctor
 * telephoning another company for a number — the thing this replaces. So the
 * return leg exists, and it is the exact mirror of the send: a snapshot written
 * into the *ordering* hospital's scope through `forTenant`, onto rows they
 * already own, under their own policy. No shared rows and no policy exception
 * in either direction.
 *
 * MINIMUM-NECESSARY APPLIES HARDER ACROSS A COMPANY BOUNDARY, NOT LESS
 * -------------------------------------------------------------------
 * The receiving lab is bound by none of the sending hospital's policies. So the
 * outbound payload is an explicit allowlist and never a spread of a Prisma row
 * — a spread passes every "does it contain X" assertion while silently carrying
 * the next field somebody adds to the model.
 *
 * `clinicalDetails` DOES cross, and it is the one field here that deserves an
 * argument. It is the clinical question — "?anaemia", "pre-op", "PUO 5 days" —
 * and a laboratory that does not know why a test was requested cannot comment
 * usefully on the answer; a histopathologist without it is guessing. It is also
 * one field the requesting doctor typed knowing where it was going, which is
 * not the same as handing over a record.
 */

/** Named so a test can assert on the absence rather than field by field. */
export const NEVER_TRANSMITTED = [
  'diagnosis',
  'notes',
  'allergies',
  'medicalRecord',
  'appointmentReason',
  'vitals',
  'admissions',
  'invoice',
  'otherResults',
  'insurance',
] as const;

/** Outbound: the order, reduced to what the receiving lab needs to run it. */
export interface LabReferralPayload {
  patientName: string;
  patientDob: Date | null;
  requestedByName: string;
  clinicalDetails: string | null;
  priority: LabPriority;
  items: {
    /** Opaque in the receiving scope; what the result is written back against. */
    sourceOrderItemId: number;
    testCode: string;
    testName: string;
    category: LabCategory;
    specimenType: LabSpecimenType;
  }[];
}

/**
 * Inbound: one test's result, on its way back to the hospital that ordered it.
 *
 * Note what is *not* here. No patient identifiers — the referral row already
 * names them at both ends and re-sending them would invite the two copies
 * disagreeing. No invoice, no price: the partner lab bills the sending hospital
 * commercially, offline, and putting money in this channel would mean one
 * tenant writing charges into another's ledger.
 */
export interface LabResultPayload {
  sourceOrderItemId: number;
  findings: string | null;
  impression: string | null;
  methodology: string | null;
  /** The pathologist or technician at the other end. Free text; see below. */
  performedByName: string | null;
  values: {
    analyteName: string;
    unit: string | null;
    value: string;
    numericValue: number | null;
    referenceRange: string | null;
    flag: LabResultFlag;
    position: number;
  }[];
}

/**
 * Reduce an order to the outbound payload. Explicit, never a spread.
 */
export function toLabReferralPayload(input: {
  patient: { fullName: string; dob: Date | null };
  doctor: { fullName: string };
  clinicalDetails: string | null;
  priority: LabPriority;
  items: {
    id: number;
    testCode: string;
    testName: string;
    category: LabCategory;
    specimenType: LabSpecimenType;
  }[];
}): LabReferralPayload {
  return {
    patientName: input.patient.fullName,
    patientDob: input.patient.dob,
    requestedByName: input.doctor.fullName,
    clinicalDetails: input.clinicalDetails,
    priority: input.priority,
    items: input.items.map((i) => ({
      sourceOrderItemId: i.id,
      testCode: i.testCode,
      testName: i.testName,
      category: i.category,
      specimenType: i.specimenType,
    })),
  };
}

/**
 * The ranges a partner lab used are captured as **text**, not as numbers.
 *
 * The receiving lab has its own analysers and its own reference intervals, and
 * re-flagging their values against the ordering hospital's catalogue would be
 * the ordering hospital asserting something about a measurement it did not
 * make. So the flag and the range both cross as the partner issued them, and
 * `reference-range.ts` is not run on the way in.
 *
 * This is the same rule as `PrescriptionReferralItem` carrying no `medicineId`:
 * mapping another organisation's data onto your own vocabulary is a human job,
 * and doing it silently is how a number changes meaning in transit.
 */
export const FLAGS_ARE_THE_PARTNERS = true;
