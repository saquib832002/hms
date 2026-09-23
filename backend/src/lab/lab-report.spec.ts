import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The printed report.
 *
 * Asserted against the source rather than by rendering, because these are
 * properties of *what the renderer decides to draw* rather than of the bytes it
 * produces — and `documents.spec.ts`, which does render, is slow enough that a
 * rule this important should not have to wait behind pdfkit.
 *
 * The rendering tests still matter and still exist. Two of the three bugs in
 * the original PDF work were layout faults that typechecked, produced a valid
 * file and could only be seen by opening one.
 */

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const service = strip(
  readFileSync(path.resolve(__dirname, '../documents/documents.service.ts'), 'utf8'),
);
const controller = strip(
  readFileSync(path.resolve(__dirname, '../documents/documents.controller.ts'), 'utf8'),
);
const method = service.slice(
  service.indexOf('async labReportPdf('),
  service.indexOf('async medicalRecordPdf('),
);

describe('only an authorised report prints', () => {
  it('refuses anything not VERIFIED', () => {
    /*
     * The single refusal in this method, and the one that matters.
     *
     * A PDF leaves the building. It gets filed, photographed and handed to a
     * specialist somewhere else, and nothing about a piece of paper says how
     * provisional it was. Values the laboratory has not stood behind must not
     * be able to become a document — which is stricter than the screens, where
     * the lab sees its own work in progress, and deliberately so: on a screen
     * the state is visible and revocable, on paper it is neither.
     */
    expect(method).toMatch(/o\.status !== 'VERIFIED'/);
    expect(method).toMatch(/has not been authorised yet/);
  });
});

describe('what the page carries', () => {
  it('prints the reference range on every value', () => {
    // A number with no range beside it is one a reader cannot act on.
    expect(method).toMatch(/v\.referenceRange/);
  });

  it('prints sex and date of birth', () => {
    // Not decoration: reference ranges are age- and sex-banded, so a report
    // without them cannot be re-checked against a published interval.
    expect(method).toMatch(/'Sex'/);
    expect(method).toMatch(/'Date of birth'/);
  });

  it('names who authorised it', () => {
    // Including a partner laboratory's pathologist, who has no account here.
    expect(method).toMatch(/externalVerifiedBy/);
    expect(method).toMatch(/Authorised by/);
  });

  it('says so when a test has no result at all', () => {
    // A heading with a gap under it reads as "normal, nothing to report",
    // which is a claim nobody made.
    expect(method).toMatch(/No result was recorded for this test/);
  });
});

describe('the flag column', () => {
  const fn = service.slice(service.indexOf('function flagWord('), service.length);

  it('prints nothing for UNKNOWN', () => {
    /*
     * The rule the whole reference-range module is built around, restated where
     * it reaches paper. "Compared and found unremarkable" and "there was
     * nothing to compare against" are opposite claims, and the wrong one of
     * those on a printed report is a false reassurance nobody can trace back
     * to a missing range.
     *
     * A `titleCase(flag)` would have printed "Unknown", which is at least
     * honest — but the failure mode being guarded against is somebody later
     * "tidying" it to "Normal".
     */
    expect(fn).not.toMatch(/case 'UNKNOWN':\s*return '[A-Za-z]/);
    expect(fn).toMatch(/case 'NORMAL':\s*\n\s*return '';/);
  });

  it('marks critical differently from high', () => {
    // A word, not a colour: these are printed on monochrome laser printers and
    // a pale-red row is an unmarked row.
    expect(fn).toMatch(/\*\* LOW \*\*/);
    expect(fn).toMatch(/\*\* HIGH \*\*/);
  });
});

describe('who may print one', () => {
  const route = controller.slice(
    controller.indexOf("@Get('lab-orders/:id/pdf')"),
    controller.indexOf("@Get('records/:id/pdf')"),
  );

  it('lets reception hand the paper over', () => {
    // The same carve-out prescriptions already have: reception may PRINT a
    // document they may not read as data, and `GET /lab-orders/:id` excludes
    // them. The alternative is fetching a clinician to press a button.
    expect(route).toMatch(/RECEPTIONIST/);
  });

  it('does not let an administrator print one', () => {
    // A printed report is the most complete form of the record there is, and
    // admin is operational rather than clinical. True of every document here.
    expect(route).not.toMatch(/UserRole\.ADMIN/);
  });
});
