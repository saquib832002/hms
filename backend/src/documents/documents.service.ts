import { Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { shapeInvoiceItems } from '../billing/invoice-response';
import { accessionsIn } from '../lab/lab-charge';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';
import { buildLetterhead, Letterhead } from './letterhead';
import {
  detailGrid,
  paragraph,
  renderDocument,
  section,
  signatureBlock,
  table,
} from './pdf';
import { hospitalDate } from '../common/utils/hospital-time';
import { groupSpecimens, renderSpecimenLabels } from './specimen-label';
import { LabService, StatementPeriodQuery } from '../lab/lab.service';

/**
 * Everything this hospital prints and hands to a patient.
 *
 * One service for three documents because they share a letterhead, and the
 * failure this guards against is them disagreeing about it — a prescription and
 * an invoice from the same visit showing different addresses is the sort of
 * thing nobody notices until a patient posts a cheque to a building the clinic
 * left two years ago.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private prisma: PrismaService,
    private clinic: ClinicSettingsService,
    /** Only for `ensureAccession` — see the note on `DocumentsModule`. */
    private lab: LabService,
  ) {}

  /**
   * The calling hospital's letterhead.
   *
   * Read through the request's own transaction like everything else — `tenants`
   * carries no RLS policy, so this returns the same row either way, and going
   * through `unscoped` would ask the pool for a second connection while the
   * first is still held. That was the deadlock; see `prisma.service.ts`.
   *
   * `logoDataUrl` is selected here and deliberately *not* in
   * `ClinicSettingsService`, which runs on nearly every request. A logo is
   * wanted when a document is printed and never otherwise.
   */
  private async letterhead(): Promise<Letterhead> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: currentTenantId() },
      select: {
        name: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postcode: true,
        country: true,
        contactPhone: true,
        contactEmail: true,
        website: true,
        registrationNo: true,
        footerText: true,
        logoDataUrl: true,
      },
    });
    if (!t) throw new NotFoundException('Hospital not found');
    return buildLetterhead(t);
  }

  /** Dates on a printed document follow the hospital's clock, not the server's. */
  private async localDate(instant: Date): Promise<string> {
    const tz = (await this.clinic.current()).timezone;
    const { year, month, day } = hospitalDate(instant, tz);
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  }

  // ───────────────────────────────────────────────────────────── prescription

  async prescriptionPdf(id: number): Promise<{ pdf: Buffer; fileName: string }> {
    const p = await this.prisma.prescription.findUnique({
      where: { id },
      include: {
        items: true,
        patient: { select: { id: true, fullName: true, dob: true, gender: true, phone: true } },
        doctor: {
          select: {
            fullName: true,
            specialization: true,
            qualifications: true,
            registrationNo: true,
          },
        },
      },
    });
    if (!p) throw new NotFoundException(`Prescription ${id} not found`);

    const head = await this.letterhead();
    const issued = await this.localDate(p.issuedAt as Date);
    const dob = p.patient?.dob ? await this.localDate(p.patient.dob as Date) : null;

    const pdf = await renderDocument(
      head,
      { kind: 'Prescription', reference: `#${p.id}`, fileName: `prescription-${p.id}` },
      (doc) => {
        detailGrid(doc, [
          ['Patient', p.patient?.fullName ?? ''],
          ['Date', issued],
          ['Date of birth', dob],
          ['Patient ID', String(p.patient?.id ?? '')],
        ]);

        /*
         * The prescriber block sits with the medicines rather than in the
         * header. The header is the hospital; this is the person who takes
         * clinical responsibility for what follows, and on a paper pad the two
         * are printed apart for exactly that reason.
         */
        section(doc, 'Prescriber');
        detailGrid(doc, [
          ['Name', p.doctor?.fullName ?? ''],
          ['Registration no', p.doctor?.registrationNo ?? null],
          ['Qualifications', p.doctor?.qualifications ?? null],
          ['Specialty', p.doctor?.specialization ?? null],
        ]);

        section(doc, '℞  Medicines');
        table(
          doc,
          [
            { header: 'Medicine', width: 0.34 },
            { header: 'Dosage', width: 0.2 },
            { header: 'Frequency', width: 0.26 },
            { header: 'Duration', width: 0.2 },
          ],
          (p.items ?? []).map((i) => [i.medicineName, i.dosage, i.frequency, i.duration]),
        );

        if (p.notes) paragraph(doc, 'Instructions', p.notes);

        /*
         * A cancelled prescription still prints, and says so.
         *
         * Refusing would leave somebody holding a piece of paper the system
         * will not talk about — and "why was this withdrawn" is asked exactly
         * when a copy has already left the building.
         */
        if (p.status === 'CANCELLED') {
          paragraph(doc, 'Withdrawn', 'This prescription was cancelled and must not be dispensed.');
        }

        signatureBlock(doc, `${p.doctor?.fullName ?? 'Prescriber'} — signature`);
      },
    );

    return { pdf, fileName: `prescription-${p.id}.pdf` };
  }

  // ───────────────────────────────────────────────────────────────── invoice

  /**
   * A printed invoice obeys the same role rule as the API response.
   *
   * **A drug name may appear on an invoice and may never appear in a response
   * to BILLING_STAFF** — the rule `invoice-response.ts` enforces at layer 3.
   * A PDF is a response. Printing `item.description` straight from the row
   * would have handed a billing clerk the itemised medicine list the API
   * carefully withholds, on a document they can file and re-read, which is a
   * worse leak than the one that rule was written to stop.
   *
   * So the same `shapeInvoiceItems` runs here. A pharmacist printing a receipt
   * gets the medicines; a billing clerk printing the same invoice gets
   * `PHARM · Medicines (n items)` with a total.
   */
  async invoicePdf(id: number, role: UserRole): Promise<{ pdf: Buffer; fileName: string }> {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        items: true,
        patient: { select: { id: true, fullName: true } },
        payments: { orderBy: { receivedAt: 'asc' } },
      },
    });
    if (!inv) throw new NotFoundException(`Invoice ${id} not found`);

    const head = await this.letterhead();
    const { currency } = await this.clinic.current();
    const issued = await this.localDate(inv.issuedAt as Date);
    const money = (v: unknown) => `${currency} ${String(v ?? '0.00')}`;
    const lines = shapeInvoiceItems(inv.items ?? [], role);
    const balance = (
      Number(inv.totalAmount) - Number(inv.amountPaid) - Number(inv.creditedAmount)
    ).toFixed(2);

    const pdf = await renderDocument(
      head,
      { kind: 'Invoice', reference: `#${inv.id}`, fileName: `invoice-${inv.id}` },
      (doc) => {
        detailGrid(doc, [
          // Nullable for a pharmacy counter sale: a member of the public buying
          // paracetamol is not under the hospital's care, and inventing a
          // patient row for them would put a stranger in the list reception
          // searches. The receipt simply has no patient line.
          ['Patient', inv.patient?.fullName ?? null],
          ['Date', issued],
          ['Patient ID', inv.patient ? String(inv.patient.id) : null],
          ['Status', inv.status],
          /*
           * The laboratory order this invoice charges for.
           *
           * On a printed bill this is the whole of reconciliation: the copy in
           * somebody's file has to match a worklist row without them ringing
           * the laboratory. Derived from the line descriptions by the same
           * exact pattern they were written with, and omitted entirely when
           * there is none — `detailGrid` drops null pairs, so a consultation
           * invoice gains no empty field.
           *
           * Safe on a document a patient keeps: an accession names no analyte
           * and no discipline, which is why it may print where a test name is
           * deliberately collapsed.
           */
          [
            'Lab order',
            accessionsIn(lines.map((i) => i.description)).join(', ') || null,
          ],
        ]);

        section(doc, 'Charges');
        table(
          doc,
          [
            { header: 'Description', width: 0.46 },
            { header: 'Qty', width: 0.1, align: 'right' },
            { header: 'Unit', width: 0.22, align: 'right' },
            { header: 'Amount', width: 0.22, align: 'right' },
          ],
          lines.map((i) => [
            i.description,
            i.quantity == null ? '' : String(i.quantity),
            i.unitPrice == null ? '' : money(i.unitPrice),
            money(i.amount),
          ]),
        );

        detailGrid(doc, [
          ['Total', money(inv.totalAmount)],
          ['Paid', money(inv.amountPaid)],
          // Credited is shown only when there is one. A "Credited 0.00" line on
          // an ordinary receipt invites the question of what was credited.
          ['Credited', Number(inv.creditedAmount) > 0 ? money(inv.creditedAmount) : null],
          ['Balance', money(balance)],
        ]);
      },
    );

    return { pdf, fileName: `invoice-${inv.id}.pdf` };
  }

  // ─────────────────────────────────────────────────────── partner statement

  /**
   * A month of referred work, as one page to post to the hospital that sent it.
   *
   * WHY A PAGE AND NOT FORTY INVOICES
   * ---------------------------------
   * The laboratory raises an invoice per referral, because a charge is captured
   * at accession against the prices in force that day. What it *sends* is one
   * statement a month, and that is what the recipient pays. Reported from the
   * other side of it: the payable notices arrived one per referral, so "what do
   * we owe them" was a column of figures to add up by eye and there was nothing
   * either party could put in an envelope.
   *
   * NO TEST NAMES ON THIS PAGE, AND THAT IS THE SHARPEST RULE HERE
   * -------------------------------------------------------------
   * A test name is frequently the clinical question itself — "HIV antibody",
   * "Beta-hCG" — and this document leaves the building, gets filed by whoever
   * opens the post at another company, and is read by their finance clerk. It
   * carries a count of tests and the two specimen numbers, which is everything
   * needed to reconcile it and nothing about what was investigated. The same
   * rule `labSummaryDescription` and `PartnerLabCharge` already follow, applied
   * where it matters most.
   *
   * The patient's name is likewise absent, and for a stronger reason: under
   * `ORIGIN_PAYS` the referring hospital already knows whose sample it was —
   * they drew it — so printing it buys nothing and puts a patient's name on a
   * document that travels by post.
   *
   * BOTH ACCESSIONS ON EVERY LINE
   * -----------------------------
   * Ours is what our own records are keyed on; theirs is the only number the
   * recipient can match against anything of their own. A statement quoting only
   * the issuer's numbers is one the payer has to telephone about, which defeats
   * the point of sending it.
   */
  async labStatementPdf(
    sourceTenantId: number,
    period: StatementPeriodQuery | undefined,
  ): Promise<{ pdf: Buffer; fileName: string }> {
    const statement = await this.lab.statement(sourceTenantId, period);

    const head = await this.letterhead();
    const { currency } = await this.clinic.current();
    const money = (v: unknown) => `${currency} ${String(v ?? '0.00')}`;

    /*
     * Dates resolved before the render callback, which is synchronous.
     * `localDate` reads the hospital's timezone, and a statement covering a
     * month has to print those dates in the hospital's own day — the same rule
     * that decides which month a line falls into in the first place.
     */
    const dates = new Map<number, string>();
    for (const line of statement.lines) {
      dates.set(line.invoiceId, await this.localDate(line.issuedAt as Date));
    }

    const pdf = await renderDocument(
      head,
      {
        kind: 'Statement',
        /*
         * The month and the hospital, not an invented statement number.
         *
         * There is nowhere honest to get one: a reference this laboratory makes
         * up cannot be looked up by the hospital receiving it, whose own records
         * are keyed on the partnership and the period, and one derived from a
         * tenant id would tell them their position in the platform's sequence.
         * What identifies this page is the three facts both sides already hold,
         * and both screens print exactly those — so the telephone call works.
         *
         * Which is why the period has to be printed *precisely*. `September
         * 2026` was sufficient while a statement was always a month; on a
         * fortnightly agreement `periodLabel` reads `1–15 September 2026`, and
         * two parties disagreeing about which days a bill covers is the whole
         * failure this label exists to prevent.
         */
        reference: statement.label,
        fileName: `statement-${statement.from}`,
      },
      (doc) => {
        detailGrid(doc, [
          ['To', statement.hospital],
          ['Period', statement.label],
          ['Referrals', String(statement.referrals)],
          ['Tests', String(statement.tests)],
        ]);

        section(doc, 'Work referred to us');
        table(
          doc,
          [
            { header: 'Date', width: 0.16 },
            { header: 'Your ref.', width: 0.2 },
            { header: 'Our ref.', width: 0.2 },
            { header: 'Tests', width: 0.1, align: 'right' },
            { header: 'Amount', width: 0.17, align: 'right' },
            { header: 'Outstanding', width: 0.17, align: 'right' },
          ],
          statement.lines.map((l) => [
            dates.get(l.invoiceId) ?? '',
            /*
             * Em dash rather than blank on a missing accession. A blank cell on
             * a financial document reads as something the system failed to
             * fill in, and these are genuinely absent on referrals raised
             * before accessions existed — which is a fact, not an omission.
             */
            l.sourceAccession ?? '—',
            l.accession ?? '—',
            String(l.tests),
            money(l.amount),
            money(l.outstanding),
          ]),
        );

        detailGrid(doc, [
          ['Total', money(statement.total)],
          ['Received', money(statement.paid)],
          // Shown only when there is one, exactly as on an invoice: a
          // "Credited 0.00" line invites the question of what was credited.
          ['Credited', Number(statement.credited) > 0 ? money(statement.credited) : null],
          ['Due', money(statement.outstanding)],
        ]);

        paragraph(
          doc,
          'About this statement',
          'It covers work referred to this laboratory during the period shown. Each line is a separate requisition carrying its own invoice, and the amounts here are those invoices. Test names are deliberately omitted from a document that travels by post — quote a specimen number and we will discuss any line by telephone.',
        );
      },
    );

    return {
      pdf,
      fileName: `statement-${statement.from}-to-${statement.to}-${sourceTenantId}.pdf`,
    };
  }

  // ────────────────────────────────────────────────────────────── lab report

  /**
   * The report a patient carries away and another clinician reads.
   *
   * ONLY AN AUTHORISED ONE PRINTS
   * -----------------------------
   * The single refusal in this method, and it is the one that matters. A PDF
   * leaves the building: it gets filed, photographed, handed to a specialist in
   * another hospital, and nothing about it says how old or how provisional it
   * is once it is on paper. Values on a bench that the lab has not stood behind
   * must not be able to become a document.
   *
   * That is stricter than the screens, which show the lab its own work in
   * progress — and deliberately so. On a screen the state is visible and
   * revocable; on paper it is neither.
   *
   * WHAT THE PAGE HAS TO SAY
   * ------------------------
   * A value with no reference range beside it is a number a reader cannot act
   * on, so the range prints on every row — as captured at the time, never
   * re-resolved from today's catalogue. The flag prints as a word rather than a
   * colour, because these are printed on monochrome laser printers and a
   * pale-red row is an unmarked row.
   *
   * `UNKNOWN` prints as an empty flag rather than as "Normal". "Compared and
   * found unremarkable" and "nothing to compare against" are opposite claims,
   * and the wrong one of those on a piece of paper is a false reassurance
   * nobody can trace back.
   */
  async labReportPdf(id: number): Promise<{ pdf: Buffer; fileName: string }> {
    const o = await this.prisma.labOrder.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, fullName: true, dob: true, gender: true } },
        doctor: { select: { fullName: true, registrationNo: true } },
        verifiedBy: { select: { fullName: true } },
        items: {
          include: { values: { orderBy: { position: 'asc' } } },
        },
      },
    });
    if (!o) throw new NotFoundException(`Lab order ${id} not found`);

    if (o.status !== 'VERIFIED') {
      throw new NotFoundException(
        'That report has not been authorised yet, so there is nothing to print',
      );
    }

    const head = await this.letterhead();
    const ordered = await this.localDate(o.orderedAt as Date);
    const reported = o.verifiedAt ? await this.localDate(o.verifiedAt as Date) : null;
    const dob = o.patient?.dob ? await this.localDate(o.patient.dob as Date) : null;
    // Resolved before the renderer runs: `renderDocument` takes a synchronous
    // callback, and awaiting inside it silently yields a page missing the value.
    const collected = o.collectedAt ? await this.localDate(o.collectedAt as Date) : null;
    const authorisedBy = o.verifiedBy?.fullName ?? o.externalVerifiedBy ?? 'the laboratory';

    const pdf = await renderDocument(
      head,
      { kind: 'Laboratory report', reference: `#${o.id}`, fileName: `lab-report-${o.id}` },
      (doc) => {
        detailGrid(doc, [
          ['Patient', o.patient?.fullName ?? ''],
          ['Reported', reported],
          // Sex and date of birth are on the page because reference ranges are
          // banded by both — a reader checking a value against a published
          // range needs them, and a report without them cannot be re-checked.
          ['Date of birth', dob],
          ['Sex', o.patient?.gender ?? null],
          ['Patient ID', String(o.patient?.id ?? '')],
          ['Requested', ordered],
          ['Requested by', o.doctor?.fullName ?? ''],
          ['Sample taken', collected],
        ]);

        if (o.clinicalDetails) paragraph(doc, 'Clinical details', o.clinicalDetails);

        for (const item of o.items) {
          section(doc, `${item.testCode} — ${item.testName}`);

          if (item.values.length > 0) {
            table(
              doc,
              [
                { header: 'Analyte', width: 0.34 },
                { header: 'Result', width: 0.2 },
                { header: 'Units', width: 0.14 },
                { header: 'Reference', width: 0.22 },
                { header: 'Flag', width: 0.1 },
              ],
              item.values.map((v) => [
                v.analyteName,
                v.value,
                v.unit ?? '',
                v.referenceRange ?? '',
                flagWord(v.flag),
              ]),
            );
          }

          if (item.findings) paragraph(doc, 'Findings', item.findings);
          if (item.impression) paragraph(doc, 'Impression', item.impression);
          if (item.methodology) paragraph(doc, 'Method', item.methodology);
          if (item.performedByName) paragraph(doc, 'Performed by', item.performedByName);

          /*
           * A test with no values and no narrative is a report of nothing, and
           * that is worth saying out loud rather than leaving a heading with a
           * gap under it — a gap reads as "normal, nothing to report".
           */
          if (item.values.length === 0 && !item.findings && !item.impression) {
            paragraph(doc, 'Result', 'No result was recorded for this test.');
          }
        }

        signatureBlock(doc, `Authorised by ${authorisedBy}`);
      },
    );

    return { pdf, fileName: `lab-report-${o.id}.pdf` };
  }

  // ─────────────────────────────────────────────────────── specimen labels

  /**
   * The stickers that go round the tubes for one order.
   *
   * Printable from the moment the order exists — **not** gated on
   * authorisation, unlike the report. A label is needed *before* any work
   * happens: the phlebotomist prints it, sticks it on, and draws the blood. The
   * report gate exists because an unauthorised result must not leave the
   * laboratory; a label carries no result at all.
   *
   * Refuses only where there is genuinely nothing to print — an order with no
   * accession (raised before they existed) or one that is imaging only, where
   * there is no specimen to label. Both say which, because a blank PDF and a
   * refusal look identical to whoever pressed the button.
   */
  async specimenLabelsPdf(id: number): Promise<{ pdf: Buffer; fileName: string }> {
    const o = await this.prisma.labOrder.findUnique({
      where: { id },
      select: {
        id: true,
        accession: true,
        patient: { select: { fullName: true, dob: true } },
        items: { select: { testName: true, specimenType: true } },
      },
    });
    if (!o) throw new NotFoundException(`Lab order ${id} not found`);

    /*
     * Allocate one rather than refusing.
     *
     * This used to throw for an order raised before accessions existed, which
     * made "no specimen no." a permanent state with no route out — the shape
     * this project keeps having to reopen. Printing a label is somebody
     * deciding a tube is about to exist, which is exactly when the number
     * should come into being.
     */
    const accession = o.accession ?? (await this.lab.ensureAccession(o.id));

    const specimens = groupSpecimens(accession, o.items);
    if (specimens.length === 0) {
      throw new NotFoundException(
        'Nothing on that order needs a specimen — imaging has no tube to label.',
      );
    }

    const head = await this.letterhead();

    const pdf = await new Promise<Buffer>((resolve, reject) => {
      const doc = renderSpecimenLabels(
        { fullName: o.patient.fullName, dob: o.patient.dob },
        specimens,
        head.hospitalName,
      );
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });

    return { pdf, fileName: `labels-${accession}.pdf` };
  }

  // ────────────────────────────────────────────────────────── medical record

  async medicalRecordPdf(id: number): Promise<{ pdf: Buffer; fileName: string }> {
    const r = await this.prisma.medicalRecord.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, fullName: true, dob: true } },
        doctor: {
          select: {
            fullName: true,
            specialization: true,
            qualifications: true,
            registrationNo: true,
          },
        },
      },
    });
    if (!r) throw new NotFoundException(`Record ${id} not found`);

    const head = await this.letterhead();
    const visit = await this.localDate(r.visitDate as Date);
    const dob = r.patient?.dob ? await this.localDate(r.patient.dob as Date) : null;

    const pdf = await renderDocument(
      head,
      { kind: 'Consultation note', reference: `#${r.id}`, fileName: `record-${r.id}` },
      (doc) => {
        detailGrid(doc, [
          ['Patient', r.patient?.fullName ?? ''],
          ['Date of visit', visit],
          ['Date of birth', dob],
          ['Patient ID', String(r.patient?.id ?? '')],
        ]);

        section(doc, 'Clinician');
        detailGrid(doc, [
          ['Name', r.doctor?.fullName ?? ''],
          ['Registration no', r.doctor?.registrationNo ?? null],
          ['Qualifications', r.doctor?.qualifications ?? null],
          ['Specialty', r.doctor?.specialization ?? null],
        ]);

        paragraph(doc, 'Diagnosis', r.diagnosis);
        if (r.notes) paragraph(doc, 'Notes', r.notes);

        signatureBlock(doc, `${r.doctor?.fullName ?? 'Clinician'} — signature`);
      },
    );

    return { pdf, fileName: `record-${r.id}.pdf` };
  }
}

/**
 * How a flag prints.
 *
 * A word, not a colour. These are printed on monochrome laser printers and a
 * pale-red row is an unmarked row.
 *
 * `UNKNOWN` prints as **nothing** rather than as "Normal", and that is the
 * whole reason this function exists rather than a `titleCase(flag)`. "Compared
 * and found unremarkable" and "there was nothing to compare against" are
 * opposite claims, and the wrong one of those on a piece of paper is a false
 * reassurance nobody can trace back to a missing reference range.
 */
function flagWord(flag: string): string {
  switch (flag) {
    case 'LOW':
      return 'Low';
    case 'HIGH':
      return 'High';
    case 'ABNORMAL':
      return 'Abnormal';
    case 'CRITICAL_LOW':
      return '** LOW **';
    case 'CRITICAL_HIGH':
      return '** HIGH **';
    case 'NORMAL':
      return '';
    default:
      // UNKNOWN, and anything a later enum member might add. Silence is the
      // safe default here; asserting is not.
      return '';
  }
}
