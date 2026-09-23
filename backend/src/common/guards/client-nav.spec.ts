import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * An in-app link must be a `Link`, never a bare `<a href="/...">`.
 *
 * WHY THIS LOGS PEOPLE OUT
 * ------------------------
 * The access token is held in memory only. That is deliberate: a token in
 * localStorage survives the tab, and anything that can read it can resume a
 * clinical session. The refresh token lives in an httpOnly cookie and the
 * access token is re-minted from it — but only by code that is running.
 *
 * A raw `<a>` to an internal route is a full document load. React unmounts,
 * the in-memory token goes with it, and the first API call from the freshly
 * mounted app 401s. The user lands on the login screen and reads it as "my
 * session timed out", which is nowhere near the cause.
 *
 * It is a nasty failure because it is invisible in review — the markup is
 * ordinary HTML and looks right — and it only shows up when somebody clicks
 * that particular link, mid-task. Reported from use twice: a pharmacist
 * clicking through to an incoming prescription, and again on the Dispense
 * button of the referral itself.
 *
 * WHAT IS ALLOWED
 * ---------------
 * Any absolute `http(s)://` link. The rule is only about routes this app
 * itself serves.
 *
 * WHAT USED TO BE ALLOWED AND IS NOT
 * ----------------------------------
 * `<a>` to `/api/v1/...` was exempted as "downloads and printables that must
 * leave the SPA". That reasoning is true of a genuinely public download and
 * false of every authenticated one — which is all of them here.
 *
 * The access token lives in memory and travels as an `Authorization` header.
 * A browser navigation sends no header, so the request arrives unauthenticated
 * and the API answers 401. Correctly. `<a href={`/api/v1/prescriptions/${id}/print`}>`
 * sat on the patient screen from Phase 1 and never once produced a document;
 * it looked implemented, and the only evidence was a 401 in a log nobody was
 * reading.
 *
 * Authenticated files are fetched with the header and handed to the browser as
 * a blob — `web/lib/documents.ts` on the web, `mobile/lib/documents.ts` on the
 * phone. So the exemption is gone, and this test now fails on any `<a>` to the
 * API at all.
 */

const BACKEND_SRC = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(BACKEND_SRC, '../..');
const WEB = path.join(REPO_ROOT, 'web');

function tsx(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsx(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/.*$/gm, '');

describe('client-side navigation keeps the session', () => {
  const files = [...tsx(path.join(WEB, 'app')), ...tsx(path.join(WEB, 'components'))];

  it('finds the client source', () => {
    // Without this an empty list would satisfy "nothing is broken".
    expect(files.length).toBeGreaterThan(15);
  });

  it('uses Link for every internal route', () => {
    /*
     * Matches `<a ... href="/x">` and `<a ... href={`/x...`}>`, and excludes
     * `/api/` because those are deliberate full-document navigations.
     *
     * Comments are stripped first — this repo has caught itself three times
     * with a test matching its own prose about the thing it forbids.
     */
    const offenders: string[] = [];

    for (const file of files) {
      const src = strip(readFileSync(file, 'utf8'));
      const anchors = src.match(/<a\b[^>]*href=(?:"|\{`)\/[^"`]*/g) ?? [];
      for (const a of anchors) {
        /*
         * No `/api/` exemption any more. An anchor to an authenticated
         * endpoint sends no Authorization header and 401s — silently, because
         * it opens in a new tab the user then closes. Fetch it through
         * `openDocument`/`downloadDocument` instead.
         */
        offenders.push(`${path.relative(REPO_ROOT, file)}: ${a.slice(0, 60)}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
