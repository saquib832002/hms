import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A referral's test code is another laboratory's vocabulary, and the match
 * must not turn on punctuation.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `accept()` matched the partner's `testCode` against this laboratory's `code`
 * with an exact string comparison, and narrowed the catalogue query to those
 * same exact strings. So a catalogue holding `Fbc`, or a referral sending
 * ` FBC `, produced *"Say which of your tests these are: Full Blood Count
 * (FBC)"* — a refusal naming a test the technician can see in their own
 * catalogue, with nothing on screen explaining why it did not count.
 *
 * The refusal itself is correct and stays: codes are local, two laboratories
 * genuinely disagree, and guessing at which test somebody meant is the one
 * thing this must never do. What was wrong is that a near-miss on whitespace or
 * case was indistinguishable from a real disagreement — the technician is then
 * asked to map a test to itself, which reads as the software being broken and
 * is the sort of thing people learn to click through.
 *
 * WHY THE QUERY HAD TO WIDEN TOO
 * ------------------------------
 * Normalising only the comparison would have fixed nothing: the candidates were
 * fetched with `code: { in: [...] }` on the raw strings, so `Fbc` was never
 * read out of the database and had nothing to be compared against. Case
 * folding inside a `WHERE ... IN` is not portable, and a laboratory's catalogue
 * is tens of rows, so it is read whole.
 *
 * WHAT THIS TEST CAN AND CANNOT SEE
 * ---------------------------------
 * It is a source assertion, like the rest of the guards here — it pins that the
 * normaliser exists and is applied on *both* sides of the map, which is the
 * half of the mistake that is invisible in review. A `Map` keyed on normalised
 * codes and read with a raw one compiles perfectly and matches nothing.
 */

const SOURCE = readFileSync(path.join(__dirname, 'lab-referral.service.ts'), 'utf8');

describe('a referral code is matched leniently and mapped strictly', () => {
  it('normalises case and whitespace', () => {
    expect(SOURCE).toMatch(/const normalise = \(code: string\) => code\.trim\(\)\.toUpperCase\(\)/);
  });

  it('normalises the key as well as the lookup', () => {
    // Both halves, because one alone is a map that can never hit.
    expect(SOURCE).toMatch(/byCode = new Map\(candidates\.map\(\(t\) => \[normalise\(t\.code\)/);
    expect(SOURCE).toMatch(/byCode\.get\(normalise\(item\.testCode\)\)/);
  });

  it('reads the whole active catalogue rather than filtering on the raw codes', () => {
    /*
     * A `code: { in: [...] }` here would silently reinstate the exact match:
     * the row that should have matched is never fetched, so the normaliser
     * above has nothing to normalise and the test above still passes.
     */
    expect(SOURCE).not.toMatch(/code:\s*\{\s*in:\s*\[/);
  });

  it('still refuses rather than guessing when the codes genuinely differ', () => {
    /*
     * The point of the refusal. Mapping is a human decision — two laboratories
     * calling different examinations by the same three letters is ordinary, and
     * a fuzzy name match would accept work this bench does not do.
     */
    expect(SOURCE).toMatch(/Say which of your tests these are/);
  });
});
