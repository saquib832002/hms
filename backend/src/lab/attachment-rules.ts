import { createHash } from 'node:crypto';

/**
 * Deciding whether a file is safe to store, and how it is safe to serve back.
 *
 * WHY THE DECLARED TYPE IS IGNORED
 * --------------------------------
 * `Content-Type` on a multipart part is chosen by the client. A file that
 * announces itself as `application/pdf` and contains HTML is the whole attack:
 * store it, serve it back with the type it claimed, and the browser runs it —
 * on this origin, with this hospital's session. So the type is read from the
 * file's own leading bytes and the declared one is used for nothing.
 *
 * That is not paranoia about outside attackers. The person uploading is a
 * member of staff, and the realistic version of this is somebody uploading the
 * wrong file, or a workstation that is already compromised. Either way the
 * defence is the same and costs nothing.
 *
 * THREE INDEPENDENT DEFENCES, BECAUSE ONE IS A SINGLE POINT OF FAILURE
 * -------------------------------------------------------------------
 *  1. The content is sniffed and anything unrecognised is refused outright.
 *  2. It is served with the sniffed type, never the declared one.
 *  3. Anything that is not a PDF is served as an attachment with `nosniff`, so
 *     even a signature this file matched wrongly cannot render in the page.
 *
 * WHAT IS ALLOWED, AND WHY IT IS A SHORT LIST
 * -------------------------------------------
 * PDF and Word, because that is what a laboratory actually hands over: a signed
 * report or an analyser printout. Images are absent deliberately — imaging
 * results are a real gap recorded in CLAUDE.md, and adding JPEG here would look
 * like closing it while storing a radiograph in a way no radiologist could use.
 */

/** 10 MB. A signed report is tens of kilobytes; a scanned one, a few megabytes. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface SniffedType {
  mimeType: string;
  extension: string;
  /**
   * Whether a browser may render it in place.
   *
   * True for PDF only. Everything else is served `attachment` with `nosniff`,
   * which means the worst case for a mis-sniffed file is a download nobody can
   * open rather than script executing on this origin.
   */
  inlineSafe: boolean;
  label: string;
}

/**
 * File signatures, checked against the first bytes.
 *
 * `.docx` is a ZIP container and shares its signature with every other ZIP, so
 * matching `PK\x03\x04` alone would accept a zip bomb renamed to .docx. The
 * container is confirmed by looking for the Word part name inside it, which is
 * present in the local file headers near the start of any real .docx.
 */
const PDF = Buffer.from('%PDF-');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** OLE2 compound file — the old binary `.doc`. */
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export function sniffType(content: Buffer): SniffedType | null {
  if (content.subarray(0, PDF.length).equals(PDF)) {
    return {
      mimeType: 'application/pdf',
      extension: 'pdf',
      // The only type a browser is allowed to render in place, and the only one
      // where doing so is useful — a doctor wants to read a report, not
      // download it.
      inlineSafe: true,
      label: 'PDF',
    };
  }

  if (content.subarray(0, ZIP.length).equals(ZIP)) {
    /*
     * Confirmed by content, not by extension. Every Office file, every .jar and
     * every renamed .zip has this signature; only a Word document names
     * `word/document.xml`. Searched in the first 4KB, which covers the local
     * headers of any real document — a file that hides it further in is not one
     * this system needs to accept.
     */
    const head = content.subarray(0, 4096).toString('latin1');
    if (head.includes('word/')) {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: 'docx',
        inlineSafe: false,
        label: 'Word document',
      };
    }
    return null;
  }

  if (content.subarray(0, OLE2.length).equals(OLE2)) {
    /*
     * The old binary `.doc`. Accepted because laboratories genuinely still
     * produce them, and refused rendering for the obvious reason: an OLE2
     * container can hold macros, and this system is storing it rather than
     * opening it.
     */
    return {
      mimeType: 'application/msword',
      extension: 'doc',
      inlineSafe: false,
      label: 'Word document',
    };
  }

  return null;
}

/**
 * Why a file was refused, in words the technician can act on.
 *
 * Separate from `sniffType` returning null, because "we could not tell what
 * this is" and "this is 40MB" want different responses and a single boolean
 * would flatten them into "upload failed".
 */
export function refusalFor(fileName: string, content: Buffer): string | null {
  if (content.length === 0) return 'That file is empty.';

  if (content.length > MAX_ATTACHMENT_BYTES) {
    const mb = (content.length / 1024 / 1024).toFixed(1);
    return `That file is ${mb} MB. The limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB — scan at a lower resolution, or split it.`;
  }

  if (!sniffType(content)) {
    /*
     * Names the extension it was given, because the commonest cause is the
     * wrong file rather than an unsupported one — somebody picks the scanner's
     * preview image instead of the report it produced.
     */
    const ext = extensionOf(fileName);
    return ext
      ? `A ${ext.toUpperCase()} file is not accepted here. Attach a PDF or a Word document — and check this is the file you meant, because the name and the contents did not match a type we recognise.`
      : 'That is not a PDF or a Word document.';
  }

  return null;
}

/**
 * A filename safe to put in a `Content-Disposition` header and on a screen.
 *
 * Strips directory separators, control characters and the quotes and newlines
 * that would let a crafted name inject a second header. Keeps it recognisable —
 * a technician looking for "Smith FBC 3rd.pdf" should still see roughly that.
 */
export function safeFileName(raw: string, extension: string): string {
  const base = raw
    .replace(/^.*[\\/]/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"'\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  const cleaned = base.length > 0 ? base : 'attachment';
  // The extension is taken from what the file actually IS, so a `.pdf` name on
  // a Word document is corrected rather than preserved.
  return cleaned.toLowerCase().endsWith(`.${extension}`) ? cleaned : `${cleaned}.${extension}`;
}

/**
 * How to send it back.
 *
 * `nosniff` unconditionally: without it a browser may ignore the declared type
 * and guess from the content, which puts the decision back in the hands of the
 * thing this module exists to take it away from.
 */
export function dispositionFor(type: SniffedType): 'inline' | 'attachment' {
  return type.inlineSafe ? 'inline' : 'attachment';
}

/**
 * SHA-256 of the content.
 *
 * Stored so a reader can confirm the file they downloaded is the file that was
 * uploaded — the question actually asked when a report is disputed, and one
 * that "the row says 412KB" cannot answer.
 */
export function checksumOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function extensionOf(fileName: string): string | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  return match ? match[1] : null;
}
