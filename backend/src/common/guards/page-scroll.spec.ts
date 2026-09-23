import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every hospital screen has to scroll itself.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 * ---------------------------------------
 * The app shell renders `<main className="... overflow-hidden">`, which is
 * deliberate: this is a desktop operational tool, and a page that scrolls the
 * whole window moves the sidebar and the header out of view along with the
 * content. So each page owns a scrolling region instead.
 *
 * The consequence is that forgetting one is invisible until a screen grows past
 * the fold. It renders perfectly, the layout looks right, nothing errors — and
 * the fields at the bottom simply cannot be reached. Clinic settings hit exactly
 * that: it was fine for months and became unusable the day two more settings
 * were added to it, and four newer pages had the same omission waiting.
 *
 * That is the shape this repo's static tests exist for: a property of the code
 * that no typechecker or unit test can see, whose absence is silent.
 *
 * WHY IT LIVES IN THE BACKEND SUITE
 * ---------------------------------
 * Same reason `endpoint-coverage.spec.ts` does — it reads client source as text
 * and needs no browser, and this is the suite that actually runs in CI. A test
 * that needs a rendering environment to assert a class name is a test that
 * stops being run.
 */

const BACKEND_SRC = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(BACKEND_SRC, '../..');
const APP_DIR = path.join(REPO_ROOT, 'web', 'app', '(app)');

function pages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pages(full));
    else if (entry === 'page.tsx') out.push(full);
  }
  return out;
}

describe('every screen inside the app shell scrolls', () => {
  const found = pages(APP_DIR);

  it('finds the pages at all', () => {
    // Guards the assertion below from passing vacuously if the app directory
    // moves — an empty list satisfies "none of them are broken".
    expect(found.length).toBeGreaterThan(10);
  });

  it('gives each one its own scrolling region', () => {
    /*
     * `overflow-y-auto` somewhere in the file, not a specific root element.
     * Some pages scroll an inner panel rather than the whole page — the ward
     * board and the queue both do — and insisting on a particular structure
     * would be asserting a layout rather than the property that matters.
     *
     * If this fails on a page you have just written, the fix is a wrapper:
     *   <div className="scroll-thin flex-1 overflow-y-auto p-4">
     */
    const missing = found
      .filter((file) => !readFileSync(file, 'utf8').includes('overflow-y-auto'))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(missing).toEqual([]);
  });

  it('keeps the shell itself from scrolling', () => {
    /*
     * The other half of the arrangement, and the reason the rule exists. If the
     * shell ever gains its own vertical scroll, every page suddenly "works"
     * and the sidebar scrolls away with the content — which is worse than the
     * bug this file catches, because it looks fine on a short screen.
     */
    const shell = readFileSync(path.join(REPO_ROOT, 'web', 'components', 'shell.tsx'), 'utf8');
    expect(shell).toContain('overflow-hidden');
  });
});
