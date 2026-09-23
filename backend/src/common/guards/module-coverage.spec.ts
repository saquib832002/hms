import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { TenantModule, UserRole } from '@prisma/client';
import { ALL_MODULES, assignableRoles, roleBlockedBy } from '../modules/tenant-modules';

/**
 * Every controller in a module's territory declares which module it is.
 *
 * WHY A TEST AND NOT JUST A GUARD
 * -------------------------------
 * `ModuleGuard` refuses writes for a module the tenant does not have — but only
 * if the controller says which module it belongs to. A controller with no
 * `@RequiresModule()` is not refused; it is *invisible* to the guard, and the
 * failure is a write that keeps working for a tenant that never bought the
 * feature, with nothing anywhere to say so.
 *
 * That is the same shape as `endpoint-coverage.spec.ts`: the guard cannot see
 * what it was never told about, so something has to check that it was told.
 *
 * The directory is the signal, deliberately. A controller under `src/lab/`
 * belongs to the laboratory whatever it is called, and somebody adding
 * `lab-reports.controller.ts` next month does not have to know this file
 * exists — it will fail on them.
 */

const SRC = path.resolve(__dirname, '../..');

/** Directory → the module every controller inside it belongs to. */
const MODULE_DIRECTORIES: Record<string, TenantModule> = {
  lab: TenantModule.LABORATORY,
  pharmacy: TenantModule.PHARMACY,
  medicines: TenantModule.PHARMACY,
  wards: TenantModule.WARDS,
  admissions: TenantModule.WARDS,
  vitals: TenantModule.WARDS,
  medications: TenantModule.WARDS,
  observations: TenantModule.WARDS,
  'ward-requests': TenantModule.WARDS,
  appointments: TenantModule.CLINIC,
  prescriptions: TenantModule.CLINIC,
  'medical-records': TenantModule.CLINIC,
  doctors: TenantModule.CLINIC,
  me: TenantModule.CLINIC,
  billing: TenantModule.BILLING,
};

/**
 * Directories that are the product rather than a part of it.
 *
 * Every tenant needs somebody to serve, somebody to serve them, and a record of
 * who did what. A "module" nobody can turn off is not a module — so these carry
 * no decorator and the test does not ask for one.
 *
 * `documents` is the interesting entry. It renders a prescription, an invoice
 * and a lab report from three different modules, and gating the controller on
 * any one of them would be wrong for the other two. It is left ungated because
 * printing is a read, and reads are never refused anyway.
 */
const ALWAYS_ON = [
  'auth',
  'patients',
  'users',
  'departments',
  'admin',
  'audit',
  'health',
  'notifications',
  'platform',
  'signup',
  'documents',
];

/**
 * Every controller, read once.
 *
 * Hoisted out of the test cases deliberately. `it.each` re-runs its body per
 * case, and reading thirty files sixteen times over made this suite take longer
 * than the whole rest of the guards directory — on a network-mounted checkout
 * it timed out entirely. The assertions are about text; the text does not
 * change between cases.
 */
const CONTROLLERS: { dir: string; relative: string; source: string }[] = readdirSync(SRC)
  .filter((entry) => statSync(path.join(SRC, entry)).isDirectory())
  .flatMap((dir) =>
    readdirSync(path.join(SRC, dir))
      .filter((f) => f.endsWith('.controller.ts'))
      .map((f) => ({
        dir,
        relative: `${dir}/${f}`,
        source: readFileSync(path.join(SRC, dir, f), 'utf8'),
      })),
  );

const controllersIn = (dir: string) => CONTROLLERS.filter((c) => c.dir === dir);

describe('every module controller declares its module', () => {
  it('finds the directories it is checking', () => {
    // Vacuous-pass guard: an empty walk would make every assertion below true
    // while checking nothing.
    const found = Object.keys(MODULE_DIRECTORIES).flatMap(controllersIn);
    expect(found.length).toBeGreaterThan(15);
    expect(CONTROLLERS.length).toBeGreaterThan(25);
  });

  it.each(Object.entries(MODULE_DIRECTORIES))(
    'src/%s is declared as %s',
    (dir, module) => {
      const missing = controllersIn(dir)
        .filter((c) => !c.source.includes(`@RequiresModule(TenantModule.${module})`))
        .map((c) => c.relative);

      expect(missing).toEqual([]);
    },
  );

  it('leaves the always-on directories undecorated', () => {
    /*
     * The other direction, and it matters as much. Gating patients or staff
     * accounts on a module would make a lab-only tenant unable to register the
     * person whose blood they are about to take — the feature working against
     * the customer it was built for.
     */
    const wrongly = ALWAYS_ON.flatMap(controllersIn)
      .filter((c) => c.source.includes('@RequiresModule'))
      .map((c) => c.relative);

    expect(wrongly).toEqual([]);
  });

  it('names every directory that exists', () => {
    /*
     * A new feature directory has to be classified, one way or the other. The
     * failure this prevents is the quiet one: somebody adds `src/theatres/`,
     * nobody adds it here, and its controllers are ungated forever while this
     * suite stays green.
     */
    const known = new Set([...Object.keys(MODULE_DIRECTORIES), ...ALWAYS_ON, 'common', 'prisma']);
    const unclassified = [...new Set(CONTROLLERS.map((c) => c.dir))].filter((d) => !known.has(d));

    expect(unclassified).toEqual([]);
  });
});

describe('the guard refuses the route, not just the write', () => {
  const guard = readFileSync(path.resolve(__dirname, 'module.guard.ts'), 'utf8');
  const subscription = readFileSync(
    path.resolve(__dirname, 'subscription.guard.ts'),
    'utf8',
  );

  it('does not let reads through on the method', () => {
    /*
     * THE ASSERTION THIS FILE EXISTS FOR, AND IT WAS THE OPPOSITE ONE.
     *
     * This guard originally copied `SubscriptionGuard` wholesale, including its
     * read pass-through, and the result was that a pharmacy-only tenant kept
     * every screen it had never bought: menus hidden by the client, records
     * reachable by URL, and the restriction real only in the UI. Reported from
     * use as "he can still see all those modules".
     *
     * A verb check here is what would bring that back, so its absence is
     * asserted rather than trusted — the same way `consultation-billing.spec.ts`
     * asserts the absence of a payment gate.
     */
    expect(guard).not.toMatch(/method === 'GET'/);
    expect(guard).not.toMatch(/request\.method/);
  });

  it('keeps the subscription guard letting reads through', () => {
    /*
     * The half of the rule that is NOT being reversed, pinned here because the
     * two guards look alike and the tempting tidy-up is to make them match.
     *
     * A lapsed subscription is automatic and about money, and the person it
     * would harm is a clinician who cannot open an allergy list rather than
     * whoever owes the invoice. A module is a deliberate commercial decision
     * taken by a human looking at a count of what it hides. Only one of those
     * may take a record away.
     */
    expect(subscription).toMatch(/method === 'GET'/);
    expect(subscription).toMatch(/HEAD/);
    expect(subscription).toMatch(/OPTIONS/);
  });

  it('refuses on the module rather than a list of routes', () => {
    // A route list rots: the first endpoint somebody forgets is one that keeps
    // working for a tenant that never bought the feature.
    expect(guard).not.toMatch(/const (ROUTES|PATHS|BLOCKED)/);
    expect(guard).toMatch(/hasModule\(/);
  });

  it('never blocks the vendor from granting a module', () => {
    // Otherwise the only way out of a wrongly-removed module is a database
    // console — the deadlock the subscription guard already had to avoid, and
    // it matters more now that removal hides things.
    expect(guard).toMatch(/IS_PLATFORM_ROUTE_KEY/);
  });

  it('names the module in its refusal', () => {
    // A receptionist reading "Forbidden" cannot tell a bug from a plan, and
    // has no idea whom to telephone. More important now that the refusal is
    // the first thing they meet rather than something they hit on save.
    expect(guard).toMatch(/moduleRefusal\(required\)/);
  });
});

describe('roles follow the modules', () => {
  it('withholds a role whose module the tenant lacks', () => {
    /*
     * The mirror of the bug this project has already had: a role that existed
     * everywhere except where it could be granted, and a doctor's lab order
     * visible to nobody. Here it would be an account created, able to sign in,
     * and met with a menu of nothing.
     */
    const labOnly = [TenantModule.LABORATORY];
    expect(assignableRoles(labOnly)).toContain(UserRole.LAB_TECHNICIAN);
    expect(assignableRoles(labOnly)).not.toContain(UserRole.DOCTOR);
    expect(assignableRoles(labOnly)).not.toContain(UserRole.NURSE);
    expect(assignableRoles(labOnly)).not.toContain(UserRole.PHARMACIST);
  });

  it('always allows an administrator, and only an administrator', () => {
    /*
     * ADMIN is the only always-on role, and it has to be: a tenant nobody can
     * administer needs the vendor for every staff change.
     *
     * RECEPTIONIST was beside it and is not any more. It read as obvious —
     * every business has somebody at the door — and it was the wrong noun:
     * reception in this product is the appointment book, the check-in queue
     * and the doctors list, which is the clinic. At a standalone pharmacy the
     * person at the counter is the pharmacist, and the role produced an
     * account whose whole app was the patient list.
     */
    expect(assignableRoles([])).toEqual([UserRole.ADMIN]);
    expect(roleBlockedBy(UserRole.ADMIN)).toBeNull();
    expect(roleBlockedBy(UserRole.RECEPTIONIST)).toBe(TenantModule.CLINIC);
  });

  it('gives a pharmacy-only tenant exactly two roles', () => {
    // The case that was reported: everything else must be absent, not merely
    // refused on save.
    expect(assignableRoles([TenantModule.PHARMACY]).sort()).toEqual(
      [UserRole.ADMIN, UserRole.PHARMACIST].sort(),
    );
  });

  it('gives a full hospital every role', () => {
    expect(assignableRoles(ALL_MODULES).sort()).toEqual(Object.values(UserRole).sort());
  });

  it('classifies every role', () => {
    /*
     * Not "every role has a module" — two deliberately do not. This asserts
     * that each one has been *considered*, which is what `roleBlockedBy`
     * returning a module or an explicit null means.
     */
    for (const role of Object.values(UserRole)) {
      const blocking = roleBlockedBy(role);
      expect(blocking === null || ALL_MODULES.includes(blocking)).toBe(true);
    }
  });
});

describe('a module can actually be granted', () => {
  /*
   * THE BUG THIS EXISTS FOR, AND IT HAS NOW HAPPENED SIX TIMES
   * ----------------------------------------------------------
   * `acceptsExternalLabOrders` shipped as a column the partner lookup read and
   * no screen could write, so every attempt to add a partner laboratory was
   * refused — correctly, unexplainably, and with no way to clear it from
   * anywhere in the product. Before that: seed-only wards, a seed-only medicine
   * catalogue, doctor profiles creatable only as a side effect of a new
   * account, drug-chart items the parser refused to schedule and no screen
   * could set.
   *
   * `settings-reachable.spec.ts` closed that family for a *hospital's* own
   * settings. Modules are the same shape one level up: a field only the vendor
   * can change, whose absence would present as a customer who cannot be sold
   * the laboratory, with a console that looks complete.
   *
   * The signal is the same one that test settled on after three attempts —
   * a screen that *sends* the field, not merely one that reads it. Reading a
   * setting and being able to change it are different capabilities, and a test
   * that conflates them would sign off a console that lists what a hospital has
   * and can never alter it.
   */
  const console = readFileSync(
    path.resolve(SRC, '../../web/app/(platform)/platform/page.tsx'),
    'utf8',
  );

  it('finds the vendor console', () => {
    // Vacuous-pass guard: a moved file would make every assertion below true.
    expect(console).toContain('platformApi');
  });

  it('sends the complete set to the modules route', () => {
    expect(console).toMatch(/tenants\/\$\{tenant\.id\}\/modules/);
    expect(console).toMatch(/method: 'PATCH'[^}]*modules: chosen/s);
  });

  it('chooses them when a hospital is onboarded, both ways', () => {
    // Approval and direct creation. A module set only after the fact means a
    // lab-only customer spends their first hour in a product that offers to
    // book appointments and admit patients.
    expect(console).toMatch(/applications\/\$\{a\.id\}\/approve/);
    expect(console).toMatch(/body: \{ modules:/);
    expect(console).toMatch(/trialDays:[^}]*modules,/s);
  });

  it('says what removing one does, where it is done', () => {
    /*
     * "Remove the laboratory" reads as destructive and is not — the guard
     * refuses writes and never a read. A vendor who believes it deletes
     * records will refuse to do a safe thing, and the customer stays on a
     * product they are not paying for.
     */
    expect(console).toMatch(/read access|read-only/);
    expect(console).toContain('strandedRecords');
  });
});

describe('the three copies of the role-to-module map agree', () => {
  /*
   * `ROLE_REQUIRES` exists in `backend/src/common/modules/tenant-modules.ts`,
   * `web/lib/nav.ts` and `mobile/lib/nav.ts`. Metro resolves no shared package
   * without config nobody has run on a device — the constraint that already
   * duplicates `types.ts` and `course-quantity.ts`.
   *
   * What must not happen is a role that one client offers, another hides, and
   * the server refuses. That is worse than any of the three being wrong alone,
   * because the person who has to explain it is an administrator who did
   * nothing but click the same button on a different device.
   *
   * RECEPTIONIST is why this test exists: it was always-on in all three, moved
   * to CLINIC in the backend first, and for a few minutes a pharmacy-only
   * tenant's web picker offered a role the API would refuse.
   */
  const ROOT = path.resolve(SRC, '../..');

  const pairs = (source: string) => {
    const block = /const ROLE_REQUIRES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
    if (!block) return null;
    return [...block[1].matchAll(/^\s*(\w+):\s*(?:TenantModule\.)?'?(\w+)'?,/gm)]
      .map(([, role, module]) => `${role}=${module}`)
      .sort();
  };

  const backend = pairs(
    readFileSync(path.join(SRC, 'common/modules/tenant-modules.ts'), 'utf8'),
  );
  const web = pairs(readFileSync(path.join(ROOT, 'web/lib/nav.ts'), 'utf8'));
  const mobile = pairs(readFileSync(path.join(ROOT, 'mobile/lib/nav.ts'), 'utf8'));

  it('finds all three', () => {
    // Vacuous-pass guard: a renamed constant would make the comparison below
    // compare two nulls and pass.
    expect(backend).not.toBeNull();
    expect(web).not.toBeNull();
    expect(mobile).not.toBeNull();
    expect(backend!.length).toBeGreaterThan(4);
  });

  it('maps the same roles to the same modules', () => {
    expect(web).toEqual(backend);
    expect(mobile).toEqual(backend);
  });

  it('leaves the administrator ungated in all three', () => {
    // Somebody must be able to administer the hospital whatever it was sold.
    // A tenant whose only ADMIN cannot be replaced needs the vendor for every
    // staff change.
    for (const copy of [backend, web, mobile]) {
      expect(copy!.some((entry) => entry.startsWith('ADMIN='))).toBe(false);
    }
  });
});

describe('the server refuses a role it was not sold', () => {
  /*
   * The narrowing was client-only when it shipped: `assignableRoles` existed in
   * the backend with no caller at all, so both pickers were narrowed and
   * `POST /users` accepted anything. An account created that way signs in
   * successfully and meets a menu of nothing.
   *
   * Same shape as every other rule in this project that lived in a comment and
   * a client — the API is the boundary and assumes any client can call any
   * endpoint.
   */
  const service = readFileSync(path.resolve(SRC, 'users/users.service.ts'), 'utf8');

  it('checks on create and on assignment, from the actor', () => {
    expect(service).toMatch(/refuseUnsoldRoles\(\[dto\.role\], actor\)/);
    expect(service).toMatch(/refuseUnsoldRoles\(/g);
    expect(service).toMatch(/assignableRoles\(actor\.hospital\.modules\)/);
  });

  it('does not strip a role somebody already holds', () => {
    /*
     * Only newly granted roles are checked. A commercial change at the vendor
     * must not silently take a role off a member of staff mid-shift — that is a
     * bigger act than refusing to hand out a new one, and it is not one this
     * endpoint should perform as a side effect.
     */
    expect(service).toMatch(/next\.filter\(\(role\) => !current\.includes\(role\)\)/);
  });
});
