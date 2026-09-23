#!/usr/bin/env node
/**
 * Is the feature in the code, and is it in the build the browser is running?
 *
 * WHY THIS EXISTS
 * ---------------
 * Several times now a feature has looked "gone" when it was present and
 * working. Every time the cause was one of three things, and none of them was
 * lost code:
 *
 *   1. The control is gated on a *role* — Partner Pharmacies is admin-only, so
 *      it vanishes the moment you switch to Doctor to test prescribing.
 *   2. The control is gated on a *condition* — "set price" only renders for a
 *      medicine with no price, so once you have priced everything there is
 *      nothing to see.
 *   3. The browser is running an older bundle than the source on disk.
 *
 * From a user's chair those are indistinguishable from a deleted feature, and
 * proving which one it is by reading source is not a reasonable thing to ask.
 * So: run this. It reports, per feature, whether the source has it and whether
 * the compiled client bundle has it.
 *
 *   node scripts/features.js
 *
 * A feature that is SOURCE ✓ / BUILD ✗ means the dev server has not compiled
 * that route yet — visit the page, or restart it. A feature that is ✓ / ✓ and
 * still not visible on screen is case 1 or 2, and the "shown when" column says
 * which.
 */

const { readFileSync, existsSync, readdirSync, statSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Each entry names a string that only exists because the feature exists.
 *
 * Deliberately a user-visible string rather than a function name: it is the
 * thing that survives into the bundle, and it is what the person looking at
 * the screen would recognise.
 */
const FEATURES = [
  {
    name: 'Set a price while dispensing',
    // The label lives in the shared control, not at the call site — the
    // first version of this pointed at dispense-sheet.tsx and reported a
    // working feature as GONE. A fixture that does not match reality tests
    // the fixture, which this repo has now learned four times.
    marker: 'Not priced — set price',
    file: 'web/components/price-inline.tsx',
    shownWhen: 'any mapped medicine — priced rows are editable too',
  },
  {
    name: 'Set a price at the counter',
    marker: 'not priced — set',
    file: 'web/app/(app)/pharmacy/sell/page.tsx',
    shownWhen: 'every row; a priced one shows the number, still clickable',
  },
  {
    name: 'Dispense hands over to payment',
    marker: '/pharmacy/invoices?invoice=',
    file: 'web/components/dispense-sheet.tsx',
    shownWhen: 'a dispense raised an invoice and nothing was left unpriced',
  },
  {
    name: 'Partner pharmacies (add/remove)',
    marker: 'Partner pharmacies',
    file: 'web/app/(app)/admin/partners/page.tsx',
    shownWhen: 'acting as ADMIN — it is not in a doctor’s navigation',
  },
  {
    name: 'Send a prescription to a partner',
    marker: 'Send to a partner pharmacy',
    file: 'web/components/prescription-sheet.tsx',
    shownWhen: 'always; disabled with a reason when no partner is added',
  },
  {
    name: 'Your hospital’s own code',
    // JSX writes the apostrophe as an entity, so match around it.
    marker: 'code is',
    file: 'web/app/(app)/admin/settings/page.tsx',
    shownWhen: 'acting as ADMIN, on Clinic Settings',
  },
  {
    name: 'Referral history (dispensed/declined)',
    marker: 'Dispensed',
    file: 'web/app/(app)/pharmacy/referrals/page.tsx',
    shownWhen: 'acting as PHARMACIST, on Incoming',
  },
  {
    name: 'Prescribe again from an old prescription',
    marker: 'Prescribe again',
    file: 'web/app/(app)/patients/page.tsx',
    shownWhen: 'acting as DOCTOR, on a patient’s Prescriptions tab',
  },
  {
    name: 'New prescription / Add a record',
    marker: 'New prescription',
    file: 'web/app/(app)/patients/page.tsx',
    shownWhen: 'acting as DOCTOR, on any patient',
  },
  {
    name: 'Quantity worked out on a referral',
    marker: 'Quantity not calculated',
    file: 'web/app/(app)/pharmacy/referrals/page.tsx',
    shownWhen: 'acting as PHARMACIST, on Incoming',
  },
];

/** Every compiled client chunk, so a marker can be found wherever it landed. */
function bundles() {
  const dir = path.join(ROOT, 'web', '.next', 'static', 'chunks');
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.js')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const built = bundles();
const pad = (s, n) => String(s).padEnd(n);

console.log('');
console.log(pad('FEATURE', 42) + pad('SOURCE', 9) + pad('BUILD', 8) + 'SHOWN WHEN');
console.log('-'.repeat(130));

let missingFromSource = 0;

for (const f of FEATURES) {
  const file = path.join(ROOT, f.file);
  const inSource = existsSync(file) && readFileSync(file, 'utf8').includes(f.marker);
  if (!inSource) missingFromSource++;

  const inBuild =
    built === null
      ? '—'
      : built.some((b) => {
          try {
            return readFileSync(b, 'utf8').includes(f.marker);
          } catch {
            return false;
          }
        })
        ? '✓'
        : '✗';

  console.log(pad(f.name, 42) + pad(inSource ? '✓' : '✗ GONE', 9) + pad(inBuild, 8) + f.shownWhen);
}

console.log('');
if (built === null) {
  console.log('No web/.next build found — BUILD could not be checked. Start the dev server.');
} else {
  console.log('BUILD ✗ usually means that route has not been visited since the server started.');
}
console.log(
  missingFromSource === 0
    ? 'All features present in source.'
    : `${missingFromSource} feature(s) missing from source — that would be a real regression.`,
);
console.log('');

process.exit(missingFromSource === 0 ? 0 : 1);
