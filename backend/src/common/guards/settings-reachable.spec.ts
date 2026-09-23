import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CLINIC } from '../tenancy/clinic-settings';

/**
 * Every hospital setting has to be settable from somewhere.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `Tenant.acceptsExternalLabOrders` shipped with the lab: the column existed,
 * the partner lookup read it, and no screen could switch it on. So every
 * attempt to add a partner laboratory was refused with *"no lab is accepting
 * orders under that code"* — a refusal that was correct, unexplainable, and
 * impossible to clear from anywhere in the product. Found by a user, on the
 * first real attempt to use the feature.
 *
 * THIS IS THE FIFTH TIME, WHICH IS WHY IT IS A TEST NOW
 * ----------------------------------------------------
 * The medicine catalogue was seed-only. `Doctor` profiles could only be made
 * as a side effect of creating a user. Wards had no create route. Drug-chart
 * items the parser refused to schedule had no screen that could set them. Each
 * was a precondition the system stated and nothing could satisfy, and each was
 * found on a real deployment rather than by a test.
 *
 * `self-provisionable.spec.ts` covers the version of this that is about *rows*
 * — can a hospital create the records it needs. This covers the version that is
 * about *flags*: a boolean that gates a feature is exactly as unreachable as a
 * missing endpoint, and it fails more quietly because the refusal it produces
 * reads like a legitimate one.
 *
 * WHAT IS CHECKED
 * ---------------
 * For every field of `ClinicSettings`:
 *   1. the update DTO accepts it — otherwise the API silently drops it;
 *   2. `updateClinicSettings` writes it — otherwise it is accepted and lost;
 *   3. an admin screen sends it — otherwise nobody can reach it.
 *
 * Mobile is checked against an exemption list rather than required outright,
 * because mobile admin is deliberately a curated subset. Each exemption carries
 * its reason, and a reason that stops being true is a lie in a list — which
 * this repo has been bitten by three times.
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

const read = (files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');

const dto = readFileSync(path.join(BACKEND, 'src/admin/dto/clinic-settings.dto.ts'), 'utf8');
const service = readFileSync(path.join(BACKEND, 'src/admin/admin.service.ts'), 'utf8');
const webSource = read(walk(path.join(ROOT, 'web/app/(app)/admin'), /\.tsx?$/));
const mobileSource = read(walk(path.join(ROOT, 'mobile/app/(tabs)/settings'), /\.tsx?$/));

/**
 * Does this screen actually SEND the field, rather than merely mention it?
 *
 * Two earlier versions of this test were too loose and each was wrong in an
 * instructive way. Reading every client file reported the tax settings as
 * reachable on mobile — the phone names `taxEnabled` because an invoice screen
 * reads it to decide whether to draw a tax line. Narrowing to the settings
 * screens still reported them, because the screen declares the whole settings
 * shape in a type in order to *display* it.
 *
 * Reading a setting and being able to change it are different capabilities, and
 * a test that conflates them would sign off a hospital that can see its own tax
 * setting and never alter it. `field: form.field` in the PATCH body is the
 * narrowest honest signal for "an administrator can change this here".
 */
const sends = (source: string, field: string) =>
  // Anything on the line between the key and `form.<field>`, because the
  // numeric settings are coerced on the way out — `slotMinutes:
  // Number(form.slotMinutes)`. A first version matched only the bare form and
  // reported four settings as unreachable that are set on both clients, which
  // would have been a false failure sending somebody to look for a control
  // that is already there.
  new RegExp(`\\b${field}:\\s*[^,\\n]*form\\.${field}\\b`).test(source);

/** The write block inside `updateClinicSettings`, where a field is persisted. */
const writeBlock = service.slice(
  service.indexOf('async updateClinicSettings('),
  service.indexOf('private async tz('),
);

/**
 * Settings the phone deliberately does not carry, each with its reason.
 *
 * Tax configuration is web-only on the same line as departments, staff accounts
 * and the ward layout: an accounting decision taken once with the figures to
 * hand, not a one-handed task. The phone shows what was charged without
 * carrying the rules that produced it.
 */
const MOBILE_EXEMPT: Record<string, string> = {
  pricesIncludeTax:
    'Whether a typed price already contains tax is set alongside the rate table, and the rate table is web-only — an accounting decision taken once at a desk with the figures to hand.',
  consultationTaxRateId:
    'As above, and more strongly: it names a row in the rate table, so it cannot be chosen on a client that does not carry the table.',
};

/*
 * `taxEnabled` is deliberately NOT exempt. The phone offers the master switch —
 * turning tax off is the kind of thing an owner does the moment they see it
 * wrong on an invoice — while the rate table behind it stays on the desk. That
 * asymmetry is a decision, and this list is where it would be recorded if it
 * changed.
 */

const FIELDS = Object.keys(DEFAULT_CLINIC);

describe('every clinic setting is reachable', () => {
  it('finds the sources it is reading', () => {
    // A silently empty read would make every assertion below vacuous — the
    // failure mode `access-matrix.spec.ts` spent six phases in.
    expect(FIELDS.length).toBeGreaterThan(8);
    expect(webSource.length).toBeGreaterThan(10_000);
    expect(mobileSource.length).toBeGreaterThan(5_000);
    expect(writeBlock).toContain('tenant.update');
  });

  it.each(FIELDS)('the update DTO accepts %s', (field) => {
    // Without this the pipe strips it and the API answers 200 having changed
    // nothing — the worst of the three failures, because it looks like success.
    expect(dto).toMatch(new RegExp(`\\b${field}\\?`));
  });

  it.each(FIELDS)('updateClinicSettings persists %s', (field) => {
    expect(writeBlock).toMatch(new RegExp(`\\b${field}:`));
  });

  it.each(FIELDS)('an admin screen on the web can set %s', (field) => {
    /*
     * The assertion that would have caught the lab flag. A setting no screen
     * sends is one an administrator cannot reach, and the feature it gates
     * then fails with a refusal that reads entirely legitimate.
     */
    expect(sends(webSource, field)).toBe(true);
  });

  it.each(FIELDS)('mobile can set %s, or says why not', (field) => {
    if (MOBILE_EXEMPT[field]) {
      // A reason, and a real one. "As above" chains are allowed; empty ones
      // are not, because an exemption with no argument is how a gap acquires
      // a rationale it never earned.
      expect(MOBILE_EXEMPT[field].length).toBeGreaterThan(20);
      return;
    }
    expect(sends(mobileSource, field)).toBe(true);
  });

  it('has no stale mobile exemption', () => {
    /*
     * The list has to shrink on its own or it rots into claims nobody
     * rechecks. If the phone's settings screens gain one of these, the entry
     * describing its absence becomes false and this fails.
     *
     * Keyed on what the screen sends, for the reason on `sends`: the settings
     * screen declares the whole shape in order to display it, and declaring a
     * field is not offering a control for it.
     */
    const stale = Object.keys(MOBILE_EXEMPT).filter((f) => sends(mobileSource, f));
    expect(stale).toEqual([]);
  });

  it('exempts nothing that is not a real setting', () => {
    const unknown = Object.keys(MOBILE_EXEMPT).filter((f) => !FIELDS.includes(f));
    expect(unknown).toEqual([]);
  });
});

describe('the two-sided opt-ins have both sides', () => {
  /*
   * A sharper version of the rule above, for the specific shape that keeps
   * failing: a flag on THIS tenant that decides whether ANOTHER tenant can find
   * it. Nothing observable happens when you switch it on, and nothing
   * observable is missing when there is no switch — so the gap is invisible
   * from either end until somebody types a code and is refused.
   */
  const OPT_INS = [
    { flag: 'acceptsExternalPrescriptions', partnerScreen: 'pharmacy-partners' },
    { flag: 'acceptsExternalLabOrders', partnerScreen: 'lab-partners' },
  ];

  it.each(OPT_INS)('$flag has a switch and a partner screen', ({ flag, partnerScreen }) => {
    // The switch: an administrator can make their own hospital findable.
    expect(webSource).toContain(flag);
    // The other end: somebody can act on the code that produces.
    expect(webSource).toContain(partnerScreen);
  });

  it.each(OPT_INS)('$flag is read by the lookup that refuses without it', ({ flag }) => {
    /*
     * Pins the connection that made this invisible. The lookup reading a flag
     * no screen can set is precisely the failure — and a future reader
     * deleting the switch would break the feature without breaking a test,
     * unless something asserts the pair.
     */
    const controllers = read(walk(path.join(BACKEND, 'src'), /\.(controller|service)\.ts$/));
    expect(controllers).toContain(flag);
  });
});
