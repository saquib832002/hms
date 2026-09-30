import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Nothing may import `expo-notifications` at the top level.
 *
 * WHY THIS IS A BUILD FAILURE RATHER THAN A CONVENTION
 * ---------------------------------------------------
 * In Expo Go on Android the module **throws when it is imported**. Remote push
 * left Expo Go in SDK 53, and from SDK 55 `expo-notifications` raises instead of
 * warning — at import, before any of our code runs.
 *
 * Expo Router statically requires every file under `app/`. So one top-level
 * import, in one screen nobody has opened, takes down the **whole app** at
 * launch: a red screen naming `expo-router/build/ExpoRoot.js` and no file of
 * ours anywhere in the stack. That is what it did, and the first fix — a guard
 * inside `registerForPush` — could not work, because the throw happens before
 * the function exists to be called.
 *
 * `loadNotifications` in `lib/push.ts` is the one permitted importer and it uses
 * a dynamic `import()`, resolving to null where the module will not load.
 *
 * This is asserted rather than remembered because the mistake is invisible in
 * review: `import * as Notifications from 'expo-notifications'` is exactly what
 * the library's own documentation shows, it typechecks, and it works perfectly
 * in a development build — so it can be added, reviewed, merged and released,
 * and only breaks for whoever next opens the app in Expo Go.
 */

/** The one file allowed to name the module, and only inside `import(...)`. */
const OWNER = join('lib', 'push.ts');

/** Source we control. `node_modules` and generated `android/` are not ours. */
const ROOTS = ['app', 'components', 'lib'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Comments are stripped first. Without it this test fails against the very
 * paragraphs that explain the rule — and a false positive here is not harmless,
 * because the obvious way to silence one is an exemption, and an exemption list
 * that has absorbed a broken matcher is how a real gap disappears. That has
 * happened twice in this repo (`nav-modules.spec.ts`, `accession.spec.ts`).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('expo-notifications is never imported at the top level', () => {
  const root = join(__dirname, '..');
  const files = ROOTS.flatMap((r) => sourceFiles(join(root, r)));

  it('scans a plausible number of files', () => {
    // A matcher that silently found nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files.map((f) => [f.slice(root.length + 1).replace(/\\/g, '/'), f] as const))(
    '%s',
    (relative, absolute) => {
      const source = stripComments(readFileSync(absolute, 'utf8'));

      // A static `import ... from 'expo-notifications'`, in any of its forms.
      const staticImport = /\bimport\b[^;]*?\bfrom\s*['"]expo-notifications['"]/s.test(source);
      // ...and the side-effect-only form, which has no `from`.
      const bareImport = /\bimport\s*['"]expo-notifications['"]/.test(source);

      expect({ file: relative, staticImport, bareImport }).toEqual({
        file: relative,
        staticImport: false,
        bareImport: false,
      });

      // The dynamic form is the point, and only `lib/push.ts` should need it.
      if (/import\s*\(\s*['"]expo-notifications['"]/.test(source)) {
        expect(relative.replace(/\//g, require('path').sep)).toBe(OWNER);
      }
    },
  );

  it('keeps the dynamic import, so the rule has somewhere to be satisfied', () => {
    // Without this, deleting push.ts's loader would leave every assertion above
    // green and the app with no push at all — a guard that passes by absence.
    const owner = readFileSync(join(root, OWNER), 'utf8');
    expect(owner).toMatch(/await import\(\s*['"]expo-notifications['"]\s*\)/);
    expect(owner).toMatch(/executionEnvironment/);
  });
});
