import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The product name lives in one place per client, and the old one is gone.
 *
 * WHY THIS EXISTS
 * ---------------
 * Renaming the product from *Meridian HMS* to *OneCare* meant editing **eight**
 * places: the wordmark markup on two web screens and one mobile screen, a
 * browser tab title, an OS biometric prompt, an idle-lock sentence, a signup
 * sentence, and a line in a reset email. Every one of them was a hand-typed
 * copy of the same string.
 *
 * The screen somebody misses in a rename is never the login page they look at
 * daily — it is the biometric prompt, or the lock screen after fifteen idle
 * minutes, or the sentence on a form only strangers read. Those are precisely
 * the places a half-finished rebrand survives for months, and they are the ones
 * that make a product look unfinished to somebody evaluating it.
 *
 * Same shape as the role list that ended up hand-written in four client files
 * with three of them wrong, and `role-lists.spec.ts` is the model for this.
 *
 * WHAT IS DELIBERATELY STILL ALLOWED TO SAY "MERIDIAN"
 * ---------------------------------------------------
 * The incident record. `documents.spec.ts` and `tenant-chrome.spec.ts` both
 * forbid a hard-coded *hospital* name in code that renders to a patient or to
 * signed-in chrome, and both name `Meridian` in their pattern because that is
 * the string that actually leaked — a prescription printed with the demo seed's
 * hospital on it, carried into a pharmacy by a patient who had never attended
 * that hospital. Removing the word from those guards to tidy up a rebrand would
 * retire a safety control to make a search result clean.
 *
 * So this checks the *rendered* strings and leaves comments and guard patterns
 * alone.
 */

const REPO = path.resolve(__dirname, '../../../..');

/** Where the name and its colour split are allowed to be written down. */
const SOURCES = [
  'web/lib/types.ts',
  'mobile/lib/types.ts',
  'web/components/ui/wordmark.tsx',
  'mobile/components/wordmark.tsx',
  /*
   * The backend's own copy, for the one email it sends. It cannot import from
   * either client — the dependency would run from the layer that enforces the
   * rules to the layer that draws them — so the duplication is deliberate and
   * its own comment says a rename has to touch it.
   */
  'backend/src/platform/platform-password-reset.service.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Comments first, always.
 *
 * This file's own explanation names the old brand at length, and so do the
 * files it checks — `shell.tsx` carries a paragraph about the sidebar that used
 * to say "MeridianHMS". A guard that failed on its own reasoning gets answered
 * by deleting the reasoning, which has happened in this repo before.
 */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const CLIENT_FILES = [...walk(path.join(REPO, 'web')), ...walk(path.join(REPO, 'mobile'))];

describe('the product name is written down once per client', () => {
  it('finds the client files it is checking', () => {
    // Vacuous-pass guard: a moved directory would make every assertion below
    // true while reading nothing at all.
    expect(CLIENT_FILES.length).toBeGreaterThan(50);
  });

  it('ships no rendered "Meridian" anywhere in either client', () => {
    const offenders = CLIENT_FILES.filter((f) => /Meridian/i.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(REPO, f))
      // `types.ts` explains the rename in prose that survives comment
      // stripping only if somebody writes it as a string; it does not.
      .filter((f) => !SOURCES.includes(f.split(path.sep).join('/')));

    expect(offenders).toEqual([]);
  });

  it('never retypes the wordmark beside the component that draws it', () => {
    /*
     * The failure this catches is somebody adding a fourth pre-auth screen and
     * writing `OneCare <span className="text-brand">HMS</span>` into it,
     * because that is exactly what the login page looks like in a diff. It
     * renders correctly today and is wrong the day the split or the colour
     * moves — and it moves silently, because the screen that keeps the old one
     * is the screen nobody opens.
     */
    const offenders = CLIENT_FILES.filter((f) => {
      const rel = path.relative(REPO, f).split(path.sep).join('/');
      if (SOURCES.includes(rel)) return false;
      const code = strip(readFileSync(f, 'utf8'));
      /*
       * `HMS` inside its own element is the shape of a hand-typed wordmark.
       * Matched rather than the word "OneCare", which appears legitimately in
       * prose through `BRAND` and should keep being allowed to.
       */
      return />HMS</.test(code) || /HMS<\/(span|Text)>/.test(code);
    }).map((f) => path.relative(REPO, f));

    expect(offenders).toEqual([]);
  });

  it('keeps the name and the splits in the file both clients share', () => {
    for (const rel of ['web/lib/types.ts', 'mobile/lib/types.ts']) {
      const src = readFileSync(path.join(REPO, rel), 'utf8');
      expect(src).toMatch(/BRAND_PARTS = \['One', 'Care', 'HMS'\] as const/);

      /*
       * Both derived from the parts, never retyped — so a rename cannot leave
       * the prose saying the old name while the logo says the new one, which
       * is the half-finished state the last rebrand produced in eight places.
       *
       * And the spacing is asymmetric on purpose: `OneCare HMS`, never
       * `One Care HMS`. A `join(' ')` over three parts would produce the
       * second and look entirely plausible in a diff, which is why the shape
       * of the expression is pinned rather than just its existence.
       */
      expect(src).toMatch(/export const BRAND = `\$\{BRAND_PARTS\[0\]\}\$\{BRAND_PARTS\[1\]\}`/);
      expect(src).toMatch(/export const BRAND_FULL = `\$\{BRAND\} \$\{BRAND_PARTS\[2\]\}`/);
      expect(src).not.toMatch(/BRAND_PARTS\.join/);
    }
  });

  it('draws the three parts in the same three colours on both clients', () => {
    /*
     * Web resolves `text-brand-*` from `tailwind.config.ts`; mobile reads
     * `theme.color.brand*`. Two files, and nothing but this makes them agree —
     * a wordmark that is one set of colours on a desktop and another on a
     * phone is the drift nobody notices until somebody holds the two side by
     * side, which is usually in front of a customer.
     *
     * The *values* are asserted rather than the token names, because the names
     * legitimately differ: mobile calls the red `cross` as well, for the
     * medical mark in the icon.
     */
    const web = readFileSync(path.join(REPO, 'web/tailwind.config.ts'), 'utf8');
    const mobile = readFileSync(path.join(REPO, 'mobile/lib/theme.ts'), 'utf8');

    expect(web).toMatch(/one: '#1E6FD9'/);
    expect(web).toMatch(/care: '#14181D'/);
    expect(web).toMatch(/hms: '#A4161A'/);

    expect(mobile).toMatch(/brandOne: '#1E6FD9'/);
    expect(mobile).toMatch(/brandCare: '#14181D'/);
    expect(mobile).toMatch(/const BRAND_RED = '#A4161A'/);
    expect(mobile).toMatch(/brandHms: BRAND_RED/);

    /*
     * And not the semantic tokens.
     *
     * On the web `brand-one` is the same blue as `primary` today, and that is
     * a coincidence rather than a relationship — pointing the logo at
     * `primary` would mean retuning the button blue silently restyles the
     * mark. On the phone it is worse: `primary` is derived from the signed-in
     * **role**, so a wordmark using it would change colour depending on who
     * was logged in. And neither may use `danger`, which means "this failed".
     */
    for (const rel of ['web/components/ui/wordmark.tsx', 'mobile/components/wordmark.tsx']) {
      const src = strip(readFileSync(path.join(REPO, rel), 'utf8'));
      expect(src).not.toMatch(/text-primary|text-danger|color\.primary|color\.danger/);
    }
  });

  it('leaves the hospital-name guards naming the string that actually leaked', () => {
    /*
     * The opposite direction, and the one worth protecting. `Meridian Hospital`
     * was printed on every tenant's prescriptions; the patterns that forbid a
     * hard-coded hospital name still name it, and a rebrand tidy-up must not
     * remove that.
     */
    expect(readFileSync(path.join(REPO, 'backend/src/documents/documents.spec.ts'), 'utf8')).toMatch(
      /Meridian/,
    );
    expect(
      readFileSync(path.join(REPO, 'backend/src/common/guards/tenant-chrome.spec.ts'), 'utf8'),
    ).toMatch(/const FORBIDDEN = \/Meridian/);
  });
});
