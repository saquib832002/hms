import PDFDocument from 'pdfkit';
import { code128Widths } from '../lab/code128';

/**
 * Specimen labels — the sticker that goes round the tube.
 *
 * WHY THIS IS ITS OWN RENDERER AND NOT A `renderDocument` CALL
 * -----------------------------------------------------------
 * Everything else in this folder is an A4 page with a letterhead. A specimen
 * label is 50 × 25mm, has no margins worth the name, and is printed on a
 * thermal roll — the shared renderer's header, footer and page furniture are
 * all wrong for it, and forcing it through would mean a page of settings that
 * exist only to be switched off.
 *
 * WHAT IS ON THE LABEL, AND WHAT DELIBERATELY IS NOT
 * --------------------------------------------------
 * On it: the barcode, the accession in human-readable form under it, the
 * patient's name and date of birth, the specimen type, the tests, and the date.
 * A technician holding a rack of tubes has to be able to tell them apart
 * without scanning every one, so the human-readable part is not decoration.
 *
 * **In the barcode: the accession and nothing else.** Not the name, not the
 * date of birth, not the tests. A specimen label is handled by couriers, sits
 * in open racks and ends up in clinical waste; encoding identifiers into it
 * turns every discarded tube into a data breach. The barcode is a key and the
 * system holds the record — which is what every laboratory accreditation
 * scheme requires and what every real LIS does.
 *
 * ONE LABEL PER SPECIMEN, NOT PER TEST
 * ------------------------------------
 * A full blood count and a clotting screen go in different tubes; a sodium and
 * a potassium go in the same one. So the labels are grouped by
 * `LabSpecimenType`, and the tests sharing a tube are listed on that tube's
 * label. Printing one per test would have a phlebotomist drawing four tubes
 * where two were needed, which is a real harm to the patient in the chair.
 *
 * `NONE` — imaging — produces no label at all. There is no specimen to stick it
 * to, and a label with nowhere to go is one that ends up on the wrong thing.
 */

/** 50 × 25mm at 72dpi, the commonest thermal specimen label. */
const LABEL_WIDTH = 141.7;
const LABEL_HEIGHT = 70.9;
const PAD = 5;

export interface LabelSpecimen {
  /** The number encoded in the barcode and printed beneath it. */
  accession: string;
  specimenType: string;
  tests: string[];
}

export interface LabelPatient {
  fullName: string;
  dob: Date | null;
}

/**
 * Draw one Code 128 symbol as filled rectangles.
 *
 * Rectangles rather than an embedded image, because pdfkit draws vectors at the
 * printer's own resolution — a rasterised barcode scaled to a 50mm label picks
 * up edge artefacts at exactly the sizes that stop it scanning.
 */
function barcode(
  doc: PDFKit.PDFDocument,
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const widths = code128Widths(value);
  const totalModules = widths.reduce((a, b) => a + b, 0);
  const module = width / totalModules;

  let cursor = x;
  widths.forEach((w, i) => {
    // Even indices are bars, odd are spaces — the pattern starts on a bar.
    if (i % 2 === 0) doc.rect(cursor, y, w * module, height).fill('#000');
    cursor += w * module;
  });
}

/**
 * A sheet of specimen labels for one order.
 *
 * One page per label, sized to the label, because that is what a thermal roll
 * printer expects — an A4 sheet with labels tiled on it is a different product
 * and a different setting, and guessing which the hospital has would put a
 * barcode across a perforation.
 */
export function renderSpecimenLabels(
  patient: LabelPatient,
  specimens: LabelSpecimen[],
  hospitalName: string,
): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: [LABEL_WIDTH, LABEL_HEIGHT],
    margin: 0,
    autoFirstPage: false,
  });

  for (const specimen of specimens) {
    doc.addPage({ size: [LABEL_WIDTH, LABEL_HEIGHT], margin: 0 });

    /*
     * The hospital, small, at the top. A specimen that has travelled to a
     * reference laboratory is sitting in a rack beside other hospitals' tubes,
     * and "whose is this" is the first question asked about a stray one.
     */
    doc.fontSize(5).fillColor('#444').text(hospitalName, PAD, PAD, {
      width: LABEL_WIDTH - PAD * 2,
      lineBreak: false,
    });

    /*
     * The patient, in the largest type on the label.
     *
     * Bigger than the accession deliberately: the number is what the scanner
     * reads, and the name is what stops a human putting the label on the wrong
     * tube in the first place. Mis-labelling at the point of draw is the
     * commonest serious error in phlebotomy and no barcode can catch it.
     */
    doc
      .fontSize(8)
      .fillColor('#000')
      .text(patient.fullName, PAD, PAD + 6, { width: LABEL_WIDTH - PAD * 2, lineBreak: false });

    doc.fontSize(5.5).fillColor('#444').text(
      [
        patient.dob ? `DOB ${patient.dob.toISOString().slice(0, 10)}` : 'DOB not recorded',
        specimen.specimenType.toLowerCase(),
      ].join('  ·  '),
      PAD,
      PAD + 16,
      { width: LABEL_WIDTH - PAD * 2, lineBreak: false },
    );

    barcode(doc, specimen.accession, PAD, PAD + 23, LABEL_WIDTH - PAD * 2, 22);

    /*
     * The accession in readable characters under the barcode, always.
     *
     * A smudged or torn label is exactly when somebody needs to type the number
     * in, and it is the case a barcode alone cannot serve. This is why the
     * accession carries a check character at all.
     */
    doc
      .fontSize(7)
      .fillColor('#000')
      .text(specimen.accession, PAD, PAD + 47, {
        width: LABEL_WIDTH - PAD * 2,
        align: 'center',
        lineBreak: false,
      });

    /*
     * The tests in this tube, truncated rather than wrapped. A label has one
     * line for this and overflow would push the barcode off the sticker — and
     * the full list is a scan away.
     */
    doc.fontSize(5).fillColor('#444').text(specimen.tests.join(', '), PAD, PAD + 56, {
      width: LABEL_WIDTH - PAD * 2,
      height: 6,
      ellipsis: true,
      lineBreak: false,
    });
  }

  return doc;
}

/**
 * Group an order's tests into the tubes they actually go in.
 *
 * Imaging (`NONE`) is dropped: there is no specimen, so there is nothing to
 * label, and a sticker with nowhere to go ends up on the wrong thing.
 */
export function groupSpecimens(
  accession: string,
  items: { testName: string; specimenType: string }[],
): LabelSpecimen[] {
  const byType = new Map<string, string[]>();

  for (const item of items) {
    if (item.specimenType === 'NONE') continue;
    const list = byType.get(item.specimenType) ?? [];
    list.push(item.testName);
    byType.set(item.specimenType, list);
  }

  /*
   * Every tube from one order carries the same accession.
   *
   * A per-tube suffix was considered and rejected: it needs a `LabSpecimen`
   * row to be meaningful, and without one the suffix is a number the system
   * cannot resolve — a scan that lands nowhere is worse than a scan that lands
   * on the order and lets the technician pick the tube. If per-tube tracking is
   * ever needed, that model is where it belongs.
   */
  return [...byType.entries()].map(([specimenType, tests]) => ({
    accession,
    specimenType,
    tests,
  }));
}
