import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The report goes back, somebody is told when it does not, and there is a way
 * to try again.
 *
 * WHAT WAS REPORTED
 * -----------------
 * "The partner lab received it. They made the report and authorised it, and the
 * transaction moved to done. But the report is not sent back to the doctor at
 * the hospital who sent the initial request."
 *
 * Three separate faults sat behind that, and each of them is a shape this
 * project has recorded before:
 *
 * 1. **The failure was silent.** `transmitIfReferred` ended in a bare
 *    `catch { return { reportedBack: false } }` — no log, and the reason
 *    discarded although `returnResult` refuses with a written sentence
 *    precisely so somebody can be told. The API refusing correctly and
 *    unexplainably, which is the shape the print anchor and the document
 *    helpers were both reopened for.
 *
 * 2. **Nothing read the answer.** `reportedBack` was returned from the day the
 *    return leg was built and no client anywhere looked at it — the doc comment
 *    said "so the technician's screen can say whether the other hospital has
 *    it", and no screen did. A false claim in a comment is the same failure as
 *    a false reason in an exemption list: it reads as a decision somebody made.
 *
 * 3. **There was no route out.** The transmission fires from `verify`, and
 *    `verify` refuses on an order that is already VERIFIED — so a report that
 *    failed to transmit was authorised here, absent there, and unsendable by
 *    anything in the product. Seventh instance of the family.
 *
 * A fourth, found while fixing the others: the local items were mapped onto the
 * referral's **by array position**, across two queries with no `orderBy`. On a
 * multi-test referral that can write a potassium into another hospital's record
 * under the glucose. It typechecked and it looked right.
 */

import { matchReferralItems } from './referral-item-match';

const read = (f: string) => readFileSync(path.join(__dirname, f), 'utf8');
const LAB = read('lab.service.ts');
const REFERRAL = read('lab-referral.service.ts');
const MATCH = read('referral-item-match.ts');
const CONTROLLER = read('lab.controller.ts');
const WEB_WORKLIST = readFileSync(
  path.join(__dirname, '../../../web/app/(app)/lab/worklist/page.tsx'),
  'utf8',
);
const MOBILE_WORKLIST = readFileSync(
  path.join(__dirname, '../../../mobile/app/(tabs)/lab.tsx'),
  'utf8',
);

/** Comments quote the very strings these assertions look for. Strip them. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The body of one method, so an assertion about it cannot be satisfied by its
 * neighbour.
 *
 * The first version of the "keeps the reason" test below searched the whole
 * file, and it **passed with the bare catch reintroduced** — because
 * `rejectIfReferred` right underneath also calls `reportFailure`, and one
 * method's correctness stood in for the other's. Verified by putting the fault
 * back and watching it not fail, which is the only way to find out.
 */
function methodBody(src: string, declaration: string): string {
  const start = src.indexOf(declaration);
  if (start === -1) throw new Error(`${declaration} is gone — this test is stale`);
  const rest = src.slice(start + declaration.length);
  // The next method declaration at class-indent level ends this one.
  const next = rest.search(/\n {2}(?:private |public |async |\/\*\*)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe('a report that did not reach the other hospital says so', () => {
  it.each([
    ['private async transmitIfReferred('],
    ['private async rejectIfReferred('],
  ])('keeps the reason instead of swallowing it — %s', (declaration) => {
    const body = methodBody(LAB, declaration);

    // The specific regression, in the method that had it: a `catch` that
    // discards the error and answers with a bare boolean. `returnResult`
    // refuses with a written sentence precisely so somebody can be told, and
    // for months nothing displayed it.
    expect(body).not.toMatch(/catch[^{]*\{[\s\S]{0,120}return \{ reportedBack: false \}/);
    expect(body).toMatch(/catch \(err\)[\s\S]{0,300}reportFailure\(/);
  });

  it('logs it, because the screen is only read by whoever is standing there', () => {
    expect(LAB).toMatch(/private reportFailure\([\s\S]{0,400}this\.logger\.error\(/);
  });

  it('sends the reason to the client, not just a boolean', () => {
    expect(LAB).toMatch(/reportedBackError/);
  });

  it('is read by both clients at the moment of authorising', () => {
    for (const [name, src] of [
      ['web', WEB_WORKLIST],
      ['mobile', MOBILE_WORKLIST],
    ] as const) {
      // A screen that ignores this is the original bug, and it is invisible in
      // review — the call looks like every other successful action.
      expect(name && strip(src)).toMatch(/reportedBack === false/);
      expect(strip(src)).toMatch(/reportedBackError/);
    }
  });
});

describe('a failed transmission can be retried by a human', () => {
  it('has a route that takes no result body', () => {
    /*
     * Deliberately not a client caller for `POST /lab/referrals/:id/result`.
     * That route accepts values and exists for `LabService.verify` to invoke;
     * giving a client a way to post into it steps around the authorisation gate
     * that accessioning a referral exists to impose. This one rebuilds the
     * payload from the already-authorised order.
     */
    expect(CONTROLLER).toMatch(/@Post\('orders\/:id\/report-back'\)/);
    expect(CONTROLLER).toMatch(/reportBack\(@Param\('id', ParseIntPipe\) id: number/);
  });

  it('refuses once the other hospital actually has it', () => {
    // A correction is a new order, so the original stays readable. Without this
    // the button silently overwrites a report somebody has already acted on.
    expect(LAB).toMatch(/async reportBack\([\s\S]{0,1600}referral\.resultedAt[\s\S]{0,300}ConflictException/);
  });

  it('refuses before the report is authorised', () => {
    expect(LAB).toMatch(/async reportBack\([\s\S]{0,2200}status !== LabOrderStatus\.VERIFIED/);
  });

  it('is offered on both clients', () => {
    expect(strip(WEB_WORKLIST)).toMatch(/report-back/);
    expect(strip(MOBILE_WORKLIST)).toMatch(/report-back/);
  });
});

describe('results are joined to the referral by test code, never by position', () => {
  it('orders both sides of the join explicitly', () => {
    /*
     * Two unordered reads zipped by index is the bug. Postgres returns rows in
     * no particular order unless asked, and the failure writes a real value
     * onto the wrong test in another hospital's record.
     */
    expect(LAB).toMatch(/private async transmitIfReferred\([\s\S]{0,2500}orderBy: \{ id: 'asc' \}/);
  });

  it('matches on the sender’s own test code', () => {
    // `accept` captures the *sender's* code onto the local item precisely so
    // this join is exact rather than a coincidence of insertion order.
    expect(strip(MATCH)).toMatch(/queue\.get\(normalise\(item\.testCode\)\)/);
    expect(strip(MATCH)).toMatch(/const normalise = \(code: string\) => code\.trim\(\)\.toUpperCase\(\)/);
  });

  it('refuses and names the tests rather than guessing', () => {
    expect(LAB).toMatch(/unmatched\.length > 0[\s\S]{0,400}could not be matched back/);
  });

  it('is one implementation, used by both halves of the return leg', () => {
    /*
     * The values and the attached files must land on the same test. Two copies
     * of this join drifting would put a potassium on one row and its report PDF
     * on another — worse than either being wrong alone, because both halves
     * look plausible. Same reasoning as `resolveAuditTarget` and
     * `resolveTreatingScope`, and the reason this is a file rather than a loop.
     */
    expect(strip(LAB)).toMatch(/matchReferralItems\(/);
    expect(strip(REFERRAL)).toMatch(/matchReferralItems\(/);

    // Neither may grow its own copy back.
    for (const src of [strip(LAB), strip(REFERRAL)]) {
      expect(src).not.toMatch(/new Map<string, \{ sourceOrderItemId: number \}\[\]>/);
    }
  });

  it('pairs, and refuses, on real data', () => {
    // A duplicate code on one requisition is legal — a repeat — and is consumed
    // in id order rather than collapsed onto one row.
    const match = matchReferralItems(
      [
        { id: 20, testCode: 'fbc ', testName: 'Full blood count' },
        { id: 10, testCode: 'FBC', testName: 'Full blood count' },
        { id: 30, testCode: 'TROP', testName: 'Troponin' },
      ],
      [
        { sourceOrderItemId: 501, testCode: 'FBC' },
        { sourceOrderItemId: 502, testCode: ' fbc' },
      ],
    );

    // Sorted by local id, so 10 answers the first referred FBC and 20 the
    // second — whatever order the database handed them over in.
    expect(match.pairs).toEqual([
      { localItemId: 10, sourceOrderItemId: 501 },
      { localItemId: 20, sourceOrderItemId: 502 },
    ]);
    expect(match.unmatched).toEqual(['Troponin']);
  });
});

describe('the partner’s attached files travel with the result', () => {
  it('copies them into the ordering hospital’s scope', () => {
    /*
     * Reported from use: the partner authorised a report with a PDF attached
     * and the doctor saw values and no document. For histopathology, cytology
     * or imaging the **file is the result**, and this leg carried values,
     * findings, impression and methodology and nothing else.
     */
    expect(strip(REFERRAL)).toMatch(/labAttachment\.create\(/);
    expect(strip(REFERRAL)).toMatch(/tenantId: referral\.sourceTenantId/);
  });

  it('reads the bytes before the scope switches, not inside it', () => {
    /*
     * Inside `pushBack` the tenancy proxy points at the *sender's* transaction
     * and these rows are ours — reading there returns nothing, silently, which
     * is the same ordering mistake provisioning made against RLS once.
     */
    const body = REFERRAL.slice(REFERRAL.indexOf('async returnResult('));
    const read = body.indexOf('labAttachment.findMany');
    const push = body.indexOf('this.pushBack(');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(push);
  });

  it('claims no author at the other end', () => {
    // The technician who attached it has no account there, and inventing one
    // makes a partner's file indistinguishable from their own staff's in an
    // audit — the rule that already keeps `resultedById` null.
    expect(strip(REFERRAL)).toMatch(/uploadedById: null/);
  });

  it('carries the checksum, so a disputed document can be identified', () => {
    expect(strip(REFERRAL)).toMatch(/checksum: file\.checksum/);
  });

  it('skips a file it cannot place rather than guessing a test', () => {
    expect(strip(REFERRAL)).toMatch(/sourceOrderItemId === undefined[\s\S]{0,60}continue/);
  });
});
