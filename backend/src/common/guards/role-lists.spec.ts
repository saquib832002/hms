import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { UserRole } from '@prisma/client';

/**
 * Nobody writes the list of roles out by hand.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `LAB_TECHNICIAN` was added to `UserRole`, given a nav menu, a landing screen,
 * four working screens on the web and three on the phone, an entry in the
 * access matrix and a passing test suite — and **could not be created**. Three
 * screens across the two clients each declared their own array of roles, none
 * of them knew about the new one, and so no account could ever hold it.
 *
 * The symptom was reported two roles away from the cause: a doctor ordered a
 * test, the order was written correctly, and it was visible to nobody. The lab
 * worklist was not broken — there was simply no user who could open it.
 *
 * WHY A TEST RATHER THAN JUST DERIVING THE LIST
 * ---------------------------------------------
 * Both clients now derive from `ROLE_LABEL`, which is a `Record<UserRole,
 * string>` — so adding a member to the enum is a compile error until somebody
 * names it, and every screen picks it up for free. That is the real fix.
 *
 * This guards the fix. Re-declaring a local array compiles perfectly and is
 * invisible in review, because a list of six role names looks like exactly what
 * it should be. The failure only appears when somebody tries to use the seventh.
 *
 * Same family as `settings-reachable.spec.ts` and `self-provisionable.spec.ts`:
 * a capability the system believes it has, which nothing can actually reach.
 */

const BACKEND = path.resolve(__dirname, '../../..');
const ROOT = path.resolve(BACKEND, '..');

function walk(dir: string, match: RegExp): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry === '.next') return [];
    if (statSync(full).isDirectory()) return walk(full, match);
    return match.test(entry) ? [full] : [];
  });
}

const ROLES = Object.values(UserRole);

/**
 * Where the single source of truth lives on each client, and may hold a literal
 * list. Everything else derives from these.
 */
const SOURCES_OF_TRUTH = ['web/lib/nav.ts', 'mobile/lib/nav.ts'];

/**
 * `MOBILE_ROLES` is a genuine second list and earns it: it answers a different
 * question — which roles the *phone* has screens for — and is checked against
 * `UserRole` by `role-screens.test.ts`, which fails the build if a role has no
 * tab. That is a curated subset by design, so deriving it would defeat it.
 */
const ALLOWED_SECOND_LISTS = ['mobile/lib/api.ts'];

const clientFiles = [
  ...walk(path.join(ROOT, 'web'), /\.tsx?$/),
  ...walk(path.join(ROOT, 'mobile'), /\.tsx?$/),
].filter((f) => !f.includes(`${path.sep}.next${path.sep}`));

/** Three or more role names inside one array literal — a hand-written list. */
function looksLikeARoleList(source: string): boolean {
  const arrays = source.match(/\[[^[\]]*\]/gs) ?? [];
  return arrays.some((arr) => ROLES.filter((r) => arr.includes(`'${r}'`)).length >= 3);
}

describe('the role list is derived, not retyped', () => {
  it('finds the client files it is reading', () => {
    // Vacuous-pass guard. A silently empty walk would make this whole suite
    // green while checking nothing — which is how `access-matrix.spec.ts` sat
    // unrun for six phases.
    expect(clientFiles.length).toBeGreaterThan(40);
    expect(ROLES).toContain(UserRole.LAB_TECHNICIAN);
  });

  it('has exactly one source of truth per client', () => {
    for (const relative of SOURCES_OF_TRUTH) {
      const source = readFileSync(path.join(ROOT, relative), 'utf8');
      // A `Record<UserRole, …>` is what makes adding a role a compile error.
      expect(source).toMatch(/Record<UserRole, string>/);
      expect(source).toMatch(/export const ALL_ROLES/);
    }
  });

  it('lets no other client file write its own list', () => {
    const offenders = clientFiles
      .filter((f) => {
        const relative = path.relative(ROOT, f).split(path.sep).join('/');
        return (
          !SOURCES_OF_TRUTH.includes(relative) && !ALLOWED_SECOND_LISTS.includes(relative)
        );
      })
      .filter((f) => looksLikeARoleList(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

    /*
     * A hand-written list is not merely duplication. It is a list that will be
     * complete on the day it is written and silently wrong afterwards, and the
     * thing it breaks — a role nobody can be given — is invisible from the file
     * that contains it.
     */
    expect(offenders).toEqual([]);
  });

  it('names every role somewhere in each client', () => {
    /*
     * The other direction. A role in the enum that no client mentions at all is
     * one nobody can act as — which was true of LAB_TECHNICIAN in the places
     * that mattered even while it was mentioned in plenty of others.
     */
    const web = walk(path.join(ROOT, 'web/lib'), /\.tsx?$/)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const mobile = walk(path.join(ROOT, 'mobile/lib'), /\.tsx?$/)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    for (const role of ROLES) {
      expect(web).toContain(role);
      expect(mobile).toContain(role);
    }
  });
});
