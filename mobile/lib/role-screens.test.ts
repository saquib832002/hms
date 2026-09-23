import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every role can use this app, and every role has somewhere to land.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Reception and billing were refused at mobile login for six phases. The
 * justification written above the check claimed the backend "would refuse every
 * clinical call anyway" — which was false; reception has its own endpoints and
 * always did. The real reason was that nobody had built reception screens, and
 * the absence had been written up as though it were a design decision.
 *
 * That is the failure this guards against: not a wrong function, but a gap
 * that acquires a rationale and stops being visible. A role added to `UserRole`
 * tomorrow will fail here rather than quietly getting a working login and an
 * empty tab bar.
 */

/*
 * Source is read as text rather than imported, matching `types.drift.test.ts`
 * and `secure-session.test.ts`. Importing `api.ts` would pull in
 * `expo-constants`, which is an ES module Jest cannot transform here — and a
 * safety test that needs the native runtime to be present is a test that stops
 * being run.
 */
const TYPES = readFileSync(resolve(__dirname, './types.ts'), 'utf8');
const API = readFileSync(resolve(__dirname, './api.ts'), 'utf8');
const TABS_LAYOUT = readFileSync(resolve(__dirname, '../app/(tabs)/_layout.tsx'), 'utf8');

/** Roles straight from the shared type, so the enum is the source of truth. */
function declaredRoles(): string[] {
  const block = /export type UserRole =([\s\S]*?);/.exec(TYPES);
  if (!block) throw new Error('UserRole not found in types.ts');
  return [...block[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

/** The roles the app admits, parsed out of the declaration in api.ts. */
function admittedRoles(): string[] {
  const block = /export const MOBILE_ROLES: UserRole\[\] = \[([\s\S]*?)\];/.exec(API);
  if (!block) throw new Error('MOBILE_ROLES not found in api.ts');
  return [...block[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

describe('every role can use the mobile app', () => {
  const roles = declaredRoles();

  const admitted = admittedRoles();

  it('reads the roles from the shared type', () => {
    // Guards the assertions below from passing vacuously if either regex breaks.
    expect(roles.length).toBeGreaterThanOrEqual(6);
    expect(roles).toContain('RECEPTIONIST');
    expect(roles).toContain('BILLING_STAFF');
    expect(admitted.length).toBeGreaterThanOrEqual(6);
  });

  it('admits every declared role at login', () => {
    /*
     * The one that would have caught the original problem. Excluding a role
     * from the app is a product decision with real consequences for a clinic
     * where the receptionist has a phone and no desktop — it should not be
     * possible to make it by omission.
     */
    const excluded = roles.filter((r) => !admitted.includes(r));
    expect(excluded).toEqual([]);
  });

  it('gives every role at least one tab of its own', () => {
    // Admitting a role without building it screens is the same bug wearing a
    // different hat: a successful login into an empty app.
    const gates: Record<string, RegExp> = {
      DOCTOR: /isDoctor/,
      NURSE: /isNurse/,
      PHARMACIST: /isPharmacist/,
      ADMIN: /isAdmin/,
      RECEPTIONIST: /isReception/,
      BILLING_STAFF: /isBilling/,
      LAB_TECHNICIAN: /isLabTech/,
    };

    const missing = roles.filter((r) => !gates[r] || !gates[r].test(TABS_LAYOUT));
    expect(missing).toEqual([]);
  });

  it('lands every role on a screen it can actually see', () => {
    /*
     * The bug this was written for, found on the first device run.
     *
     * Expo Router opens the tab group on `index` — the doctor's queue — so
     * every other role landed there and was met with "The patient queue belongs
     * to doctors" as the first screen after signing in. It had been true for
     * nurses and pharmacists since Phase 2 and was invisible until someone held
     * a phone, because no test can see a router default.
     *
     * Asserting the landing route resolves to a tab the role's bar actually
     * shows is the part that would have caught it.
     */
    const NAV = readFileSync(resolve(__dirname, './nav.ts'), 'utf8');
    const landing = /export const LANDING: Record<UserRole, string> = \{([\s\S]*?)\};/.exec(NAV);
    expect(landing).not.toBeNull();

    const routes = Object.fromEntries(
      [...landing![1].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
    );

    // Every role has a landing route...
    expect(roles.filter((r) => !routes[r])).toEqual([]);

    // ...and it points at a screen file that exists.
    const screenFor = (route: string) => route.replace('/(tabs)', '').replace(/^\//, '') || 'index';
    const missing = roles.filter((r) => {
      const screen = screenFor(routes[r]);
      return !new RegExp(`name="${screen}"`).test(TABS_LAYOUT);
    });
    expect(missing).toEqual([]);
  });

  it('does not ask for a doctor endpoint before it redirects a non-doctor', () => {
    /*
     * The redirect above sends every other role to its own screen, and it looks
     * like that is the end of it. It is not: hooks run before a component
     * returns anything, so `useDoctorQueue` had already fired `GET /me/queue`
     * by the time `<Redirect>` was evaluated. Signing in as reception, pharmacy
     * or admin produced a 403 and a **denied clinical access** row in that
     * hospital's audit log — an access refusal the app manufactured for
     * somebody who had done nothing but log in.
     *
     * The API refusing was right. The app asking was the bug, and it is the
     * kind that reads as fixed: the redirect is there, the wrong screen never
     * appears, and the only evidence is a line in a log nobody watches.
     *
     * No position in the component is earlier than its own hooks, so the fetch
     * has to be told not to happen.
     */
    const QUEUE_SCREEN = readFileSync(resolve(__dirname, '../app/(tabs)/index.tsx'), 'utf8');
    const HOOK = readFileSync(resolve(__dirname, './use-queue.ts'), 'utf8');

    // The screen passes a role check in, rather than calling it unconditionally.
    expect(QUEUE_SCREEN).toMatch(/useDoctorQueue\(\s*isDoctor\s*\)/);
    expect(QUEUE_SCREEN).toMatch(/const isDoctor = user\?\.role === 'DOCTOR'/);

    // And the hook honours it in both places it can fire: on mount, and on
    // every poll and focus through `useLiveData`.
    expect(HOOK).toMatch(/if \(enabled\) void refresh\(\)/);
    expect(HOOK).toMatch(/if \(!enabledRef\.current\) return/);
  });

  it('offers the role switcher from the shared header, not one buried screen', () => {
    /*
     * A capability nobody can find is indistinguishable from one that was never
     * built.
     *
     * Switching roles was implemented, tested and working — inside a card on
     * the Account tab, behind a menu item labelled "Me". An owner-doctor signed
     * in, saw the queue, and reported that the app had no way to switch roles.
     * They were right in every sense that matters. The web app never had this
     * problem because its switcher sits in the sidebar, on screen all day.
     *
     * So the assertion is about *placement*: the switcher must be rendered by
     * `AppHeader`, which every screen uses, rather than by any single screen.
     */
    const UI = readFileSync(resolve(__dirname, '../components/ui.tsx'), 'utf8');

    expect(UI).toContain('export function RoleSwitcher()');

    // Rendered from inside AppHeader itself — not merely exported for a screen
    // to remember to include, which is the arrangement that just failed.
    const header = UI.slice(UI.indexOf('export function AppHeader('), UI.indexOf('export function RoleSwitcher('));
    expect(header).toContain('<RoleSwitcher />');

    /*
     * And switching must navigate. A doctor who becomes a pharmacist while
     * standing on the queue is on a screen that calls `GET /me/queue` — a route
     * their new role cannot have. Leaving them there manufactures a denied
     * clinical access in the hospital's own audit log, which is the same
     * self-inflicted denial the web `?next=` bug caused.
     */
    expect(UI).toMatch(/router\.replace\(landingFor\(role\)\)/);
  });

  it('tells every role what it can actually do here', () => {
    /*
     * The Account tab used to say "Appointment booking, patient registration,
     * billing and full history review are web-only". By the time anyone read it
     * again, three of those four had shipped on mobile.
     *
     * Stale copy describing a limitation that no longer exists is worse than no
     * copy: it is the app telling its own users not to look for a feature that
     * is one tap away. It is the same failure as the comment that justified
     * locking reception out of mobile for six phases — an absence that acquired
     * a rationale and stopped being visible.
     *
     * A test cannot judge whether prose is accurate. It can insist that every
     * role has an entry, so a role added tomorrow cannot ship with a blank
     * list, and it can refuse the specific claims that are now false.
     */
    const ME = readFileSync(resolve(__dirname, '../app/(tabs)/me.tsx'), 'utf8');

    const block = /const CAN_DO: Record<UserRole, string\[\]> = \{([\s\S]*?)\n\};/.exec(ME);
    expect(block).not.toBeNull();

    const covered = [...block![1].matchAll(/^ {2}([A-Z_]+):/gm)].map((m) => m[1]);
    expect(roles.filter((r) => !covered.includes(r))).toEqual([]);

    /*
     * Each role's list must have something in it. An empty array satisfies the
     * type and says nothing, which is how this went wrong the first time.
     *
     * Collected into a list rather than asserted in a loop, so a failure names
     * every role that is wrong instead of only the first.
     */
    const empty = roles.filter((role) => {
      const entry = new RegExp(`${role}: \\[([\\s\\S]*?)\\]`).exec(block![1]);
      return !entry || entry[1].trim().length === 0;
    });
    expect(empty).toEqual([]);

    /*
     * The specific claims that were false. All three ship on mobile now.
     *
     * Comments are stripped first, because the doc comment above `CAN_DO`
     * quotes the old wording verbatim in order to explain why it was wrong.
     * Matching against it would fail the build for describing the bug, and the
     * obvious fix — softening the comment — makes the file worse to make the
     * test pass. Same reason `reports.spec.ts` strips them.
     */
    const prose = ME.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const gone of [
      /booking[^.]*web-only/i,
      /registration[^.]*web-only/i,
      /billing[^.]*web-only/i,
    ]) {
      expect(prose).not.toMatch(gone);
    }
  });

  it('keeps the Account tab reachable to the bottom', () => {
    /*
     * Sign out sat below the fold on a plain `View`, with no way to scroll to
     * it. On a shared clinical device that is not cosmetic: sign-out is the
     * control that wipes the cached queue — patient names, ages, an allergy
     * flag — and any queued bedside writes off a phone being handed over.
     */
    const ME = readFileSync(resolve(__dirname, '../app/(tabs)/me.tsx'), 'utf8');
    expect(ME).toContain('<ScrollView');
    expect(ME).toMatch(/label="Sign out"/);
  });

  it('does not let one failed fetch hide the admin’s other screens', () => {
    /*
     * The bug this exists for, reported as "the daily activity page is missing
     * from the app".
     *
     * The admin Overview fetched three endpoints with `Promise.all` and
     * rendered everything inside `{dashboard && …}` — including the links to
     * Daily activity, Clinic settings and Staff roles. So when two newer
     * report endpoints 404'd against a backend that had not been restarted,
     * the whole tab went blank and the screens that *were* working became
     * unreachable. The feature looked unbuilt rather than unreached, which is
     * exactly how it was reported, twice.
     *
     * Two properties fix it and both are asserted: panels settle independently,
     * and navigation does not depend on data.
     */
    const OVERVIEW = readFileSync(resolve(__dirname, '../app/(tabs)/overview.tsx'), 'utf8');

    // A screen of independent panels degrades one panel at a time.
    expect(OVERVIEW).toContain('Promise.allSettled');
    expect(OVERVIEW).not.toMatch(/Promise\.all\(/);

    /*
     * And the links sit after the data block closes. Position is the property
     * that actually matters here — a link declared inside the guard is a link
     * that disappears with the figures.
     */
    const guard = OVERVIEW.indexOf('{dashboard && (');
    const guardEnd = OVERVIEW.indexOf('</>\n        )}', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guard);

    for (const route of ['/reports/activity', '/settings/clinic', '/settings/staff']) {
      const at = OVERVIEW.indexOf(route);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(guardEnd);
    }
  });

  it('keeps the tab bar on screen whatever the app is doing', () => {
    /*
     * Reported from use: writing a prescription left one button on an
     * otherwise bare screen, with no tab bar and no way back to the queue.
     *
     * Two separate causes, and both had to go.
     *
     * The screens lived in the ROOT stack, beside the tab navigator rather than
     * inside it, so opening a patient replaced the bar entirely. Moving them
     * under `(tabs)` with `href: null` keeps them out of the bar and out of
     * deep linking while leaving them part of the navigator — the same
     * mechanism the role gating uses.
     *
     * And the prescription sheet was a `Modal`, which renders in its own native
     * window above everything the navigator draws. Even inside the tabs it
     * would have covered the bar.
     */
    const ROOT = readFileSync(resolve(__dirname, '../app/_layout.tsx'), 'utf8');
    const TABS = readFileSync(resolve(__dirname, '../app/(tabs)/_layout.tsx'), 'utf8');
    const SHEET = readFileSync(resolve(__dirname, '../components/prescription-sheet.tsx'), 'utf8');

    // The root stack holds the tab group and nothing else. A screen added
    // beside it is a screen with no tab bar.
    const rootScreens = [...ROOT.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map((m) => m[1]);
    expect(rootScreens).toEqual(['(tabs)']);

    // Every pushed screen is registered in the tabs navigator instead.
    for (const name of [
      'patient/new',
      'patient/[id]',
      'appointment/new',
      'appointment/[id]',
      'settings/clinic',
      'settings/staff',
      'reports/activity',
      // `stock` was here and is now a visible pharmacist tab instead — see the
      // assertion below. Dispensing took its place as a pushed screen.
      'dispense/[id]',
    ]) {
      expect(TABS).toContain(`'${name}'`);
    }

    // …and each carries a back control, because Tabs adds none and these would
    // otherwise be screens you can only leave by gesture.
    expect(TABS).toContain('headerLeft');
    expect(TABS).toContain('router.back()');

    // The prescription sheet draws inside the screen, not in a native window
    // over it.
    expect(SHEET).not.toMatch(/<Modal[\s>]/);
    expect(SHEET).toContain('absoluteFillObject');
  });

  it('gives the pharmacist a queue and a stock tab, and a way to dispense', () => {
    /*
     * Reported from use: the pharmacy tab held the dispensing queue and the
     * stock summary on one screen, and ended with a line saying dispensing
     * happens on the web app.
     *
     * Two faults, and the second is the one worth a test. Mixing the two lists
     * is a readability problem. A queue that lists work and then refuses it is
     * a screen whose only function is to send you elsewhere — and it violates
     * the rule that a feature is built on both clients or on neither.
     *
     * So: stock is its own tab rather than half of another, and the queue rows
     * navigate somewhere. The navigation assertion is the load-bearing half —
     * a route registered with no caller is exactly how the dispense screen
     * could exist and still be unreachable.
     */
    const PHARMACY = readFileSync(resolve(__dirname, '../app/(tabs)/pharmacy.tsx'), 'utf8');
    // Comments stripped before asserting on absence: the file explains why the
    // old wording went, which means it quotes it. Third time this trap has been
    // hit in this repo — a test that reads a file must read the code, not the
    // prose about the code.
    const CODE = PHARMACY.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    /*
     * Comments stripped from the layout too, and this one caught itself: the
     * note beside the stock tab explains that `href: null` also closes deep
     * linking, so the regex below matched the word "null" inside the prose and
     * reported the tab as hidden. Same trap as the pharmacy screen above.
     */
    const TABS_CODE = TABS_LAYOUT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Stock is gated to the pharmacist like any other role tab, not hidden.
    const stockTab = /name="stock"[\s\S]{0,300}?href:\s*(\w+)/.exec(TABS_CODE);
    expect(stockTab).not.toBeNull();
    expect(stockTab![1]).toBe('isPharmacist');

    // The queue no longer carries the inventory, and no longer apologises for
    // itself. Both strings are the shape the old screen had.
    expect(CODE).not.toContain('/pharmacy/inventory');
    expect(CODE).not.toMatch(/web app/i);

    // And a row opens the dispense screen.
    expect(CODE).toContain('/dispense/');

    /*
     * Selling and taking the money are tabs of their own.
     *
     * The pharmacy bills for what it hands over, and in SEPARATE mode it is a
     * different business with its own till — so "sell" and "till" are not
     * conveniences bolted onto the dispensing screen, they are the two halves
     * of the pharmacy that were missing entirely.
     */
    for (const tab of ['sell', 'till']) {
      const match = new RegExp(`name="${tab}"[\\s\\S]{0,300}?href:\\s*(\\w+)`).exec(TABS_CODE);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('isPharmacist');
    }
  });

  it('keeps reception and billing out of the clinical tabs', () => {
    /*
     * Opening the app to every role must not widen what any role sees. The
     * ward board, medication round and vitals name patients and their
     * treatment; reception is withheld allergies and diagnoses by
     * `toPatientResponse` and has no business on those screens.
     *
     * The API is the real boundary — this only asserts the navigation agrees
     * with it, the same claim the web sidebar makes.
     */
    for (const clinical of ['ward', 'vitals', 'meds', 'pharmacy']) {
      const screen = new RegExp(`name="${clinical}"[\\s\\S]{0,200}?href:`, 'm').exec(TABS_LAYOUT);
      expect(screen).not.toBeNull();
      expect(screen?.[0]).not.toMatch(/isReception|isBilling/);
    }
  });
});
