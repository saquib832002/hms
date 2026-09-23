import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Signed-in chrome names the hospital, and never a hard-coded one.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The web sidebar said `Meridian HMS` — the demo seed's hospital — in the most
 * prominent position on every screen, so every real customer on the platform
 * looked at somebody else's name all day. The forced-password screen, which is
 * the *first* thing a new member of staff ever sees, said it too.
 *
 * That is the same mistake `documents.spec.ts` already guards one layer down,
 * where the prescription renderer had `<h1>Meridian Hospital</h1>` written into
 * it and patients carried the wrong hospital's name into pharmacies. Nobody
 * carries a sidebar anywhere, which is the only reason this was less serious.
 *
 * WHY IT IS A SAFETY CONTROL AND NOT BRANDING
 * -------------------------------------------
 * One email address can exist at more than one hospital — that is why the login
 * form takes a hospital at all — and one person can hold roles at several. So
 * being signed into the wrong tenant is a reachable state, and the cost is not
 * confusion: it is a prescription, a payment or a clinical note written into
 * another hospital's books, where the audit trail will say it happened.
 *
 * BEFORE SIGN-IN IS DIFFERENT, DELIBERATELY
 * -----------------------------------------
 * The login screen, the biometric prompt and the browser tab title cannot name
 * the hospital, because no session exists yet to know which one it is. A
 * product name is correct there and this test does not object to it. The line
 * is authentication, not aesthetics.
 */

const SRC = path.resolve(__dirname, '../..');
const REPO = path.resolve(SRC, '../..');

const read = (relative: string) => readFileSync(path.join(REPO, relative), 'utf8');

/** Chrome rendered only once a session exists. */
const SIGNED_IN_CHROME = [
  'web/components/shell.tsx',
  'web/components/password-gate.tsx',
  'mobile/components/ui.tsx',
];

/**
 * Screens that run before there is a tenant to name.
 *
 * Listed rather than merely skipped, so that moving one of them into the
 * signed-in set is a visible decision.
 */
const PRE_AUTH = {
  'web/app/login/page.tsx': 'No session yet — the hospital is what the user is about to choose.',
  'web/app/layout.tsx': 'The browser tab title, rendered before any session is resolved.',
  'mobile/components/login-screen.tsx':
    'No session yet — this is where the hospital is chosen, not displayed.',
  'mobile/components/auth-gate.tsx': 'The idle lock screen, shown when the session is not usable.',
  'mobile/lib/auth-context.tsx': 'The OS biometric prompt string, set before unlock.',
};

/**
 * Names that must never be hard-coded into signed-in chrome.
 *
 * `Meridian` is the demo seed's hospital and the one that actually leaked. The
 * others are the shapes a placeholder usually takes when somebody needs
 * something to put in a heading.
 */
const FORBIDDEN = /Meridian|St\.? Mary|General Hospital|Demo Hospital|Acme/i;

describe('signed-in chrome names the tenant', () => {
  it('finds the files it is checking', () => {
    // Vacuous-pass guard: a moved file would make every assertion below true
    // while reading nothing.
    for (const file of SIGNED_IN_CHROME) {
      expect(read(file).length).toBeGreaterThan(500);
    }
  });

  it.each(SIGNED_IN_CHROME)('%s hard-codes no hospital name', (file) => {
    /*
     * Comments stripped first. This file and the ones it guards *discuss*
     * the leak at length, and a check that failed on its own explanation would
     * be answered by deleting the explanation.
     */
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

    expect(code).not.toMatch(FORBIDDEN);
  });

  it('reads the hospital off the session in both shells', () => {
    // Asserted positively as well, because "contains no forbidden word" is also
    // satisfied by a heading that says nothing at all.
    expect(read('web/components/shell.tsx')).toMatch(/user\.hospital\??\.name/);
    expect(read('mobile/components/ui.tsx')).toMatch(/user\?\.hospital\?\.name/);
  });

  it('shows it on every mobile screen, not one of them', () => {
    /*
     * In `AppHeader` rather than passed per screen. A prop every screen has to
     * remember is a prop some screen will forget, and the screen that forgets
     * is the one somebody is standing on when it matters.
     */
    const header = read('mobile/components/ui.tsx');
    const start = header.indexOf('export function AppHeader(');
    expect(start).toBeGreaterThan(-1);

    const next = header.slice(start).search(/\nexport function \w+/);
    const body = header.slice(start, next === -1 ? undefined : start + next);

    expect(body).toMatch(/hospital\?\.name/);
  });

  it('does not take the hospital out of a screen’s own subtitle', () => {
    /*
     * The tenant is the constant and the subtitle is the screen — "Drug round",
     * "Updated 2m ago". Rendering the hospital *as* the subtitle would trade
     * one fact for another and quietly remove context the screens rely on.
     */
    const header = read('mobile/components/ui.tsx');
    expect(header).toMatch(/subtitle \?/);
    expect(header).toMatch(/headerTenant/);
  });

  it('gives every pre-auth exemption a reason', () => {
    for (const [file, reason] of Object.entries(PRE_AUTH)) {
      expect(read(file).length).toBeGreaterThan(100);
      expect(reason.length).toBeGreaterThan(25);
      expect(SIGNED_IN_CHROME).not.toContain(file);
    }
  });
});
