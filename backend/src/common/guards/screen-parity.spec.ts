import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The two clients must offer each role the same destinations.
 *
 * WHAT THIS CHECKS THAT NOTHING ELSE DOES
 * ---------------------------------------
 * `endpoint-coverage.spec.ts` compares which *API routes* each client calls,
 * and that is genuinely useful — it found `POST /appointments/:id/invoice`
 * shipping to the phone and not the desk. But it is blind to the failure
 * reported here, because it asks whether a route has a caller anywhere in a
 * client, not whether a *role* can reach it.
 *
 * A doctor on the phone had Queue and Requests and nothing else: no patient
 * list, no way to open a record, no results. Every one of those endpoints was
 * called *somewhere* in the mobile app — `GET /patients` by reception's lookup,
 * `GET /patients/:id/lab-orders` by the patient screen — so coverage was green
 * the whole time. What was missing was a tab, and no test in this repo could
 * see a missing tab.
 *
 * Found by the product owner, not by the suite. Again.
 *
 * HOW IT COMPARES
 * ---------------
 * The web nav table is the specification, because it is the one that is
 * complete. For each role, every web destination must map to a mobile route —
 * either a tab in `(tabs)/_layout.tsx` or an explicitly recorded equivalent
 * where the same job is done by a different screen.
 *
 * `KNOWN_GAPS` holds what is genuinely still missing, exactly as
 * `endpoint-coverage.spec.ts` keeps `PARITY_GAPS` apart from its deliberate
 * single-client lists. The build stays green and the list stays visible, and it
 * has to shrink — a gap removed from the list without the screen being built
 * fails immediately.
 */

const SRC = path.resolve(__dirname, '../..');
const REPO = path.resolve(SRC, '../..');

const WEB_NAV = readFileSync(path.join(REPO, 'web/lib/nav.ts'), 'utf8');
const TABS = readFileSync(path.join(REPO, 'mobile/app/(tabs)/_layout.tsx'), 'utf8');

/* ── the web's menu, role by role ────────────────────────────────────────── */

function webNav(): Record<string, string[]> {
  const table = WEB_NAV.slice(
    WEB_NAV.indexOf('const NAV'),
    WEB_NAV.indexOf('export function navFor'),
  );
  const out: Record<string, string[]> = {};

  for (const block of table.matchAll(/^ {2}(\w+): \[([\s\S]*?)^ {2}\],/gm)) {
    const [, role, body] = block;
    out[role] = [...body.matchAll(/\{[^{}]*href: '([^']*)'[^{}]*\}/g)].map((m) => m[1]);
  }
  return out;
}

/* ── the phone's tabs, and which roles see them ──────────────────────────── */

/**
 * The guard expression on a tab's `href` names the roles that see it.
 *
 * Read out of the layout rather than listed here, so a tab that changes hands
 * is picked up without anybody remembering this file — the same reason
 * `module-coverage.spec.ts` keys on the directory.
 */
const FLAG_ROLES: Record<string, string[]> = {
  isDoctor: ['DOCTOR'],
  isWardPrescriber: ['DOCTOR'],
  isNurse: ['NURSE'],
  isPharmacist: ['PHARMACIST'],
  isWardPharmacist: ['PHARMACIST'],
  isReception: ['RECEPTIONIST'],
  isBilling: ['BILLING_STAFF'],
  isLabTech: ['LAB_TECHNICIAN'],
  canSeeSchedule: ['DOCTOR', 'NURSE', 'RECEPTIONIST'],
  isAdmin: ['ADMIN'],
  canSeePatients: ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTIONIST', 'BILLING_STAFF', 'ADMIN'],
  canSeeCatalogue: ['LAB_TECHNICIAN', 'ADMIN'],
};

function mobileTabs(): Record<string, string[]> {
  const out: Record<string, string[]> = {};

  for (const screen of TABS.matchAll(/<Tabs\.Screen\s+name="([^"]+)"([\s\S]*?)\/>/g)) {
    const [, name, body] = screen;
    if (/href:\s*null\s*[,}]/.test(body)) continue; // never in any bar

    const guard = /href:\s*([A-Za-z0-9_]+)\s*\?/.exec(body);
    // No guard at all means every role gets it — Alerts and Me.
    const roles = guard ? (FLAG_ROLES[guard[1]] ?? []) : Object.keys(ROLE_TABS_EXPECTED);
    for (const role of roles) (out[role] ??= []).push(name);
  }
  return out;
}

/* ── how a web screen maps onto the phone ────────────────────────────────── */

/**
 * Web href → the mobile tab that does the same job.
 *
 * Not always the same name, and the differences are real rather than cosmetic:
 * the web splits dispensing across a queue and an inventory screen where the
 * phone splits it differently, and reception's check-in queue is the phone's
 * schedule.
 */
const EQUIVALENT: Record<string, string> = {
  '/queue': 'index',
  '/requests': 'requests',
  '/patients': 'patients',
  '/ward': 'ward',
  '/vitals': 'vitals',
  '/medications': 'meds',
  '/check-in': 'schedule',
  '/appointments': 'schedule',
  '/pharmacy/queue': 'pharmacy',
  '/pharmacy/sell': 'sell',
  '/pharmacy/referrals': 'incoming',
  '/pharmacy/invoices': 'till',
  '/pharmacy/supply': 'supply',
  '/pharmacy/inventory': 'stock',
  '/billing/invoices': 'invoices',
  '/billing/payments': 'payments',
  '/lab/worklist': 'lab',
  '/lab/referrals': 'lab-incoming',
  '/lab/invoices': 'lab-till',
  '/lab/catalogue': 'lab-catalogue',
  '/admin': 'overview',
  // Everything an administrator reaches that will not fit in a tab bar.
  '/admin/departments': 'more',
  '/audit': 'more',
  '/admin/activity': 'more',
  '/admin/users': 'more',
  '/admin/settings': 'more',
  '/admin/lab-partners': 'more',
  '/admin/lab-tests': 'lab-catalogue',
  /*
   * Its own screen on the phone, reached from the More hub rather than given a
   * tab — a tab bar holds five before the labels stop being readable, and this
   * is something opened when a laboratory rings rather than lived in.
   */
  '/lab-charges': 'more',
};

/**
 * Web destinations with no mobile equivalent yet, and why.
 *
 * This list is the backlog, not a set of decisions — that distinction is the
 * one `endpoint-coverage.spec.ts` learned the hard way when a single list
 * holding both meant real holes vanished into "fine, ignore these". Every entry
 * here is something the product owner has asked for and nobody has built.
 */
const KNOWN_GAPS: Record<string, string> = {
  'DOCTOR /lab/results':
    'Reachable through Patients → record → investigations; the web also has a search-first screen.',
  'RECEPTIONIST /patients/new': 'Reachable from the Patients tab’s Register button.',
  'RECEPTIONIST /doctors': 'No doctors list on the phone.',
  'PHARMACIST /pharmacy/dashboard': 'Today’s figures are on the admin overview only.',
  'ADMIN /admin/reports': 'Mobile admin shows the overview; the full reports are web.',
  'ADMIN /admin/wards': 'Ward and bed setup is a one-off done at a desk.',
  'ADMIN /admin/letterhead': 'Logo upload and letterhead are web-only.',
  'ADMIN /admin/partners': 'Partner pharmacies are web-only.',
  'ADMIN /admin/tax': 'Tax configuration is an accounting task done once, with figures to hand.',
  'ADMIN /doctors': 'Consultation fees are editable from the overview’s doctors card.',
  'ADMIN /appointments': 'No appointment list on the phone.',
};

/** Roles the phone has an app for at all. */
const ROLE_TABS_EXPECTED: Record<string, true> = {
  DOCTOR: true,
  NURSE: true,
  PHARMACIST: true,
  RECEPTIONIST: true,
  BILLING_STAFF: true,
  LAB_TECHNICIAN: true,
  ADMIN: true,
};

const WEB = webNav();
const MOBILE = mobileTabs();

describe('the two clients offer each role the same screens', () => {
  it('reads both navigation tables', () => {
    // Vacuous-pass guard. An empty parse on either side makes every comparison
    // below true while checking nothing — which is how a menu and a guard
    // silently disagreed for six phases.
    expect(Object.keys(WEB).length).toBe(7);
    expect(Object.keys(MOBILE).length).toBeGreaterThanOrEqual(7);
    expect(MOBILE.DOCTOR?.length ?? 0).toBeGreaterThan(2);
  });

  it('gives every role a patient list on both, or on neither', () => {
    /*
     * THE ONE THIS FILE WAS WRITTEN FOR.
     *
     * A doctor on the phone could not reach a patient at all: no list, and the
     * record only openable from today's queue. So a ward round, a telephone
     * call and a repeat prescription were all dead ends, while the web gave the
     * same role a Patients item from the beginning.
     */
    for (const role of ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTIONIST', 'BILLING_STAFF']) {
      expect(WEB[role]).toContain('/patients');
      expect(MOBILE[role] ?? []).toContain('patients');
    }
  });

  it('opens the patient record from the list, for every role that has it', () => {
    /*
     * The list existed and led nowhere but registration and booking — both
     * reception's. Adding the tab for other roles without this would have given
     * a doctor a search box over a record they still could not open.
     */
    const screen = readFileSync(path.join(REPO, 'mobile/app/(tabs)/patients.tsx'), 'utf8');
    expect(screen).toMatch(/router\.push\(`\/patient\/\$\{item\.id\}`\)/);
  });

  it('has a mobile destination for every web screen, or a written gap', () => {
    const missing: string[] = [];

    for (const [role, hrefs] of Object.entries(WEB)) {
      for (const href of hrefs) {
        const key = `${role} ${href}`;
        if (key in KNOWN_GAPS) continue;

        const tab = EQUIVALENT[href];
        if (!tab) {
          missing.push(`${key} — no equivalent recorded`);
        } else if (!(MOBILE[role] ?? []).includes(tab)) {
          missing.push(`${key} — mobile tab "${tab}" not offered to ${role}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('carries no stale gap', () => {
    /*
     * A gap that has been closed must leave the list, or the list rots into
     * claims nobody rechecks — the failure that let three false reasons sit in
     * `endpoint-coverage.spec.ts` looking like decisions somebody had made.
     */
    const stale = Object.keys(KNOWN_GAPS).filter((key) => {
      const [role, href] = key.split(' ');
      const tab = EQUIVALENT[href];
      return tab !== undefined && (MOBILE[role] ?? []).includes(tab);
    });

    expect(stale).toEqual([]);
  });

  it('names a real role and a real screen in every gap', () => {
    for (const key of Object.keys(KNOWN_GAPS)) {
      const [role, href] = key.split(' ');
      expect(ROLE_TABS_EXPECTED[role]).toBe(true);
      expect(WEB[role] ?? []).toContain(href);
      expect(KNOWN_GAPS[key].length).toBeGreaterThan(25);
    }
  });
});

/**
 * Equivalent screens must offer the same writes.
 *
 * A TAB IS NOT THE UNIT EITHER, AND THAT COST A SECOND REPORT
 * -----------------------------------------------------------
 * The checks above compare menus, and they were green while a doctor on the
 * phone could start a consultation, finish it, and have no way to write down
 * what they found. `POST /patients/:patientId/records` had a caller on the web
 * and none at all on mobile — no sheet, no form, nothing.
 *
 * So the queue existed on both, and the thing a queue is *for* existed on one.
 * Comparing which mutations each client's equivalent screens can issue is the
 * level below a tab, and it is where the last two reports have landed.
 *
 * Reads are deliberately not compared. Mobile shows less on purpose — a phone
 * is a poor place to scan a twelve-month revenue table — and asserting on reads
 * would turn every legitimate difference in density into a failure. A *write*
 * is different: it is a thing the user came to do.
 */
const WRITE_PAIRS: {
  web: string[];
  mobile: string[];
  label: string;
  /**
   * How many writes the web side must yield, as a guard on the extractor.
   *
   * Per pair rather than one constant: a global threshold is either too low to
   * catch a broken extractor on the big screens or too high for a small one,
   * and the version of this that used a magic 2 failed on a pair that
   * legitimately has exactly two.
   */
  minWrites: number;
}[] = [
  {
    label: "the doctor's queue",
    minWrites: 4,
    // Both clients spread a screen's writes across the sheets it opens, so each
    // side is a file *set*. Listing only the page found one write on the web
    // and the vacuous-pass guard below caught it immediately — which is the
    // whole reason that guard is there.
    web: [
      'web/app/(app)/queue/page.tsx',
      'web/components/record-sheet.tsx',
      'web/components/prescription-sheet.tsx',
      // Ordering an investigation is the third thing a consultation produces,
      // and the queue offered no way to do it on either client.
      'web/components/lab-order-sheet.tsx',
    ],
    // The phone splits it differently: the row opens a sheet for the record and
    // navigates to the patient for the prescription, because prescribing needs
    // the allergies and history that screen already loads.
    mobile: [
      'mobile/app/(tabs)/index.tsx',
      'mobile/components/record-sheet.tsx',
      // The phone navigates to its own ordering screen rather than opening a
      // sheet, the same split it uses for prescribing.
      'mobile/app/(tabs)/lab-order/[patientId].tsx',
      // Prescribing is reached by *navigation* rather than an inline sheet —
      // the phone sends the doctor to the patient screen, which already loads
      // the allergies and history the sheet needs. Listed so the write
      // comparison sees it; excluded from the render check below, which only
      // asks about components the screen mounts itself.
      'mobile/app/(tabs)/patient/[id].tsx',
      'mobile/components/prescription-sheet.tsx',
    ],
  },
  {
    label: "the laboratory's incoming referrals",
    minWrites: 2,
    /*
     * The phone could decline an incoming referral and not report one, behind a
     * note saying the other half was on the web. A standalone laboratory whose
     * only action is refusal has a queue that looks like it works — which is
     * why this pair is here rather than trusted to a menu comparison.
     */
    web: ['web/app/(app)/lab/referrals/page.tsx'],
    /*
     * Reporting is no longer done from this queue on either client — accepting
     * raises a real order and the result is transmitted on authorisation, from
     * the worklist. So the pair is accept and decline, and the report sheet
     * that used to sit here is gone rather than merely unreferenced.
     */
    mobile: [
      'mobile/app/(tabs)/lab-incoming.tsx',
      'mobile/components/map-tests-sheet.tsx',
    ],
  },
  {
    label: "the laboratory's own worklist",
    /*
     * Collect, reject, result, verify and the critical-value call. The phone
     * splits this across the worklist and a per-item result screen where the
     * web keeps it on one page — a real difference in shape, and not one that
     * may cost a capability.
     */
    minWrites: 5,
    web: ['web/app/(app)/lab/worklist/page.tsx'],
    mobile: [
      'mobile/app/(tabs)/lab.tsx',
      'mobile/app/(tabs)/lab-result/[itemId].tsx',
    ],
  },
  {
    label: 'the patient record',
    minWrites: 3,
    web: [
      'web/app/(app)/patients/page.tsx',
      'web/components/record-sheet.tsx',
      'web/components/prescription-sheet.tsx',
    ],
    mobile: [
      'mobile/app/(tabs)/patient/[id].tsx',
      'mobile/components/record-sheet.tsx',
      'mobile/components/prescription-sheet.tsx',
    ],
  },
];

/**
 * Every `(method, path)` a file issues, for the methods that change something.
 *
 * The window after the path literal is scanned for `method:` rather than the
 * call being matched to its closing paren, because a real call does not fit in
 * a bounded regex — the web prescription sheet spreads one `api()` over a
 * generic, a path on its own line and a nested body, and matching to `)` found
 * the wrong paren and reported no writes at all. The window is cut at the next
 * `api(` so a GET followed by a POST cannot borrow the POST's method.
 */
function writesIn(source: string): Set<string> {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = new Set<string>();

  for (const call of clean.matchAll(/\bapi[^(]{0,300}\(\s*[`'"]([^`'"]+)[`'"]([\s\S]{0,200})/g)) {
    const window = call[2].split(/\bapi[^(]{0,300}\(/)[0];
    const method = /method:\s*'([A-Z]+)'/.exec(window)?.[1];
    if (!method || method === 'GET') continue;

    const path = call[1]
      .split('?')[0]
      .replace(/\$\{[^}]*\}/g, ':p')
      .replace(/\/+$/, '');
    out.add(`${method} ${path}`);
  }
  return out;
}

const read = (relative: string) => readFileSync(path.join(REPO, relative), 'utf8');

describe('equivalent screens can do the same things', () => {
  it.each(WRITE_PAIRS)('$label offers the same writes on both', ({ web, mobile, minWrites }) => {
    const onWeb = new Set(web.flatMap((f) => [...writesIn(read(f))]));
    const onMobile = new Set(mobile.flatMap((f) => [...writesIn(read(f))]));

    // Vacuous-pass guard: an extractor that found nothing would make the
    // subset check below trivially true. It has already earned its place —
    // the first version of this test listed one file per side and found a
    // single write on the web.
    expect(onWeb.size).toBeGreaterThanOrEqual(minWrites);

    const missing = [...onWeb].filter((write) => !onMobile.has(write));
    expect(missing).toEqual([]);
  });

  it.each(WRITE_PAIRS)('$label can actually reach its sheets', ({ mobile }) => {
    /*
     * A write in a file the screen never opens is not a feature.
     *
     * Found by experiment rather than reasoning: deleting the "Report result"
     * button from the referrals screen left this suite green, because the sheet
     * still contained its `POST` and the comparison only asks which calls exist
     * in the file *set*. That is the same blind spot one level down as
     * `endpoint-coverage` asking whether *a* client calls a route.
     *
     * So every component listed for a pair must be both imported and rendered
     * by the screen that heads the list.
     */
    /*
     * Every component in the pair must be mounted by *one of* the pair's
     * screens — not necessarily the first.
     *
     * The queue reaches prescribing by pushing to the patient screen, which is
     * where that sheet is mounted, and both screens are legitimately part of
     * the same journey. Insisting the first screen mount everything would be
     * asserting an architecture rather than a capability.
     */
    const screens = mobile
      .filter((file) => !file.includes('/components/'))
      .map((file) => read(file))
      .join('\n');

    const unreachable = mobile
      .filter((file) => file.includes('/components/'))
      .map((file) => path.basename(file, '.tsx'))
      // `record-sheet` → `RecordSheet`
      .map((base) => base.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(''))
      /*
       * Word-bounded. A plain `includes('<Name')` also matches `<NameAnything`,
       * so renaming a component and leaving the old mount behind passed — found
       * by trying it, which is the only way this class of hole shows up.
       */
      .filter(
        (name) =>
          !(
            new RegExp(`import \\{[^}]*\\b${name}\\b`).test(screens) &&
            new RegExp(`<${name}\\b`).test(screens)
          ),
      );

    expect(unreachable).toEqual([]);
  });

  it('reaches prescribing from the queue by navigation', () => {
    /*
     * The other half of the check above. The queue does not mount the
     * prescription sheet, so nothing would notice if the route that opens it
     * were deleted — which is exactly how the "Report result" button went
     * missing from the referrals screen while its sheet sat there unreachable.
     */
    const queue = read('mobile/app/(tabs)/index.tsx');
    expect(queue).toMatch(/\/patient\/\$\{item\.patient\.id\}\?prescribe=1/);

    const record = read('mobile/app/(tabs)/patient/[id].tsx');
    expect(record).toMatch(/prescribe === '1'/);
  });

  it('writes a clinical record from the phone at all', () => {
    /*
     * Pinned by name rather than left to the sweep above, because this is the
     * one that was reported and the sweep is only as good as its file lists.
     * A consultation that cannot produce a note is not a consultation.
     */
    const sheet = read('mobile/components/record-sheet.tsx');
    expect(sheet).toMatch(/patients\/\$\{patientId\}\/records/);
    expect(sheet).toMatch(/method: 'POST'/);

    // And it has to be reachable from both places the web offers it.
    expect(read('mobile/app/(tabs)/index.tsx')).toContain('RecordSheet');
    expect(read('mobile/app/(tabs)/patient/[id].tsx')).toContain('RecordSheet');
  });
});
