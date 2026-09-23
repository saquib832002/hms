import { readFileSync } from 'node:fs';
import path from 'node:path';
import { code128Widths, code128Svg } from './code128';
import {
  checkCharacter,
  formatAccession,
  isValidAccession,
  normaliseAccession,
} from './accession';

/**
 * The number on the tube, and the bars that encode it.
 *
 * WHY THE CHECK CHARACTER IS THE IMPORTANT PART
 * ---------------------------------------------
 * A barcode either scans or it does not, and a failed scan is obvious. The
 * dangerous case is the one where a *human* reads a number off a smudged label
 * down a telephone, transposes two digits, and the wrong number resolves to a
 * real specimen belonging to somebody else. That failure is silent, and it is
 * the worst one available in a laboratory.
 *
 * So the assertions here are mostly about refusal: that a transposition does
 * not validate, that a wrong check character does not validate, and that the
 * check runs before the database is ever asked.
 */

describe('accession numbers', () => {
  it('formats as year, sequence and a check character', () => {
    expect(formatAccession(2026, 412)).toMatch(/^26-000412-[A-Z]$/);
  });

  it('validates one it produced', () => {
    for (const n of [1, 42, 412, 999999]) {
      expect(isValidAccession(formatAccession(2026, n))).toBe(true);
    }
  });

  it('refuses a transposition', () => {
    /*
     * The failure this exists for. `000412` mistyped as `000421` must not
     * resolve — a plain checksum cannot see this, which is why the weights
     * alternate.
     */
    const good = formatAccession(2026, 412);
    const swapped = good.replace('000412', '000421');
    expect(swapped).not.toBe(good);
    expect(isValidAccession(swapped)).toBe(false);
  });

  it('refuses a wrong check character', () => {
    const good = formatAccession(2026, 412);
    const wrong = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect(isValidAccession(wrong)).toBe(false);
  });

  it('refuses anything that is not the shape', () => {
    for (const bad of ['', '412', 'ABC', '26-000412', '2026-000412-K', 'not a number']) {
      expect(isValidAccession(bad)).toBe(false);
    }
  });

  it('uses no character that is misread as a digit', () => {
    /*
     * `I`, `O` and `S` are excluded from the check alphabet. A check character
     * that is itself ambiguous under a smudged thermal print defeats the point
     * of having one.
     */
    const produced = new Set(
      Array.from({ length: 500 }, (_, i) => formatAccession(2026, i + 1).slice(-1)),
    );
    for (const forbidden of ['I', 'O', 'S']) expect(produced.has(forbidden)).toBe(false);
  });

  it('treats a dropped leading zero as padding, not as a different number', () => {
    /*
     * THE BUG THIS EXISTS FOR
     * -----------------------
     *     GET /lab-orders/by-accession/26-00003-G → 400
     *     26-00003-G is not a valid specimen number
     *
     * The label read `26-000003-G` and it was typed one zero short. Refused by
     * the letter of the rule and wrong in substance: `00003` and `000003` are
     * the same sequence, and the check character proves it — `G` is computed
     * over the *padded* body, so anything that checks out after padding cannot
     * be a different specimen.
     *
     * Copying a number by eye and dropping one of a run of zeroes is the
     * commonest thing a person does, and a laboratory system that refuses it is
     * one people stop typing into.
     */
    const canonical = formatAccession(2026, 3);
    expect(canonical).toBe('26-000003-G');

    for (const typed of ['26-00003-G', '26-0003-G', '26-3-G', '263g', ' 26-00003-g\n']) {
      expect(normaliseAccession(typed)).toBe(canonical);
      expect(isValidAccession(typed)).toBe(true);
    }
  });

  it('does not become tolerant of anything else', () => {
    /*
     * The other half, and the one that matters more. Padding is not data;
     * every other kind of slip still has to fail, because a mistyped number
     * that resolves to another patient's specimen is the worst failure
     * available in a laboratory.
     */
    for (const wrong of [
      '26-000030-G', // a zero in the wrong place — a different sequence
      '26-000004-G', // right shape, wrong check character
      '26-000003-H', // right number, mistyped check character
      '27-000003-G', // right sequence, wrong year
    ]) {
      expect(isValidAccession(wrong)).toBe(false);
    }
  });

  it('accepts what a scanner or a person actually types', () => {
    const good = formatAccession(2026, 412);
    const bare = good.replace(/-/g, '');
    // Keyboard-wedge scanners add whitespace; people drop the hyphens and
    // shift key. All of these mean the same specimen, and refusing them
    // teaches people the scan box is unreliable.
    expect(normaliseAccession(`  ${bare.toLowerCase()}\n`)).toBe(good);
    expect(isValidAccession(` ${good} `)).toBe(true);
  });

  it('is stable — the same input always checks the same', () => {
    expect(checkCharacter('26000412')).toBe(checkCharacter('26000412'));
  });
});

describe('a number is never a dead end', () => {
  /*
   * THE BUG THIS EXISTS FOR
   * -----------------------
   * Reported on the first real look at the worklist: *"for everything, it is
   * showing as no specimen number"*. Correct — the migration deliberately does
   * not backfill, because inventing a number for an order that never had a
   * label printed would put one on a tube nobody can find.
   *
   * What was wrong is that there was no way out of that state. `ensureAccession`
   * is the route: a number is allocated the first time somebody needs one, at
   * collection and at label printing, which are the two moments a physical tube
   * comes into existence.
   *
   * Allocation at *ordering* stays, and is not the same decision: the label has
   * to be printed before the draw, so the number cannot wait for collection to
   * be recorded.
   */
  const SERVICE = readFileSync(path.join(__dirname, 'lab.service.ts'), 'utf8');
  const DOCS = readFileSync(
    path.join(__dirname, '..', 'documents', 'documents.service.ts'),
    'utf8',
  );

  it('allocates when the specimen is taken', () => {
    expect(SERVICE).toMatch(/const accession = await this\.ensureAccession\(id\);/);
  });

  it('allocates when a label is printed rather than refusing', () => {
    expect(DOCS).toMatch(/o\.accession \?\? \(await this\.lab\.ensureAccession\(o\.id\)\)/);
    // The old refusal, which made "no specimen no." permanent.
    expect(DOCS).not.toMatch(/there is no label to print/);
  });

  it('still allocates at ordering, because the label precedes the draw', () => {
    expect(SERVICE).toMatch(/accession: await this\.nextAccession\(tx\)/);
  });

  it('never invents one for an order nobody has acted on', () => {
    /*
     * No backfill in the migration, and none anywhere else. A number on a
     * record that never had a tube is a number somebody will search for.
     */
    const migration = readFileSync(
      path.join(__dirname, '..', '..', 'prisma', 'migrations', '20260907230000_lab_accession', 'migration.sql'),
      'utf8',
    );
    expect(migration).not.toMatch(/UPDATE\s+"?lab_orders"?\s+SET\s+"?accession"?/i);
  });
});

describe('the doctor is shown the number, not the row id', () => {
  /*
   * THE BUG THIS EXISTS FOR
   * -----------------------
   * The order sheet's confirmation read `Request #{issued.id}` — the database
   * row id, which appears on no label, no worklist row, no invoice line and no
   * report. So the doctor who raised the order was handed the one identifier
   * in the system that maps to nothing, and reported it as *"this number is
   * not getting generated"*. It was generated at ordering; it was never shown.
   *
   * The row id was removed rather than demoted. Two numbers against one order
   * is worse than the wrong one alone: somebody quotes whichever they read
   * first, and only one of them resolves anywhere.
   *
   * A source assertion, like the rest of the guards here, because what matters
   * is which value reaches the screen — and the failure is invisible in review,
   * since `#{issued.id}` looks exactly like a reference number.
   */
  const ROOT = path.resolve(__dirname, '../../..');
  const RAW = readFileSync(path.join(ROOT, 'web/components/lab-order-sheet.tsx'), 'utf8');

  /*
   * Comments stripped first, and this failed on its first run without it — the
   * note explaining *why* the row id was removed quotes `#{issued.id}`, so the
   * assertion below matched the explanation rather than any rendered value.
   *
   * `nav-modules.spec.ts` learned the same thing: a false positive here is not
   * harmless, because it is answered by weakening the assertion or adding an
   * exemption, and an exemption list that has absorbed a broken matcher is how
   * real gaps disappear.
   */
  const SHEET = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('leads with the accession', () => {
    expect(SHEET).toMatch(/Order number/);
    expect(SHEET).toMatch(/\{issued\.accession \?\? '—'\}/);
  });

  it('does not present the row id as one', () => {
    /*
     * `issued.id` may still exist — it is what the sheet was built from — but
     * it must not be rendered with the `#` that makes it read as a reference.
     */
    expect(SHEET).not.toMatch(/#\{issued\.id\}/);
  });

  it('carries it back from the API, so there is something to show', () => {
    // The response shape had no `accession` at all, which is why the sheet
    // could only reach for the row id in the first place.
    expect(SHEET).toMatch(/accession: string \| null;/);
  });
});

describe('Code 128', () => {
  it('starts on a bar and ends on one', () => {
    /*
     * The pattern is read as alternating runs beginning with a bar, and both
     * renderers rely on that. A symbol ending on a space would drop its
     * termination bar and scan as truncated.
     */
    const widths = code128Widths('26-000412-K');
    expect(widths.length % 2).toBe(1);
  });

  it('encodes start, data, checksum and stop', () => {
    /*
     * Six modules per code, plus the seven-run stop. 11 characters of data is
     * 1 start + 11 data + 1 checksum = 13 codes at 6 runs, then 7 for stop.
     */
    expect(code128Widths('26-000412-K')).toHaveLength(13 * 6 + 7);
  });

  it('changes when the value changes', () => {
    // A guard against an encoder that silently produces the same symbol for
    // everything — which would scan perfectly and always be wrong.
    expect(code128Widths('26-000412-K')).not.toEqual(code128Widths('26-000413-M'));
  });

  it('refuses a character it cannot represent', () => {
    /*
     * Thrown rather than dropped. Silently skipping a character produces a
     * label that scans cleanly to the *wrong* value, which in a laboratory
     * means a result filed against the wrong specimen.
     */
    expect(() => code128Widths('26–000412')).toThrow(/cannot encode/);
    expect(() => code128Widths('')).toThrow();
  });

  it('draws on white, always', () => {
    /*
     * A barcode on a transparent background over a dark theme is one no
     * scanner can read, and the failure only appears when somebody points a
     * scanner at a screen.
     */
    const svg = code128Svg('26-000412-K');
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('<rect');
    expect(svg.startsWith('<svg')).toBe(true);
  });
});
