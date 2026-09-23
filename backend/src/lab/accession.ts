/**
 * The number on the tube.
 *
 * WHAT AN ACCESSION NUMBER IS, AND WHY IT IS NOT THE ORDER ID
 * -----------------------------------------------------------
 * Every laboratory in the world puts one identifier on a specimen and uses it
 * for everything afterwards: the label, the worklist, the analyser worksheet,
 * the report, the query on the telephone. It is the thing a technician reads
 * out and a clinician quotes back.
 *
 * `LabOrder.id` cannot be that number for three reasons, and each has bitten a
 * real system:
 *
 * 1. **It is not tenant-scoped.** Two hospitals on this platform would quote
 *    the same "order 412" for different patients. The moment work crosses
 *    between them — which this product does — that is a collision on the one
 *    identifier both parties use to talk about a specimen.
 * 2. **It is sequential and global**, so it leaks how much work the platform
 *    does and how much a competitor's hospital does. An accession restarts per
 *    hospital per year, which is what laboratories actually do.
 * 3. **It has no check character.** These get read aloud down a bad telephone
 *    line and typed in by hand when a label smudges. A transposed digit that
 *    silently resolves to *another patient's specimen* is the single worst
 *    failure available in a laboratory.
 *
 * SHAPE
 * -----
 *     26-000412-K
 *     └┬┘ └──┬─┘ ┬
 *      │     │   └── check character, Damm-style over the digits
 *      │     └────── sequence, restarting each year, per hospital
 *      └──────────── two-digit year
 *
 * Digits and one letter, upper case, hyphenated in threes-ish so it survives
 * being read aloud. No letters that look like digits anywhere in the check
 * alphabet — `O`, `I` and `S` are excluded for the same reason the referral
 * reference alphabet excludes them.
 *
 * WHAT GOES IN THE BARCODE
 * ------------------------
 * The accession, and nothing else. Not the patient's name, not their date of
 * birth, not the tests. A specimen label is handled by couriers, sits in racks
 * on open benches and ends up in bins; encoding identifiers into it turns every
 * discarded tube into a data breach, and every laboratory accreditation scheme
 * says so. The barcode is a key, and the system holds the record.
 */

/**
 * The check alphabet.
 *
 * 23 characters: A–Z minus the three that are misread as digits or as each
 * other under a smudged thermal print — `I` (1), `O` (0) and `S` (5). A check
 * character that is itself ambiguous defeats the point of having one.
 */
const CHECK_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ';

/**
 * Compute the check character over the numeric body.
 *
 * A weighted modulus rather than a plain sum, because a plain sum cannot see a
 * transposition — and transposing two adjacent digits is the commonest way a
 * human mistypes a number read aloud. Weighting alternate positions catches it.
 */
export function checkCharacter(digits: string): string {
  let sum = 0;
  const body = digits.replace(/\D/g, '');

  for (let i = 0; i < body.length; i++) {
    const value = Number(body[body.length - 1 - i]);
    // Alternate weights, so 12 and 21 do not produce the same total.
    sum += i % 2 === 0 ? value * 3 : value;
  }

  return CHECK_ALPHABET[sum % CHECK_ALPHABET.length];
}

/** `26-000412-K` from a year and a sequence. */
export function formatAccession(year: number, sequence: number): string {
  const yy = String(year % 100).padStart(2, '0');
  const seq = String(sequence).padStart(6, '0');
  return `${yy}-${seq}-${checkCharacter(yy + seq)}`;
}

/**
 * Is this a well-formed accession, and does its check character agree?
 *
 * Used on the scan/type box before a lookup is attempted. A mistyped number
 * that happens to match another specimen is the failure this exists to prevent,
 * so the check is refused *before* the database is asked — otherwise a wrong
 * number that resolves looks exactly like a right one.
 */
export function isValidAccession(value: string): boolean {
  const normalised = normaliseAccession(value);
  const m = /^(\d{2})-(\d{6})-([A-Z])$/.exec(normalised);
  if (!m) return false;
  return m[3] === checkCharacter(m[1] + m[2]);
}

/**
 * Put what a scanner or a human typed into canonical form.
 *
 * Keyboard-wedge scanners occasionally emit a trailing carriage return or a
 * leading space, and people type these in lower case with the hyphens left
 * out. All of those mean the same specimen, and refusing them teaches people
 * the scan box is unreliable.
 *
 * **LEADING ZEROES ARE PADDING, NOT DATA.**
 *
 * This is the one that mattered, reported from use: the label read
 * `26-000003-G` and it was typed as `26-00003-G` — one zero short. Refused,
 * correctly by the letter of the old rule and wrongly in substance, because
 * `00003` and `000003` are the same sequence number and the check character
 * proves it: `G` is the check over the *padded* body, so a value that checks
 * out after padding cannot be a different specimen.
 *
 * So the sequence is padded to six before anything is validated. That widens
 * what is accepted without weakening the guarantee by one bit — a transposed
 * digit, a wrong digit or a mistyped check character still fails, which is
 * every case the check character exists for. Dropping a zero from a run of
 * them is not an error of that kind; it is the commonest thing a person does
 * when copying a number by eye, and a laboratory system that refuses it is
 * one people stop typing into.
 */
export function normaliseAccession(value: string): string {
  const bare = value.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');

  // Two-digit year, one to six sequence digits, one check character. The
  // year's width is fixed and the check is a single letter, so the middle is
  // unambiguous however short it has been written.
  const m = /^(\d{2})(\d{1,6})([A-Z])$/.exec(bare);
  if (!m) return value.trim().toUpperCase();

  return `${m[1]}-${m[2].padStart(6, '0')}-${m[3]}`;
}
