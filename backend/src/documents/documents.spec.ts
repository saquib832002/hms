import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { buildLetterhead, isUsableLogo, logoBuffer, DEV_FOOTER } from './letterhead';
import { LetterheadController, UpdateLetterheadDto } from './letterhead.controller';
import { tenantStorage } from '../common/tenancy/tenant-context';
import { detailGrid, renderDocument, section, table } from './pdf';

/**
 * A printed document belongs to the hospital that printed it.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `renderPrintable` had `<h1>Meridian Hospital</h1>` written into it — the demo
 * seed's name, printed on every tenant's prescriptions. A patient walked into a
 * pharmacy holding a document naming a hospital they had never attended, and a
 * pharmacist has no way to tell a rendering fault from a forgery.
 *
 * Every other surface in this system is tenant-scoped by construction. The one
 * artefact that leaves the building was a string literal.
 */

const DOCS = path.resolve(__dirname);

/** Comments describe the rule and would match the assertions below. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const sourceOf = (f: string) => strip(readFileSync(path.join(DOCS, f), 'utf8'));

const bareTenant = {
  name: 'New Clinic',
  addressLine1: null,
  addressLine2: null,
  city: null,
  postcode: null,
  country: null,
  contactPhone: null,
  contactEmail: null,
  website: null,
  registrationNo: null,
  footerText: null,
  logoDataUrl: null,
};

describe('the letterhead comes from the tenant', () => {
  it('hard-codes no hospital name anywhere in the document code', () => {
    /*
     * The load-bearing assertion. Any literal that looks like a hospital name
     * in a renderer is the bug coming back — and it comes back the moment
     * somebody wants a nicer-looking default than a bare tenant row.
     */
    const files = readdirSync(DOCS).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    expect(files.length).toBeGreaterThan(2);

    const offenders = files.filter((f) =>
      /Meridian|Hospital'|"Hospital|General Hospital|Medical Cent/i.test(sourceOf(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('reads the name from the row it is given', () => {
    const head = buildLetterhead({ ...bareTenant, name: 'Sunrise Multispecialty' });
    expect(head.hospitalName).toBe('Sunrise Multispecialty');
  });

  it('selects the letterhead columns from the calling tenant only', () => {
    // `currentTenantId()` and nothing from the request. A tenant id accepted
    // from a client would be a one-line route into another hospital's identity
    // — printed onto a document that leaves the building.
    const service = sourceOf('documents.service.ts');
    expect(service).toMatch(/where:\s*\{\s*id:\s*currentTenantId\(\)\s*\}/);
    expect(service).not.toMatch(/unscoped/);
  });
});

describe('a sparse letterhead still prints', () => {
  it('degrades rather than refusing', () => {
    /*
     * A hospital's first day should not require a settings form to be
     * completed before anybody can be given medicine. A prescription that will
     * not print is worse than one with a thin header.
     */
    const head = buildLetterhead(bareTenant);
    expect(head.hospitalName).toBe('New Clinic');
    expect(head.addressLines).toEqual([]);
    expect(head.contactLine).toBeNull();
    expect(head.logoDataUrl).toBeNull();
  });

  it('drops empty address lines rather than printing gaps', () => {
    const head = buildLetterhead({
      ...bareTenant,
      addressLine1: '14 Anna Salai',
      addressLine2: '   ',
      city: 'Chennai',
      postcode: '600018',
    });
    // City and postcode share a line, as on an envelope — two lines with one
    // word each reads as a mistake on a printed page.
    expect(head.addressLines).toEqual(['14 Anna Salai', 'Chennai 600018']);
  });

  it('joins only the contact details that exist', () => {
    expect(buildLetterhead({ ...bareTenant, contactPhone: '+91 44 5555 0100' }).contactLine).toBe(
      '+91 44 5555 0100',
    );
    expect(buildLetterhead({ ...bareTenant, contactEmail: '  ' }).contactLine).toBeNull();
  });
});

describe('the logo cannot break a prescription', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('accepts PNG and JPEG data URLs', () => {
    expect(isUsableLogo(PNG)).toBe(true);
    expect(isUsableLogo('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBe(true);
  });

  it('refuses anything pdfkit cannot embed', () => {
    /*
     * An SVG or a WebP reaches `doc.image()` and throws — which turns "the
     * admin picked the wrong file type" into "prescriptions cannot be
     * printed", found by a doctor rather than by the person who uploaded it.
     */
    expect(isUsableLogo('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(false);
    expect(isUsableLogo('data:image/webp;base64,UklGRg==')).toBe(false);
  });

  it('refuses a remote URL', () => {
    /*
     * Fetching one would make printing depend on a third-party host staying
     * up, and would let an administrator point the renderer at an arbitrary
     * address from inside the hospital's own network.
     */
    expect(isUsableLogo('https://example.com/logo.png')).toBe(false);
    expect(isUsableLogo('file:///etc/passwd')).toBe(false);
  });

  it('returns no buffer for a value it will not embed', () => {
    expect(logoBuffer(null)).toBeNull();
    expect(logoBuffer('https://example.com/logo.png')).toBeNull();
    expect(logoBuffer(PNG)).toBeInstanceOf(Buffer);
  });

  it('still produces a PDF when the stored logo is corrupt', async () => {
    const head = buildLetterhead({
      ...bareTenant,
      logoDataUrl: 'data:image/png;base64,NOTREALLYANIMAGE==',
    });
    const pdf = await renderDocument(
      head,
      { kind: 'Prescription', reference: '#1', fileName: 'x' },
      (doc) => detailGrid(doc, [['Patient', 'A Patient']]),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('the rendered document', () => {
  it('is a real PDF', async () => {
    const head = buildLetterhead({ ...bareTenant, name: 'Sunrise Multispecialty' });
    const pdf = await renderDocument(
      head,
      { kind: 'Prescription', reference: '#1042', fileName: 'p' },
      (doc) => {
        detailGrid(doc, [
          ['Patient', 'Meera Krishnan'],
          ['Date', '04/09/2026'],
        ]);
        section(doc, 'Medicines');
        table(
          doc,
          [
            { header: 'Medicine', width: 0.5 },
            { header: 'Dosage', width: 0.5 },
          ],
          [['Amoxicillin 500mg', '1 capsule']],
        );
      },
    );

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(800);
  });

  it('carries the development warning while this is a development build', () => {
    // CLAUDE.md's rule is dummy data only until the deployment is BAA-covered,
    // and a printed document is the one artefact that escapes the system
    // entirely — so it says so on its face. Removing this is a deliberate act
    // tied to that move, not a tidy-up.
    expect(DEV_FOOTER).toMatch(/NOT A VALID DOCUMENT/);
    expect(sourceOf('pdf.ts')).toContain('DEV_FOOTER');
  });

  it('does not call every document a prescription', () => {
    /*
     * It said `NOT A VALID PRESCRIPTION` for as long as prescriptions were the
     * only thing this renderer produced, and it was still saying it at the foot
     * of a monthly statement addressed to another company. Found by rendering
     * one and looking at it — the third fault in this renderer that no test
     * would have caught, after the detail grid printing a name through a date
     * of birth and the table starting every column at the left margin.
     */
    expect(DEV_FOOTER).not.toMatch(/PRESCRIPTION/);
  });
});

describe('a printed invoice obeys the same role rule as the response', () => {
  it('shapes the lines rather than printing the rows', () => {
    /*
     * **A drug name may appear on an invoice and may never appear in a
     * response to BILLING_STAFF** — the rule `invoice-response.ts` enforces at
     * layer 3. A PDF is a response. Printing `item.description` straight from
     * the row would hand a billing clerk the itemised medicine list the API
     * withholds, on a document they can file and re-read.
     */
    const service = sourceOf('documents.service.ts');
    expect(service).toMatch(/shapeInvoiceItems\(/);
    // The shaped lines are what reaches the table, not `inv.items`.
    expect(service).not.toMatch(/inv\.items\s*\?\?\s*\[\]\)\.map\(\(i\)\s*=>\s*\[/);
  });

  it('takes the role from the authenticated user', () => {
    const controller = sourceOf('documents.controller.ts');
    expect(controller).toMatch(/invoicePdf\(id,\s*user\.role\)/);
  });
});

describe('who may print what', () => {
  const controller = sourceOf('documents.controller.ts');

  it('lets reception print a prescription without reading it as data', () => {
    // The same split `GET /prescriptions/:id` already makes: reception is not
    // on that route and is on this one.
    expect(controller).toMatch(
      /@Roles\(UserRole\.DOCTOR,\s*UserRole\.RECEPTIONIST,\s*UserRole\.PHARMACIST\)/,
    );
  });

  it('keeps admin off every clinical document', () => {
    /*
     * A printed document is the most complete form of the record there is, and
     * admin is operational rather than clinical. Admin appears on the invoice
     * route — money is theirs — and on neither of the other two.
     */
    const clinicalBlocks = controller
      .split('@Get(')
      .filter((b) => b.includes('prescriptions/:id/pdf') || b.includes('records/:id/pdf'));
    expect(clinicalBlocks.length).toBe(2);
    for (const block of clinicalBlocks) expect(block).not.toMatch(/UserRole\.ADMIN/);
  });
});

describe('saving the letterhead', () => {
  /**
   * THE BUG THIS EXISTS FOR
   * -----------------------
   * The screen loads the letterhead, edits some of it, and sends the whole
   * thing back — so every field the hospital has never filled in arrives as
   * `null`, because that is what the GET returned. `@IsOptional()` accepts null
   * as well as undefined, so those values passed validation and reached a
   * handler that called `.trim()` on them.
   *
   * `TypeError: Cannot read properties of null (reading 'trim')` — a 500 on
   * the ordinary path of the ordinary screen, because a hospital with a
   * complete letterhead is the rare case and one with blanks is every new
   * tenant.
   *
   * Every other test in this file reads source or renders a PDF. Neither shape
   * could have caught this: the code looked right and the types were satisfied
   * because the DTO claimed a nullable field was a string. So this one runs the
   * validation pipe and the handler against the payload the client actually
   * sends.
   */
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  });
  const meta = { type: 'body' as const, metatype: UpdateLetterheadDto };

  /**
   * Runs the handler inside a tenant scope, as `TenantInterceptor` does.
   *
   * `currentTenantId()` throws outside one — deliberately, because inventing a
   * tenant and writing a row into the wrong hospital is the failure nothing
   * downstream would detect. So the fixture has to establish it, exactly as a
   * real request would.
   */
  const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantStorage.run({ tenantId: 1, tx: {} as never }, fn);

  /** Captures what would be written, without a database. */
  function fakePrisma() {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      tenant: {
        update: (args: { data: Record<string, unknown> }) => {
          calls.push(args.data);
          return Promise.resolve({});
        },
        findUnique: () => Promise.resolve({ name: 'A Clinic' }),
      },
    };
  }

  it('accepts the exact payload the settings screen sends back', async () => {
    // A new tenant: name filled in at provisioning, everything else null.
    const fromScreen = {
      addressLine1: '14 Anna Salai',
      addressLine2: null,
      city: null,
      postcode: null,
      country: null,
      contactPhone: null,
      contactEmail: null,
      website: null,
      registrationNo: null,
      footerText: null,
      logoDataUrl: null,
    };

    const dto = (await pipe.transform(fromScreen, meta)) as UpdateLetterheadDto;
    expect(dto.addressLine1).toBe('14 Anna Salai');

    const prisma = fakePrisma();
    const controller = new LetterheadController(prisma as never);
    await expect(inScope(() => controller.update(dto))).resolves.toBeDefined();

    const written = prisma.calls[0];
    expect(written.addressLine1).toBe('14 Anna Salai');
    // null in, null written — not a crash, and not the string "null".
    expect(written.city).toBeNull();
    expect(written.logoDataUrl).toBeNull();
  });

  it('leaves a column alone when its key is absent', async () => {
    // The distinction the handler exists to make: absent is untouched, null
    // and empty both clear. Collapsing them would mean a partial update
    // silently wiped every field the screen did not send.
    const dto = (await pipe.transform({ city: 'Chennai' }, meta)) as UpdateLetterheadDto;
    const prisma = fakePrisma();
    await inScope(() => new LetterheadController(prisma as never).update(dto));

    const written = prisma.calls[0];
    expect(written.city).toBe('Chennai');
    expect(written.addressLine1).toBeUndefined();
  });

  it('clears a field the administrator emptied', async () => {
    const dto = (await pipe.transform({ footerText: '   ' }, meta)) as UpdateLetterheadDto;
    const prisma = fakePrisma();
    await inScope(() => new LetterheadController(prisma as never).update(dto));
    expect(prisma.calls[0].footerText).toBeNull();
  });

  it('lets the logo be removed', async () => {
    /*
     * The regex allows an empty string, and it is load-bearing: an admin
     * removes the logo by sending "". Without that alternative the pattern
     * refuses it and the only way back from a bad upload is a database
     * console — which is exactly the "no way to undo" the handler's own
     * comment promises against.
     */
    const dto = (await pipe.transform({ logoDataUrl: '' }, meta)) as UpdateLetterheadDto;
    const prisma = fakePrisma();
    await inScope(() => new LetterheadController(prisma as never).update(dto));
    expect(prisma.calls[0].logoDataUrl).toBeNull();
  });

  it('still refuses a logo format the PDF cannot embed', async () => {
    await expect(
      pipe.transform({ logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, meta),
    ).rejects.toThrow();
  });
});
