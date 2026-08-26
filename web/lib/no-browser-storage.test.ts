import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A static guard on the rule that matters most in this client.
 *
 * The access token lives in memory. Anything JavaScript can read, an XSS
 * payload can read — and a token stolen from here reads patient records. The
 * long-lived credential is deliberately an httpOnly cookie that script cannot
 * touch at all.
 *
 * This is exactly the sort of rule that gets broken later by someone adding a
 * harmless-looking "remember my filter" feature and reaching for localStorage
 * next to the auth code. Grepping the source is crude, but it fails loudly at
 * the moment it happens rather than in a penetration test.
 */

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'components', 'app'];
const FORBIDDEN = ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB'];

/**
 * Comments are stripped before scanning. The rule is about executed code —
 * and lib/api.ts deliberately explains at length why localStorage is not used,
 * which a naive grep flags as a violation of the rule it is documenting.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  const full = path.join(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(full)) {
    const p = path.join(full, entry);
    if (statSync(p).isDirectory()) {
      out.push(...sourceFiles(path.join(dir, entry)));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe('browser storage is never used', () => {
  const files = SCAN_DIRS.flatMap(sourceFiles);

  it('finds source files to scan', () => {
    // Guards against the scan silently passing because it found nothing.
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN)('never references %s', (api) => {
    const offenders = files
      .filter((f) => stripComments(readFileSync(f, 'utf8')).includes(api))
      .map((f) => path.relative(ROOT, f));

    expect(
      offenders,
      `${api} must not be used — see lib/api.ts for why the access token stays in memory`,
    ).toEqual([]);
  });
});
