import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A nurse asks. A nurse never prescribes.
 *
 * THE RULE THIS PROTECTS
 * ----------------------
 * Two requests exist because "the patient needs a medicine that is not here"
 * is two different problems wearing one sentence:
 *
 *   - **Supply** — it is prescribed, the ward has not got it. Logistics, and a
 *     pharmacist answers.
 *   - **Medication** — it is not prescribed at all. Clinical, and a prescriber
 *     answers.
 *
 * The tempting simplification is one "request medication" button. It routes
 * half of each to the wrong person, and the failure it makes available is a
 * drug supplied that nobody prescribed.
 *
 * The other tempting simplification is letting the fulfil endpoint *create* the
 * prescription from the nurse's text, so the doctor can answer in one tap. That
 * reads as a convenience and is prescribing-by-autocomplete: the medicine, dose
 * and frequency would originate from the person who is not licensed to choose
 * them, with a prescriber's name attached. So the doctor writes the
 * prescription through the ordinary route and the request is closed by *id*.
 *
 * These are static checks on source, like `access-matrix` and
 * `consultation-billing`. That is deliberate — the rule is about which code
 * paths exist, and a runtime test would pass just as happily against a service
 * that had quietly grown a second prescribing path behind a flag.
 */

const SERVICE = path.resolve(__dirname, 'ward-requests.service.ts');
const CONTROLLER = path.resolve(__dirname, 'ward-requests.controller.ts');
const DTO = path.resolve(__dirname, 'dto', 'ward-requests.dto.ts');

/** Comments are prose about the rule and would match every assertion below. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const service = strip(readFileSync(SERVICE, 'utf8'));
const controller = strip(readFileSync(CONTROLLER, 'utf8'));
const dto = strip(readFileSync(DTO, 'utf8'));

describe('a nurse asks, and never prescribes', () => {
  it('writes no prescription anywhere in this service', () => {
    /*
     * The load-bearing assertion. `prescription.create`, `prescriptionItem.
     * create` or an upsert here would mean a nurse's request could put a
     * medicine into the system, which is the exact thing the two-model split
     * exists to prevent.
     */
    expect(service).not.toMatch(/prescription\.(create|upsert|createMany)/);
    expect(service).not.toMatch(/prescriptionItem\.(create|upsert|createMany)/);
  });

  it('writes no dose or chart row either', () => {
    // The other door into the same room: charting a medicine directly is
    // prescribing under a different noun.
    expect(service).not.toMatch(/medicationAdministration\.(create|upsert|createMany)/);
  });

  it('closes a medication request against a prescription that already exists', () => {
    // `prescriptionId` is required by the DTO and looked up before the status
    // moves — a PRESCRIBED request whose prescription does not exist would let
    // the chart and the request disagree, and a nurse who reads "prescribed"
    // and finds nothing stops chasing.
    expect(dto).toMatch(/class FulfilMedicationRequestDto[\s\S]*?@IsInt\(\)\s*prescriptionId/);
    expect(service).toMatch(/prescription\.findUnique/);
  });

  it('only lets a doctor answer a medication request', () => {
    const queue = /@Roles\(UserRole\.DOCTOR\)\s*@AuditAction\('MEDICATION_REQUEST_QUEUE_VIEW'\)/;
    const fulfil = /@Roles\(UserRole\.DOCTOR\)\s*@AuditAction\('MEDICATION_REQUEST_FULFIL'\)/;
    const decline = /@Roles\(UserRole\.DOCTOR\)\s*@AuditAction\('MEDICATION_REQUEST_DECLINE'\)/;
    expect(controller).toMatch(queue);
    expect(controller).toMatch(fulfil);
    expect(controller).toMatch(decline);
  });

  it('only lets a pharmacist answer a supply request', () => {
    expect(controller).toMatch(
      /@Roles\(UserRole\.PHARMACIST\)\s*@AuditAction\('SUPPLY_REQUEST_FULFIL'\)/,
    );
    expect(controller).toMatch(
      /@Roles\(UserRole\.PHARMACIST\)\s*@AuditAction\('SUPPLY_REQUEST_DECLINE'\)/,
    );
  });

  it('only lets a nurse raise either kind', () => {
    expect(controller).toMatch(/@Roles\(UserRole\.NURSE\)\s*@AuditAction\('SUPPLY_REQUEST_CREATE'\)/);
    expect(controller).toMatch(
      /@Roles\(UserRole\.NURSE\)\s*@AuditAction\('MEDICATION_REQUEST_CREATE'\)/,
    );
  });

  it('keeps admin out of both queues entirely', () => {
    /*
     * These rows name a patient, a bed and a medicine. Admin is operational,
     * never clinical — the same line that keeps it off the ward board and the
     * dispensing queue, and the one `access-matrix` found had drifted in four
     * places the day it was first asserted.
     */
    expect(controller).not.toMatch(/UserRole\.ADMIN/);
  });

  it('gives a supply request no way to name a medicine of its own', () => {
    /*
     * `prescriptionItemId` and nothing else. A free-text medicine field here
     * would be a prescription written by a nurse wearing a logistics label —
     * which is the whole reason there are two models rather than one.
     */
    const block = /class CreateSupplyRequestDto \{[\s\S]*?\n\}/.exec(dto)?.[0] ?? '';
    expect(block).toContain('prescriptionItemId');
    expect(block).not.toMatch(/medicineText|medicineName|medicineId/);
  });

  it('demands a written reason to decline either kind', () => {
    // A refusal a ward cannot act on is worse than a delay: "out of stock,
    // expect Thursday" changes what the nurse does next, and a bare no does not.
    expect(dto).toMatch(/class DeclineRequestDto[\s\S]*?@MinLength\(\d+\)/);
  });

  it('demands a clinical reason to raise a medication request', () => {
    // A prescriber cannot answer "she needs something", and a request with no
    // reason gets ignored or guessed at.
    expect(dto).toMatch(/class CreateMedicationRequestDto[\s\S]*?reason:/);
    expect(dto).toMatch(/@MinLength\(12\)/);
  });

  it('does not move stock when a supply request is fulfilled', () => {
    /*
     * Decrementing here would give the hospital a second stock ledger beside
     * `DispenseEvent` — the same mistake a `CounterSale` table would have been
     * — and would skip batch selection, expiry, the allergy check and pricing.
     * The medicine leaves the shelf through dispensing, counted and charged
     * once.
     */
    expect(service).not.toMatch(/stockBatch\.(update|updateMany|create)/);
    expect(service).not.toMatch(/dispenseEvent\.(create|update)/);
    expect(service).not.toMatch(/dispenseLine\./);
  });

  it('refuses to answer the same request twice', () => {
    // Both paths check the status first. Without it, a second click would
    // overwrite who answered and when, and a declined request could silently
    // become a supplied one.
    const answers = service.match(/cannot be answered twice/g) ?? [];
    expect(answers.length).toBeGreaterThanOrEqual(4);
  });
});
