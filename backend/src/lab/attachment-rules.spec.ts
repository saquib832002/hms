import {
  MAX_ATTACHMENT_BYTES,
  checksumOf,
  dispositionFor,
  refusalFor,
  safeFileName,
  sniffType,
} from './attachment-rules';

/**
 * What may be stored, and how it may be handed back.
 *
 * The tests that matter here are the refusals. A file that is accepted and
 * served with a type it chose for itself is stored XSS on the hospital's own
 * origin, and the person who uploads it is far more likely to be a technician
 * with the wrong file than an attacker.
 */

const pdf = (body = 'x') => Buffer.from(`%PDF-1.7\n${body}`);
const docx = () =>
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('....[Content_Types].xml....word/document.xml....'),
  ]);
const doc = () =>
  Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.from('old binary word'),
  ]);
const zipButNotWord = () =>
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('....holiday-photos/IMG_0001.JPG....'),
  ]);

describe('what the content says it is', () => {
  it('recognises a PDF', () => {
    expect(sniffType(pdf())).toMatchObject({ mimeType: 'application/pdf', inlineSafe: true });
  });

  it('recognises a .docx by looking inside the container', () => {
    /*
     * A .docx is a ZIP, and so is a .jar, an .apk and any renamed archive.
     * Matching the ZIP signature alone would accept all of them — including a
     * zip bomb — so the Word part name has to be present.
     */
    expect(sniffType(docx())).toMatchObject({ extension: 'docx', inlineSafe: false });
  });

  it('refuses a ZIP that is not a Word document', () => {
    expect(sniffType(zipButNotWord())).toBeNull();
  });

  it('recognises the old binary .doc', () => {
    expect(sniffType(doc())).toMatchObject({ extension: 'doc', inlineSafe: false });
  });

  it('refuses everything else', () => {
    for (const content of [
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // JPEG
      Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
      Buffer.from('plain text'),
      Buffer.alloc(0),
    ]) {
      expect(sniffType(content)).toBeNull();
    }
  });

  it('ignores what the file calls itself', () => {
    /*
     * THE TEST THIS FILE EXISTS FOR.
     *
     * HTML uploaded as `report.pdf` with `Content-Type: application/pdf`. The
     * declared type is never consulted, so this is refused on its content —
     * and had it been trusted, the file would have come back rendered as a
     * document on this hospital's own origin.
     */
    const html = Buffer.from('<html><script>fetch("/api/v1/patients")</script></html>');
    expect(sniffType(html)).toBeNull();
    expect(refusalFor('report.pdf', html)).toBeTruthy();
  });
});

describe('what is refused, and what it says', () => {
  it('refuses an empty file', () => {
    expect(refusalFor('report.pdf', Buffer.alloc(0))).toContain('empty');
  });

  it('refuses one over the cap, and says how far over', () => {
    // A number the technician can act on — "scan at a lower resolution" is
    // only useful advice next to the size that was too big.
    const big = Buffer.concat([pdf(), Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    const refusal = refusalFor('scan.pdf', big);
    expect(refusal).toMatch(/MB/);
    expect(refusal).toMatch(/limit is 10 MB/);
  });

  it('names the extension it was handed, because the usual cause is the wrong file', () => {
    // Somebody picks the scanner's preview image instead of the report.
    expect(refusalFor('preview.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toContain('JPG');
  });

  it('accepts the two things a laboratory actually hands over', () => {
    expect(refusalFor('report.pdf', pdf())).toBeNull();
    expect(refusalFor('report.docx', docx())).toBeNull();
  });
});

describe('how it is served back', () => {
  it('renders only a PDF in place', () => {
    expect(dispositionFor(sniffType(pdf())!)).toBe('inline');
  });

  it('makes everything else a download', () => {
    /*
     * The third defence, and the one that holds if the first two are wrong. A
     * Word document rendered in place would be a download anyway; the point is
     * that a file this module mis-sniffed cannot execute in the page.
     */
    expect(dispositionFor(sniffType(docx())!)).toBe('attachment');
    expect(dispositionFor(sniffType(doc())!)).toBe('attachment');
  });
});

describe('the filename', () => {
  it('keeps something a technician would recognise', () => {
    expect(safeFileName('Smith FBC 3rd.pdf', 'pdf')).toBe('Smith FBC 3rd.pdf');
  });

  it('strips any path it was given', () => {
    expect(safeFileName('C:\\Users\\lab\\report.pdf', 'pdf')).toBe('report.pdf');
    expect(safeFileName('../../etc/passwd', 'pdf')).toBe('passwd.pdf');
  });

  it('strips what would break the header it goes into', () => {
    /*
     * `Content-Disposition: attachment; filename="…"`. A quote or a newline in
     * the name is header injection, and the payload is a filename nobody looks
     * at twice.
     */
    const nasty = safeFileName('re"port\r\nX-Injected: 1.pdf', 'pdf');
    expect(nasty).not.toMatch(/["\r\n]/);
  });

  it('corrects an extension that lies about the content', () => {
    // A Word document named `.pdf` is saved as `.pdf.docx`, so what the reader
    // downloads opens in the program that can read it.
    expect(safeFileName('report.pdf', 'docx')).toBe('report.pdf.docx');
  });

  it('never produces an empty name', () => {
    expect(safeFileName('   ', 'pdf')).toBe('attachment.pdf');
    expect(safeFileName('/', 'pdf')).toBe('attachment.pdf');
  });
});

describe('the checksum', () => {
  it('is stable and content-dependent', () => {
    expect(checksumOf(pdf('a'))).toBe(checksumOf(pdf('a')));
    expect(checksumOf(pdf('a'))).not.toBe(checksumOf(pdf('b')));
    expect(checksumOf(pdf())).toHaveLength(64);
  });
});
