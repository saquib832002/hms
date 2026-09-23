/**
 * What a hospital prints at the top of anything a patient carries away.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `renderPrintable` had `<h1>Meridian Hospital</h1>` written into it — the demo
 * seed's name, printed on every tenant's prescriptions. Not a cosmetic defect:
 * a patient walked into a pharmacy holding a document naming a hospital they
 * had never attended, and a pharmacist has no way to tell a rendering fault
 * from a forgery. Every other surface in this system is tenant-scoped by
 * construction; the one document that leaves the building was not.
 *
 * ONE SHAPE, THREE DOCUMENTS
 * --------------------------
 * A prescription, an invoice and a consultation note all go home with the
 * patient on the same paper. Resolving the letterhead once means they cannot
 * disagree about the hospital's own address — which is the sort of difference
 * nobody notices until a patient posts a cheque to a building the clinic left
 * two years ago.
 */

export interface Letterhead {
  hospitalName: string;
  /** Address as printed, already ordered and stripped of empty lines. */
  addressLines: string[];
  contactLine: string | null;
  /** The hospital's own licence number, printed in the header. */
  registrationNo: string | null;
  footerText: string | null;
  /** `data:image/png;base64,...`, or null when none has been uploaded. */
  logoDataUrl: string | null;
}

/** The columns a document needs. Deliberately not what a request needs. */
export interface LetterheadSource {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  registrationNo: string | null;
  footerText: string | null;
  logoDataUrl: string | null;
}

/**
 * Builds the printable letterhead from a tenant row.
 *
 * **Every field except the name is optional, and the result degrades rather
 * than refusing.** A clinic that has filled none still prints a usable document
 * headed with its own name — which tenancy already guaranteed — because a
 * prescription that will not print is worse than one with a sparse header, and
 * a hospital's first day should not require a settings form to be completed
 * before anybody can be given medicine.
 */
export function buildLetterhead(t: LetterheadSource): Letterhead {
  const addressLines = [
    t.addressLine1,
    t.addressLine2,
    // City and postcode share a line, as on an envelope. Joined rather than
    // stacked because a two-line address with one word on each reads as a
    // mistake on a printed page.
    [t.city, t.postcode].filter(Boolean).join(' ') || null,
    t.country,
  ]
    .map((l) => l?.trim())
    .filter((l): l is string => !!l);

  const contactLine =
    [t.contactPhone, t.contactEmail, t.website]
      .map((v) => v?.trim())
      .filter(Boolean)
      .join('  ·  ') || null;

  return {
    hospitalName: t.name,
    addressLines,
    contactLine,
    registrationNo: t.registrationNo?.trim() || null,
    footerText: t.footerText?.trim() || null,
    logoDataUrl: isUsableLogo(t.logoDataUrl) ? t.logoDataUrl!.trim() : null,
  };
}

/**
 * Only PNG and JPEG, and only as a data URL.
 *
 * pdfkit embeds those two and nothing else — an SVG or a WebP reaches
 * `doc.image()` and throws, which would turn "the admin uploaded the wrong file
 * type" into "prescriptions cannot be printed", discovered by a doctor rather
 * than by the person who uploaded it. Rejected at the boundary and again here,
 * because the column may hold a value written before this check existed.
 *
 * An `http(s)` URL is deliberately not accepted: fetching it would make
 * printing depend on a third-party host being up, and would let an
 * administrator point the renderer at an arbitrary address from inside the
 * hospital's own network.
 */
export function isUsableLogo(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/.test(value.trim());
}

/** Decoded bytes for pdfkit, or null if the value is not one we can embed. */
export function logoBuffer(dataUrl: string | null): Buffer | null {
  if (!isUsableLogo(dataUrl)) return null;
  const base64 = dataUrl!.slice(dataUrl!.indexOf(',') + 1).replace(/\s/g, '');
  try {
    return Buffer.from(base64, 'base64');
  } catch {
    // A corrupt data URL must not take a prescription down with it.
    return null;
  }
}

/**
 * The line every printed document carries while this is a development build.
 *
 * CLAUDE.md's rule is dummy data only until the deployment is BAA-covered, and
 * a printed document is the one artefact that escapes the system entirely — so
 * it says so on its face. Removing this is a deliberate act tied to that move,
 * not a tidy-up.
 *
 * **It says "document", not "prescription", and that is not cosmetic.** It read
 * `NOT A VALID PRESCRIPTION` for as long as prescriptions were the only thing
 * this renderer produced, and it was still saying it at the foot of a monthly
 * statement addressed to another company — a page about money, calling itself
 * a prescription. Only visible by rendering one and looking at it, which is the
 * lesson this file already carries twice: a detail grid that printed a name
 * through a date of birth, and a table whose columns all started at the left
 * margin. Both typechecked and both produced a valid PDF.
 */
export const DEV_FOOTER = 'DEVELOPMENT BUILD — DUMMY DATA, NOT A VALID DOCUMENT';
