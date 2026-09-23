import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The two period pickers offer the same periods, and neither sends half of one.
 *
 * WHY THIS IS A TEST AND NOT A SHARED FILE
 * ----------------------------------------
 * `types.ts` and `course-quantity.ts` are duplicated byte-for-byte across the
 * clients because Metro resolves no shared package without config nobody has
 * run on a device. These two cannot be byte-identical — one draws `<input
 * type="date">` and the other draws a calendar out of `View`s — so what has to
 * agree is the *arithmetic*, and only a test can say so.
 *
 * WHAT GOES WRONG WHEN THEY DRIFT
 * -------------------------------
 * A statement has no number by design: what identifies it is this laboratory,
 * that hospital, those days. So two clients that disagree about which days
 * "Last 7 days" covers do not produce a formatting difference — they produce
 * **two different statements with the same name**, issued by the same lab to
 * the same hospital, and the disagreement surfaces as a payment that is short.
 * The presets were cut from five to three by the product owner, and a cut
 * applied to one client and not the other is exactly how this starts.
 *
 * Same family as `module-coverage.spec.ts` comparing `ROLE_REQUIRES` across
 * three projects: the person who has to explain a difference between two
 * clients is the one who pressed the same button on a different device.
 */

const ROOT = path.resolve(__dirname, '../../../..');

const WEB = path.join(ROOT, 'web/components/period-picker.tsx');
const MOBILE = path.join(ROOT, 'mobile/components/period-picker.tsx');

/** Comments describe the code; matching against them tests the prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const web = stripComments(readFileSync(WEB, 'utf8'));
const mobile = stripComments(readFileSync(MOBILE, 'utf8'));

/** The body of one `PRESETS` array, as its `label:` strings in order. */
function presetLabels(source: string): string[] {
  const block = source.match(/const PRESETS[\s\S]*?\n\];/)?.[0];
  if (!block) throw new Error('no PRESETS array — did the picker get renamed?');
  return [...block.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Web says `Last 7 days` and the phone says `7 days`, because the phone has a
 * fraction of the width and the row above it already says what it is. That is
 * a wording difference and not a period difference, so the comparison is on
 * what the label *means*.
 */
function normalise(label: string): string {
  return label.toLowerCase().replace(/^last (\d)/, '$1').replace(/\s+/g, ' ').trim();
}

describe('the statement period picker', () => {
  it('offers the same three periods on both clients', () => {
    /*
     * Three, not five. Ten-daily and fortnightly are two dates either way, and
     * a chip for them is only correct on the one day of the cycle it was
     * written for — so they were cut and the date fields do the general case.
     * Pinned by name rather than by count: a count passes if somebody swaps
     * one preset for another on one client only.
     */
    expect(presetLabels(web).map(normalise)).toEqual([
      'this month',
      'last month',
      '7 days',
    ]);
    expect(presetLabels(mobile).map(normalise)).toEqual(presetLabels(web).map(normalise));
  });

  it('resolves "this month" on the server on both clients', () => {
    /*
     * `null`, never two dates computed here. An absent period is resolved in
     * the hospital's own timezone, so the commonest case is the one place the
     * device's clock is never consulted. Filling the boxes in from the browser
     * would make the chip look like its neighbours and quietly hand a clinic
     * on the other side of a date line the wrong month.
     */
    for (const source of [web, mobile]) {
      const block = source.match(/const PRESETS[\s\S]*?\n\];/)![0];
      const thisMonth = block.match(/label:\s*'This month',\s*period:\s*([^,\n]+)/)?.[1];
      expect(thisMonth).toMatch(/=>\s*null/);
    }
  });

  it('counts a rolling window inclusively on both clients', () => {
    // `n - 1`. Seven days including today, not eight — the off-by-one that
    // bills a day twice across consecutive weekly cycles.
    for (const source of [web, mobile]) {
      expect(source).toMatch(/setDate\(\s*from\.getDate\(\)\s*-\s*\(n - 1\)\s*\)/);
    }
  });

  it('sends both ends of a period or neither', () => {
    /*
     * The server refuses one end without the other, and that refusal is right.
     * What must not happen is meeting it as a red API error while somebody is
     * still choosing the second date — so a half-written range is held on the
     * client. Asserted on `periodQuery`, which is the only thing that builds
     * the URL, and on the guard in front of the parent callback.
     */
    for (const source of [web, mobile]) {
      expect(source).toMatch(/if \(!period\?\.from \|\| !period\.to\) return '';/);
    }

    // Web holds a draft and only lifts a complete, ordered pair out of it.
    expect(web).toMatch(/if \(next\.from === '' \|\| next\.to === '' \|\| next\.to < next\.from\) return;/);
    // The phone commits only a complete pair, and cannot produce a backwards
    // one at all — see the next assertion.
    expect(mobile).toMatch(/if \(next\.from && next\.to\) onChange\(next\);/);
  });

  it('gives neither client a way to send a backwards period', () => {
    // Web says it in words, beside the boxes that caused it.
    expect(web).toMatch(/next\.to < next\.from/);
    expect(web).toMatch(/The period ends before it starts/);

    /*
     * The phone does not need words: the day is not tappable. `disabled` on
     * the cell is the whole mechanism, so it is pinned — a later tidy-up that
     * turns it into a styled-but-pressable cell would restore a state the
     * server refuses, on the screen with the least room to explain why.
     */
    expect(mobile).toMatch(/const blocked =/);
    expect(mobile).toMatch(/disabled=\{blocked\}/);
  });

  it('keeps arbitrary dates on both clients, not only the web', () => {
    /*
     * This was web-only, on the reasoning that two date pickers on a small
     * screen is where an off-by-one boundary comes from. The hazard is real
     * and the conclusion was not: a laboratory on an unusual cycle could not
     * issue its statement from a phone at all. The hazard is answered by
     * *tapping* a day rather than typing one, which the assertion above pins.
     *
     * Same shape as the medication round kept off the web and reception kept
     * off mobile — a plausible story about where work happens, standing in for
     * the fact that nobody had built the other half.
     */
    expect(web).toMatch(/type="date"/);
    expect(mobile).toMatch(/function monthCells\(/);
    expect(mobile).toMatch(/onPress=\{\(\) => pick\(day\)\}/);
  });
});
