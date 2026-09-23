import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A menu entry must declare the modules the screen behind it actually needs.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `Today's Queue` had no module tag. It calls `GET /me/queue`, which lives
 * under `src/me/` and carries `@RequiresModule(CLINIC)`. So at a pharmacy-only
 * tenant a doctor signed in, was landed on the queue because it was the first
 * item in their menu, and met a 403 as the first thing they saw:
 *
 *   ForbiddenException: Outpatient clinic is not part of your hospital's plan
 *
 * The guard was right and the menu was wrong, which is the worst arrangement of
 * the two — a refusal the user did nothing to cause, on a screen the app itself
 * chose to open.
 *
 * `endpoint-coverage.spec.ts` could not see it: `/me/queue` has a caller, and
 * `module-coverage.spec.ts` could not either, because the controller was
 * correctly decorated. What nothing compared was the client's idea of which
 * module a screen belongs to against the server's.
 *
 * WHY THE ROLE'S OWN MODULE DOES NOT COUNT
 * ----------------------------------------
 * A nav item only has to declare what its *role* does not already imply. A
 * PHARMACIST cannot exist at a tenant without PHARMACY — `ROLE_REQUIRES` sees
 * to that on both clients and in `UsersService` — so a pharmacy screen in the
 * pharmacist's menu needs no tag. `Ward Supply` does, and carries WARDS rather
 * than PHARMACY, which reads oddly and is right: what that screen needs is a
 * ward to ask.
 */

const SRC = path.resolve(__dirname, '../..');
const REPO = path.resolve(SRC, '../..');
const WEB_APP = path.join(REPO, 'web/app/(app)');

/* ── the server's view: which module a route needs ───────────────────────── */

interface ControllerBase {
  base: string;
  module: string | null;
}

function walk(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry)) out.push(full);
  }
  return out;
}

const CONTROLLERS: ControllerBase[] = walk(SRC, /\.controller\.ts$/).flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  const blocks = [...src.matchAll(/@Controller\((?:'([^']*)')?\)/g)];

  // A file may hold several controllers — vitals and medications both do.
  return blocks.map((block, i) => {
    const body = src.slice(block.index ?? 0, blocks[i + 1]?.index ?? src.length);
    const required = /@RequiresModule\(TenantModule\.(\w+)\)/.exec(body);
    return { base: `/${block[1] ?? ''}`.replace(/\/+$/, ''), module: required?.[1] ?? null };
  });
});

/**
 * Which module an API path needs, by longest matching controller base.
 *
 * Longest wins because bases nest: `/patients` is ungated and
 * `/patients/:patientId/lab-orders` is the laboratory. Taking the first match
 * would report the laboratory route as part of the always-on floor, which is
 * the wrong answer in the dangerous direction.
 */
function moduleForPath(apiPath: string): string | null {
  let best: ControllerBase | null = null;
  for (const controller of CONTROLLERS) {
    if (controller.base === '' || controller.base === '/') continue;
    // Controller bases carry `:params`; client paths carry `${}`. Compare with
    // both collapsed, or every nested route misses.
    const base = normalise(controller.base);
    const candidate = normalise(apiPath);
    if (candidate !== base && !candidate.startsWith(`${base}/`)) continue;
    if (!best || base.length > normalise(best.base).length) best = controller;
  }
  return best?.module ?? null;
}

const normalise = (p: string) =>
  p
    .split('/')
    .map((seg) => (seg.startsWith(':') || seg.includes('${') ? ':p' : seg))
    .join('/');

/* ── the client's view: the nav table ────────────────────────────────────── */

interface NavEntry {
  role: string;
  href: string;
  module: string | null;
}

function parseNav(): NavEntry[] {
  const src = readFileSync(path.join(REPO, 'web/lib/nav.ts'), 'utf8');
  const table = src.slice(src.indexOf('const NAV'), src.indexOf('export function navFor'));
  const entries: NavEntry[] = [];

  for (const roleBlock of table.matchAll(/^ {2}(\w+): \[([\s\S]*?)^ {2}\],/gm)) {
    const [, role, body] = roleBlock;
    for (const item of body.matchAll(/\{[^{}]*href: '([^']*)'[^{}]*\}/g)) {
      entries.push({
        role,
        href: item[1],
        module: /module: '(\w+)'/.exec(item[0])?.[1] ?? null,
      });
    }
  }
  return entries;
}

const NAV = parseNav();

/** `ROLE_REQUIRES` from the web nav — what a role already guarantees. */
function roleModules(): Record<string, string | undefined> {
  const src = readFileSync(path.join(REPO, 'web/lib/nav.ts'), 'utf8');
  const block = /const ROLE_REQUIRES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  const map: Record<string, string> = {};
  for (const m of (block?.[1] ?? '').matchAll(/^\s*(\w+): '(\w+)',/gm)) map[m[1]] = m[2];
  return map;
}

const ROLE_MODULE = roleModules();

/**
 * Comments removed before anything is read out of a file.
 *
 * Without this the check reported three screens as untagged because their
 * header comments *mention* sibling routes — `/pharmacy/invoices` and
 * `/lab/invoices` each explain that the other exists and returns a disjoint
 * set. A false positive here is not harmless: it is answered by adding an
 * exemption, and an exemption list that has absorbed a broken extractor is how
 * real gaps disappear. That has happened in this repo before.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The API paths a screen calls, read out of its `page.tsx`. */
function apiPathsFor(href: string): string[] | null {
  const page = path.join(WEB_APP, href, 'page.tsx');
  if (!existsSync(page)) return null;

  const src = stripComments(readFileSync(page, 'utf8'));
  const paths = new Set<string>();
  /*
   * Every path-shaped literal, not only the ones inside an `api()` call.
   *
   * Deliberately loose. A `<Link href>` to a gated screen is worth catching
   * too — it is a dead link for that tenant — and the cost of the looseness is
   * a screen occasionally having to be listed below with a reason, which is a
   * conversation worth having rather than an assertion worth weakening.
   */
  for (const m of src.matchAll(/['"`](\/[A-Za-z0-9_\-/${}.:]*)['"`]/g)) {
    paths.add(m[1].split('?')[0]);
  }
  return [...paths];
}

/**
 * Screens that reach into more than one module and degrade internally instead.
 *
 * Each is on the always-on floor — every tenant gets patients, staff accounts,
 * clinic settings and its own figures — so a tag would be wrong for the page
 * even though part of it is gated. The reason has to be written down, because
 * the failure this list can hide is exactly the one above.
 */
const DEGRADES_INTERNALLY: Record<string, string> = {
  '/patients':
    'The record is the floor; Records and Prescriptions hide without CLINIC and Tests without LABORATORY.',
  '/admin/reports':
    'A hospital always sees its own takings. The doctors card hides without CLINIC and the invoices link without BILLING.',
  '/admin/settings':
    'Clinic settings is the floor. The tax block and its /tax-rates fetch hide without BILLING.',
};

describe('a nav item declares what its screen calls', () => {
  it('finds the nav table and the controllers', () => {
    // Vacuous-pass guard. An empty parse would make every assertion below true
    // while comparing nothing — which is how this drifted in the first place.
    expect(NAV.length).toBeGreaterThan(25);
    expect(CONTROLLERS.length).toBeGreaterThan(25);
    expect(CONTROLLERS.filter((c) => c.module).length).toBeGreaterThan(10);
    expect(Object.keys(ROLE_MODULE).length).toBeGreaterThan(4);
  });

  it('resolves a nested route to the module that owns it', () => {
    // The matcher itself, pinned. If longest-prefix matching broke, everything
    // below would pass by finding no requirement anywhere.
    expect(moduleForPath('/me/queue')).toBe('CLINIC');
    expect(moduleForPath('/patients/${}/lab-orders')).toBe('LABORATORY');
    expect(moduleForPath('/patients')).toBeNull();
  });

  it('tags every screen whose API its role does not already imply', () => {
    const untagged: string[] = [];

    for (const entry of NAV) {
      if (DEGRADES_INTERNALLY[entry.href]) continue;
      const paths = apiPathsFor(entry.href);
      if (paths === null) continue;

      const implied = new Set(
        [ROLE_MODULE[entry.role], entry.module].filter(Boolean) as string[],
      );

      for (const apiPath of paths) {
        const required = moduleForPath(apiPath);
        if (required && !implied.has(required)) {
          untagged.push(`${entry.role} ${entry.href} calls ${apiPath} (${required})`);
        }
      }
    }

    expect([...new Set(untagged)]).toEqual([]);
  });

  it('gives every internally-degrading screen a written reason', () => {
    /*
     * The same rule `endpoint-coverage.spec.ts` learned expensively: a false
     * reason in an exemption list is worse than no list, because it reads as a
     * decision somebody made and gets skimmed past. Three of those have been
     * found in this repo already.
     */
    for (const [href, reason] of Object.entries(DEGRADES_INTERNALLY)) {
      expect(reason.length).toBeGreaterThan(40);
      expect(existsSync(path.join(WEB_APP, href, 'page.tsx'))).toBe(true);
    }
  });

  it('has no stale entry in that list', () => {
    // A screen that stopped calling anything gated should lose its exemption,
    // so the list shrinks on its own rather than rotting into claims nobody
    // rechecks.
    const stale = Object.keys(DEGRADES_INTERNALLY).filter((href) => {
      const paths = apiPathsFor(href) ?? [];
      return !paths.some((p) => moduleForPath(p));
    });

    expect(stale).toEqual([]);
  });
});
