import PDFDocument from 'pdfkit';
import { DEV_FOOTER, Letterhead, logoBuffer } from './letterhead';

/**
 * The house style for everything this hospital prints.
 *
 * WHY pdfkit AND NOT A HEADLESS BROWSER
 * ------------------------------------
 * Rendering HTML with Chromium gives prettier layout for free and costs about
 * 300MB, a sandbox to keep patched, and a process that can hang. This service
 * already runs in a hospital's own building on whatever hardware they had; a
 * pure-JS renderer that draws a page deterministically is the better trade.
 *
 * WHY SERVER-SIDE AT ALL
 * ----------------------
 * A prescription printed from a phone must be byte-identical to one printed at
 * the front desk. The old renderer got that right by sending HTML both clients
 * displayed — but "the browser will make a PDF" varies by browser, by printer
 * driver and by margin settings, and a phone cannot reliably produce a file at
 * all. The document is the record, so the server makes it.
 */

/** A4 in points, which is pdfkit's unit. */
const MARGIN = 50;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = '#111111';
const MUTED = '#555555';
const RULE = '#cccccc';

export interface DocumentMeta {
  /** "Prescription", "Invoice", "Consultation note" — printed under the name. */
  kind: string;
  /** "#1042" — the reference a patient quotes on the phone. */
  reference: string;
  /** Filename offered to the browser, without extension. */
  fileName: string;
}

export type Renderer = (doc: PDFKit.PDFDocument) => void;

/**
 * Builds the whole document and resolves to its bytes.
 *
 * Buffered rather than streamed to the response on purpose: an error thrown
 * half way through a stream has already sent a 200 and part of a file, so the
 * client gets a corrupt PDF instead of an error it can show. Prescriptions are
 * a page or two; holding one in memory costs nothing worth optimising.
 */
export function renderDocument(
  letterhead: Letterhead,
  meta: DocumentMeta,
  body: Renderer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: {
        Title: `${meta.kind} ${meta.reference}`,
        Author: letterhead.hospitalName,
        Creator: letterhead.hospitalName,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      drawLetterhead(doc, letterhead, meta);
      body(doc);
      drawFooter(doc, letterhead);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * The header: logo, hospital name, address, contact, licence number.
 *
 * The hospital's name comes from the tenant row and from nowhere else. That is
 * the whole point of this file existing — see `letterhead.ts`.
 */
function drawLetterhead(doc: PDFKit.PDFDocument, head: Letterhead, meta: DocumentMeta) {
  const top = doc.y;
  let textLeft = MARGIN;

  /*
   * The logo is drawn first and never allowed to fail the document.
   *
   * A corrupt upload, or a format pdfkit cannot embed, must not turn "the admin
   * chose a bad file" into "prescriptions cannot be printed" — a failure the
   * doctor discovers and the administrator never hears about.
   */
  const logo = logoBuffer(head.logoDataUrl);
  if (logo) {
    try {
      doc.image(logo, MARGIN, top, { fit: [64, 64] });
      textLeft = MARGIN + 78;
    } catch {
      textLeft = MARGIN;
    }
  }

  const headerWidth = PAGE_WIDTH - textLeft - MARGIN;

  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(17)
    .text(head.hospitalName, textLeft, top, { width: headerWidth });

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  for (const line of head.addressLines) {
    doc.text(line, textLeft, doc.y, { width: headerWidth });
  }
  if (head.contactLine) doc.text(head.contactLine, textLeft, doc.y, { width: headerWidth });
  if (head.registrationNo) {
    doc.text(`Reg. no: ${head.registrationNo}`, textLeft, doc.y, { width: headerWidth });
  }

  // The rule sits below whichever is taller — a 64pt logo or four address
  // lines — so a clinic with a logo and no address does not get a line through
  // its own picture.
  const ruleY = Math.max(doc.y, logo ? top + 64 : top) + 10;

  doc
    .moveTo(MARGIN, ruleY)
    .lineTo(PAGE_WIDTH - MARGIN, ruleY)
    .lineWidth(1.4)
    .strokeColor(INK)
    .stroke();

  doc.y = ruleY + 12;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text(meta.kind.toUpperCase(), MARGIN, doc.y, { continued: true })
    .font('Helvetica')
    .fillColor(MUTED)
    .text(`   ${meta.reference}`);

  doc.moveDown(1);
}

function drawFooter(doc: PDFKit.PDFDocument, head: Letterhead) {
  /*
   * Drawn at a fixed distance from the bottom of the *current* page rather than
   * after the body, so it does not float up the page on a short prescription
   * or push a new page on a long one.
   */
  const y = doc.page.height - MARGIN - 34;

  doc
    .moveTo(MARGIN, y)
    .lineTo(PAGE_WIDTH - MARGIN, y)
    .lineWidth(0.5)
    .strokeColor(RULE)
    .stroke();

  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
  if (head.footerText) {
    doc.text(head.footerText, MARGIN, y + 6, { width: CONTENT_WIDTH, align: 'center' });
  }
  doc.text(DEV_FOOTER, MARGIN, doc.y + 1, { width: CONTENT_WIDTH, align: 'center' });
}

// ── building blocks the three documents share ──────────────────────────────

/** A heading inside the body. */
export function section(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.6);
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(title.toUpperCase(), MARGIN, doc.y, { characterSpacing: 0.6 });
  doc.moveDown(0.25);
}

/**
 * Two columns of label/value, as on the top of a paper form.
 *
 * Empty values are dropped rather than printed as a blank — a label with
 * nothing beside it reads as a field somebody failed to fill in, which on a
 * clinical document invites the wrong question.
 */
export function detailGrid(doc: PDFKit.PDFDocument, pairs: [string, string | null][]) {
  const rows = pairs.filter(([, v]) => v !== null && v !== '');
  const colWidth = CONTENT_WIDTH / 2 - 10;
  /*
   * Advance a whole line height per PAIR, not a fixed nudge per cell.
   *
   * The first version added 15pt on every even index, which is less than a
   * label plus a value — so the second row printed through the first and the
   * patient's name overlapped their date of birth. Only visible by rendering
   * the document and looking at it, which is what found it.
   */
  const LABEL_H = 10;
  const VALUE_H = 12;
  const ROW_H = LABEL_H + VALUE_H + 6;

  let y = doc.y;

  rows.forEach(([label, value], i) => {
    const leftColumn = i % 2 === 0;
    const x = leftColumn ? MARGIN : MARGIN + CONTENT_WIDTH / 2 + 10;
    if (leftColumn && i > 0) y += ROW_H;

    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(label, x, y, {
      width: colWidth,
      lineBreak: false,
    });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(String(value), x, y + LABEL_H, {
      width: colWidth,
      lineBreak: false,
    });
  });

  doc.y = rows.length === 0 ? y : y + ROW_H + 6;
}

export interface Column {
  header: string;
  /** Share of the content width. The columns should sum to 1. */
  width: number;
  align?: 'left' | 'right';
}

/**
 * A ruled table.
 *
 * Deliberately simple: no page-break handling beyond pdfkit's own, because a
 * prescription that needs a second page is already unusual and a half-drawn row
 * is worse than a page break in an awkward place.
 */
export function table(
  doc: PDFKit.PDFDocument,
  columns: Column[],
  rows: (string | null)[][],
) {
  const widths = columns.map((c) => c.width * CONTENT_WIDTH);
  /*
   * Running left edge per column: xs[0] = MARGIN, then each is the previous
   * plus the previous column's width.
   *
   * The first version was a `reduce` that read `acc[i]` while building `acc`,
   * so every column came out at the left margin and the medicine name printed
   * through the dosage. It typechecked and produced a valid PDF — the only way
   * to see it was to render a page and look.
   */
  const xs: number[] = [];
  widths.reduce((x, w, i) => {
    xs[i] = x;
    return x + w;
  }, MARGIN);

  let y = doc.y;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  columns.forEach((c, i) => {
    doc.text(c.header.toUpperCase(), xs[i], y, {
      width: widths[i] - 6,
      align: c.align ?? 'left',
      characterSpacing: 0.4,
    });
  });

  y += 13;
  doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).lineWidth(1).strokeColor(INK).stroke();
  y += 6;

  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  for (const row of rows) {
    let tallest = 0;
    row.forEach((cell, i) => {
      const text = cell ?? '';
      const h = doc.heightOfString(text, { width: widths[i] - 6 });
      tallest = Math.max(tallest, h);
      doc.text(text, xs[i], y, {
        width: widths[i] - 6,
        align: columns[i].align ?? 'left',
      });
    });
    y += tallest + 7;
    doc.moveTo(MARGIN, y - 3).lineTo(PAGE_WIDTH - MARGIN, y - 3).lineWidth(0.4).strokeColor(RULE).stroke();
  }

  doc.y = y + 4;
}

/** A ruled line for a wet signature, which most jurisdictions still want. */
export function signatureBlock(doc: PDFKit.PDFDocument, caption: string) {
  /*
   * Follows the content rather than being pinned near the bottom.
   *
   * Pinning it left a hand's width of blank paper on a two-item prescription,
   * which reads as a rendering fault rather than as a signing space — and on a
   * long one it collided with the footer.
   */
  const y = doc.y + 30;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + 210, y).lineWidth(0.8).strokeColor(INK).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(caption, MARGIN, y + 4);
  doc.y = y + 20;
}

export function paragraph(doc: PDFKit.PDFDocument, label: string, text: string) {
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(label, MARGIN, doc.y);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(INK)
    .text(text, MARGIN, doc.y + 2, { width: CONTENT_WIDTH });
}

export { MARGIN, CONTENT_WIDTH, INK, MUTED };
