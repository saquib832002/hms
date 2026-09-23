import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One email, two hospitals, and no way to say which.
 *
 * WHAT WAS REPORTED
 * -----------------
 * *"Newly created tenant's password is not working"*, with a 401 from
 * `AuthService.login`. The stack pointed at the `!user` branch, so the password
 * was never checked: the account was not **found**. An email is unique per
 * hospital, the address already existed at another one, and
 * `findLoginCandidate` refuses to guess between two candidates.
 *
 * That refusal is right and stays. What was wrong is that the documented way
 * out could not be taken: `LoginDto.hospital` has existed since login was
 * written — its own comment reads *"Required in practice for anyone with
 * accounts at two"*, and `findLoginCandidate` said resolving it was "the UI's
 * job" — and **neither client could send it**. `signIn(email, password)` on
 * both. Sixth instance in this repo of a setting with no route in, and the
 * quietest: the other five produced a 404 or a refusal that read as broken, and
 * this one produces *Invalid email or password*, which reads as correct.
 *
 * TWO PROPERTIES, AND THEY PULL AGAINST EACH OTHER
 * -----------------------------------------------
 * The refusal must stay indistinguishable — naming the ambiguity confirms an
 * address is registered, and at more than one hospital — while the person
 * typing must still be able to get in. So the reason goes to the **log**, the
 * message never varies, and the hospital field is revealed after *any* failure
 * rather than after the ambiguous one. Revealing it only when the address is
 * genuinely at two hospitals would leak by the shape of the form exactly what
 * the wording refuses to say.
 */

const read = (p: string) => readFileSync(path.resolve(__dirname, p), 'utf8');
const SERVICE = read('auth.service.ts');
const DTO = read('dto/login.dto.ts');

const WEB_LOGIN = read('../../../web/app/login/page.tsx');
const WEB_API = read('../../../web/lib/api.ts');
const WEB_AUTH = read('../../../web/lib/auth-context.tsx');
const MOBILE_LOGIN = read('../../../mobile/components/login-screen.tsx');
const MOBILE_API = read('../../../mobile/lib/api.ts');
const MOBILE_AUTH = read('../../../mobile/lib/auth-context.tsx');

/** Comments quote the very strings these assertions look for. Strip them. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the refusal says the same thing however login failed', () => {
  it('builds one message and throws it for every branch', () => {
    /*
     * `invalid()` is a single factory rather than a string at each throw, so a
     * later "helpful" variant cannot be added at one site without deleting
     * this. Distinguishing "no such user" from "wrong password" is the classic
     * enumeration oracle; distinguishing "at two hospitals" is a sharper one,
     * because it confirms the address twice over.
     */
    const body = strip(SERVICE);
    expect(body).toMatch(
      /const invalid = \(\) => new UnauthorizedException\('Invalid email or password'\)/,
    );

    // Exactly one wording. Any second `UnauthorizedException` naming a password
    // or an email would be a second answer for the client to tell apart.
    const wordings = body.match(/Invalid email or password/g) ?? [];
    expect(wordings).toHaveLength(1);
  });

  it('never puts the reason into the response', () => {
    const body = strip(SERVICE);
    // The reason is a log argument and a local. It must not reach a thrown
    // exception, which is the only thing the client sees.
    expect(body).not.toMatch(/UnauthorizedException\([^)]*reason/);
    expect(body).not.toMatch(/UnauthorizedException\([^)]*ambiguous/);
    expect(body).not.toMatch(/UnauthorizedException\([^)]*hospitals/);
  });
});

describe('the server writes down which branch fired', () => {
  it('distinguishes the four ways an address fails to resolve', () => {
    for (const reason of [
      'no-such-address',
      'ambiguous',
      'no-such-hospital',
      'not-at-that-hospital',
      'row-not-readable',
    ]) {
      expect(strip(SERVICE)).toContain(`'${reason}'`);
    }
  });

  it('logs it, because the message cannot', () => {
    /*
     * The whole point. Without this line the report is "a password is not
     * working" and the answer takes four files of reading; with it, it is one
     * line naming the ambiguity and the count.
     */
    expect(strip(SERVICE)).toMatch(/this\.logger\.warn\(\s*`Login refused \(\$\{candidate\.reason\}\)/);
  });

  it('names the count on the ambiguous one', () => {
    // "registered at 2 hospitals" is what turns the log line into an answer
    // rather than a category.
    expect(strip(SERVICE)).toMatch(/registered at \$\{candidate\.hospitals\} hospitals/);
  });

  it('still refuses to guess between two candidates', () => {
    // The safety property this whole file is arranged around. If the fallback
    // ever becomes "take the first", an address at two hospitals silently
    // authenticates against whichever row the database returned first.
    expect(strip(SERVICE)).toMatch(/candidates\.length === 1 \? candidates\[0\] : undefined/);
  });
});

describe('the hospital code can actually be sent', () => {
  it('is accepted by the DTO', () => {
    expect(DTO).toMatch(/hospital\?: string/);
  });

  it.each([
    ['web', WEB_API, WEB_AUTH, WEB_LOGIN],
    ['mobile', MOBILE_API, MOBILE_AUTH, MOBILE_LOGIN],
  ])('reaches the API from %s', (_name, api, auth, screen) => {
    /*
     * All three layers, because the field was unreachable for want of any one
     * of them. The DTO accepted it, the service documented it as the UI's job,
     * and nothing between the form and the fetch carried it.
     */
    expect(strip(api)).toMatch(/hospital\?: string/);
    expect(strip(api)).toMatch(/\.\.\.\(hospital \? \{ hospital \} : \{\}\)/);
    expect(strip(auth)).toMatch(/hospital\?: string/);
    expect(strip(screen)).toMatch(/hospital\.trim\(\) \|\| undefined/);
  });

  it('omits it when blank rather than sending an empty string', () => {
    // `@Matches(/^[a-z0-9-]+$/i)` refuses '', so sending it would turn every
    // ordinary sign-in into a 400 the moment the field existed.
    for (const api of [strip(WEB_API), strip(MOBILE_API)]) {
      expect(api).toMatch(/hospital \? \{ hospital \} : \{\}/);
    }
  });
});

describe('the form reveals the field without revealing the reason', () => {
  it.each([
    ['web', WEB_LOGIN],
    ['mobile', MOBILE_LOGIN],
  ])('shows it after any failure on %s', (_name, screen) => {
    const body = strip(screen);

    // Set in the catch, so a wrong password reveals it exactly as an ambiguous
    // address does.
    expect(body).toMatch(/catch[\s\S]{0,240}setFailed\(true\)/);
    expect(body).toMatch(/failed &&/);
  });

  it.each([
    ['web', WEB_LOGIN],
    ['mobile', MOBILE_LOGIN],
  ])('does not key the field on what the server said (%s)', (_name, screen) => {
    /*
     * The leak this avoids is by *shape* rather than by words. A form that
     * grows a hospital box only when the address really is at two hospitals
     * tells an attacker precisely what the single refusal message was written
     * to withhold — and it would look like an improvement in review.
     */
    const body = strip(screen);
    expect(body).not.toMatch(/ambiguous/i);
    expect(body).not.toMatch(/several hospitals/i);
    expect(body).not.toMatch(/failed &&[\s\S]{0,120}error[\s\S]{0,40}includes/);
  });
});
