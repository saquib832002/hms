import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The rules a file has to obey on its way in and on its way out.
 *
 * `attachment-rules.spec.ts` covers the sniffing itself. This covers the wiring
 * around it: that the service and controller actually apply those rules, that
 * the bytes stay out of ordinary queries, and that a file cannot leave the
 * laboratory before the report is signed.
 *
 * Asserted against source because these are properties of *how the code is
 * arranged* — which query selects what, which header is set — and those are
 * exactly the properties that survive a passing unit test and break in
 * production.
 */

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const service = strip(
  readFileSync(path.resolve(__dirname, 'lab-attachments.service.ts'), 'utf8'),
);
const controller = strip(
  readFileSync(path.resolve(__dirname, 'lab-attachments.controller.ts'), 'utf8'),
);
const schema = readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
const rls = readFileSync(
  path.resolve(__dirname, '../../prisma/rls/tenant-isolation.sql'),
  'utf8',
);

describe('the bytes stay out of ordinary queries', () => {
  it('keeps the content in its own table', () => {
    /*
     * THE DESIGN DECISION THIS FILE EXISTS TO PROTECT.
     *
     * Prisma selects every scalar column unless a query says otherwise. A
     * `Bytes` column on `LabAttachment` would mean `findMany()` — the query
     * that draws a list of filenames — pulling every PDF on the order into
     * memory, and the mistake would be invisible at the call site.
     *
     * Behind a relation it cannot happen by accident: a blob arrives only if
     * somebody writes an `include` or names it in a `select`.
     */
    const attachment = /model LabAttachment \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? '';
    expect(attachment).toBeTruthy();
    expect(attachment).not.toMatch(/\bBytes\b/);

    const data = /model LabAttachmentData \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? '';
    expect(data).toMatch(/content\s+Bytes/);
    // One blob per attachment, enforced rather than assumed.
    expect(data).toMatch(/attachmentId\s+Int\s+@unique/);
  });

  /**
   * Every place in the laboratory module that pulls the bytes, and why.
   *
   * WHY THIS IS THE WHOLE DIRECTORY AND NOT ONE FILE
   * -----------------------------------------------
   * It read `lab-attachments.service.ts` alone and asserted "exactly one
   * method". Then the return leg started copying a partner's report into the
   * ordering hospital's scope — a second reader, in `lab-referral.service.ts`,
   * completely invisible here. **The test stayed green while the rule it states
   * had stopped being true**, which is the one failure mode a guard cannot
   * afford and the third time this repo has hit it.
   *
   * A file-scoped matcher standing in for a statement about the module is the
   * same fault the send-out invoice guard had. Naming the readers is the honest
   * version: the list has to be edited deliberately, and a third one fails.
   */
  const BYTE_READERS: Record<string, string> = {
    'lab-attachments.service.ts':
      'download() — the only method that serves a file to a caller, and the reason the bytes live in their own table.',
    'lab-referral.service.ts':
      'returnResult() — copying a partner laboratory\'s report into the ordering hospital\'s scope. There is no way to move a file across a tenant boundary without reading it, and the alternative was an RLS carve-out making one hospital\'s rows visible to another.',
  };

  it('reads the content only where it is written down', () => {
    /*
     * If a third place needs the bytes, that is the moment to move to object
     * storage rather than the moment to add another `include` — so this fails
     * and makes somebody decide.
     */
    const dir = path.resolve(__dirname);
    const offenders: string[] = [];

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
      const src = strip(readFileSync(path.join(dir, file), 'utf8'));
      const reads = src.match(/data:\s*\{\s*select:\s*\{\s*content:\s*true/g) ?? [];
      if (reads.length > 0 && !(file in BYTE_READERS)) offenders.push(file);
      if (file in BYTE_READERS) expect(reads.length).toBeGreaterThan(0);
    }

    expect(offenders).toEqual([]);
  });

  it('serves a file from exactly one method', () => {
    // The reader that hands bytes to a caller is still one method. The second
    // one copies them sideways and serves nobody.
    const reads = service.match(/data:\s*\{\s*select:\s*\{\s*content:\s*true/g) ?? [];
    expect(reads).toHaveLength(1);

    const download = service.slice(service.indexOf('async download('));
    expect(download).toMatch(/content: true/);
  });

  it('every listed reader states why it needs them', () => {
    // An entry with no reason is how a list of exemptions rots into a list of
    // things nobody rechecks.
    for (const [file, reason] of Object.entries(BYTE_READERS)) {
      expect(reason.length).toBeGreaterThan(40);
      expect(existsSync(path.resolve(__dirname, file))).toBe(true);
    }
  });

  it('lists metadata through an explicit select', () => {
    // So a column added to `LabAttachment` cannot quietly start appearing in a
    // list response, and so a reader can see at a glance that `data` is absent.
    expect(service).toMatch(/satisfies Prisma\.LabAttachmentSelect/);
    expect(service).toMatch(/select: METADATA/);
  });

  it('scopes both tables in the RLS policy', () => {
    for (const table of ['lab_attachments', 'lab_attachment_data']) {
      expect(rls).toContain(`'${table}'`);
    }
  });
});

describe('nothing leaves the laboratory before it is signed', () => {
  it('withholds the list from everybody but the lab', () => {
    /*
     * The same rule as values, and it matters more for a file: a screen's state
     * is visible and revocable, and a PDF somebody has saved to a phone is
     * neither. A provisional report that has left the building has nothing on
     * it to say it was provisional.
     */
    const list = service.slice(service.indexOf('async forOrder('), service.indexOf('async download('));
    expect(list).toMatch(/LabOrderStatus\.VERIFIED/);
    expect(list).toMatch(/UserRole\.LAB_TECHNICIAN/);
  });

  it('withholds the file itself, not just the listing', () => {
    // Hiding a row from a list while still serving it by id is the shape of
    // access control that looks right and is not.
    const download = service.slice(service.indexOf('async download('), service.indexOf('async remove('));
    expect(download).toMatch(/status !== LabOrderStatus\.VERIFIED/);
    expect(download).toMatch(/ForbiddenException/);
  });

  it('refuses to attach to an authorised report', () => {
    // Adding a file afterwards changes a document somebody may already have
    // acted on, without anybody re-authorising it.
    const upload = service.slice(service.indexOf('async upload('), service.indexOf('async forOrder('));
    expect(upload).toMatch(/LabOrderStatus\.VERIFIED/);
    expect(upload).toMatch(/ConflictException/);
  });

  it('refuses to remove from an authorised report', () => {
    const remove = service.slice(service.indexOf('async remove('));
    expect(remove).toMatch(/LabOrderStatus\.VERIFIED/);
    expect(remove).toMatch(/ConflictException/);
  });
});

describe('what is stored is what was sniffed', () => {
  it('never stores the declared mime type', () => {
    /*
     * The attack this closes: HTML uploaded as `report.pdf` with
     * `Content-Type: application/pdf`, stored with that type, served back with
     * it, and executed on this hospital's own origin.
     *
     * `file.mimetype` is multer's copy of what the client said. It must not
     * appear anywhere in the service.
     */
    expect(service).not.toMatch(/file\.mimetype/i);
    expect(service).toMatch(/mimeType: type\.mimeType/);
  });

  it('re-sniffs on the way out rather than trusting the stored type', () => {
    // Cheap, and it means a row written by anything other than this upload
    // path cannot cause bytes of unknown type to be served.
    const download = service.slice(service.indexOf('async download('), service.indexOf('async remove('));
    expect(download).toMatch(/sniffType\(/);
  });

  it('corrects a filename that lies about the content', () => {
    expect(service).toMatch(/safeFileName\(file\.originalname, type\.extension\)/);
  });
});

describe('how the response is written', () => {
  it('sets nosniff unconditionally', () => {
    /*
     * Without it a browser may ignore the declared type and guess from the
     * content — which hands the decision back to the file, and taking that
     * decision away from the file is the whole point.
     */
    expect(controller).toMatch(/X-Content-Type-Options.*nosniff/);
  });

  it('lets the rules decide inline versus attachment', () => {
    // The controller must not make this call itself: it depends on what the
    // content sniffed to, which is settled in the service.
    expect(controller).toMatch(/\$\{disposition\}; filename="\$\{fileName\}"/);
    expect(controller).not.toMatch(/'inline'/);
  });

  it('never caches', () => {
    // An attachment can be removed while a report is unsigned, and a stale
    // copy from a proxy is a document that disagrees with the system about a
    // patient's results.
    expect(controller).toMatch(/no-store/);
  });

  it('caps the upload at the interceptor as well as in the service', () => {
    /*
     * Two limits, deliberately. Multer stops a huge upload before it is
     * buffered — the one that protects the process — and the service produces
     * the message a technician can act on.
     */
    expect(controller).toMatch(/limits: \{ fileSize: MAX_ATTACHMENT_BYTES/);
    expect(service).toMatch(/MAX_ATTACHMENT_BYTES/);
  });
});

describe('who may do what', () => {
  it('lets only the laboratory upload or remove', () => {
    const upload = controller.slice(controller.indexOf("@Post('items/:itemId/attachments')"));
    expect(upload).toMatch(/@Roles\(UserRole\.LAB_TECHNICIAN\)/);

    const remove = controller.slice(controller.indexOf("@Delete('attachments/:id')"));
    expect(remove).toMatch(/@Roles\(UserRole\.LAB_TECHNICIAN\)/);
  });

  it('does not let reception download one', () => {
    /*
     * Unlike the *rendered* report, which reception prints for a patient to
     * carry. An arbitrary file a technician uploaded may be an analyser dump or
     * a working note, and nothing has decided it is fit to hand over.
     */
    const download = controller.slice(controller.indexOf("@Get('attachments/:id/file')"));
    expect(download).not.toMatch(/RECEPTIONIST/);
    expect(download).not.toMatch(/UserRole\.ADMIN/);
  });

  it('gives an administrator no route to a patient file at all', () => {
    // Admin is operational, not clinical — the line the whole access matrix
    // draws, and a laboratory report is as clinical as it gets.
    expect(controller).not.toMatch(/UserRole\.ADMIN/);
  });
});
