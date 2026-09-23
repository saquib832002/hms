import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { UserRole } from '@prisma/client';
import { DocumentsService } from './documents.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

/**
 * Printable documents, as real PDFs.
 *
 * WHY A SEPARATE CONTROLLER
 * -------------------------
 * These are the only endpoints in the system that hand out a whole clinical
 * document as a file, and the role rules are their own: reception may print a
 * prescription for a patient to carry and must never read it as data. Keeping
 * them together makes that rule visible in one place instead of spread across
 * three feature controllers where the next person adds a fourth and guesses.
 *
 * ROLES, AND WHY THEY DIFFER PER DOCUMENT
 * ---------------------------------------
 * A prescription is handed over at the front desk, so reception prints it. An
 * invoice is billing's, plus the pharmacist for a counter receipt. A
 * consultation note is clinical and stays with clinicians. Admin appears on
 * none of them — a printed document is the most complete form of the record
 * there is, and admin is operational rather than clinical.
 */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /**
   * Reception may print, and still cannot read the prescription as data —
   * exactly as on `GET /prescriptions/:id`, which excludes them.
   */
  @Get('prescriptions/:id/pdf')
  @Roles(UserRole.DOCTOR, UserRole.RECEPTIONIST, UserRole.PHARMACIST)
  @AuditAction('PRESCRIPTION_PRINT')
  async prescription(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const { pdf, fileName } = await this.documents.prescriptionPdf(id);
    send(res, pdf, fileName);
  }

  @Get('invoices/:id/pdf')
  @Roles(UserRole.BILLING_STAFF, UserRole.ADMIN, UserRole.PHARMACIST, UserRole.RECEPTIONIST)
  @AuditAction('INVOICE_PRINT')
  async invoice(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    // The role decides what the document says. A billing clerk's copy collapses
    // the medicine lines exactly as the API response does — a PDF is a response.
    const { pdf, fileName } = await this.documents.invoicePdf(id, user.role);
    send(res, pdf, fileName);
  }

  /**
   * A month of referred work, as one page to post to the hospital that sent it.
   *
   * LAB_TECHNICIAN and ADMIN, and nobody else. This is the laboratory's own
   * sales document — it names no patient and no test, so it is not a clinical
   * record, and it is not the hospital's billing either: BILLING_STAFF here
   * would be a laboratory's statement to another company arriving on the
   * hospital's own accounts-receivable desk, which is a different ledger.
   *
   * ADMIN is present, unlike on every clinical document, for exactly that
   * reason: an owner reconciling what the laboratory invoiced this month is
   * doing operational work, and there is no patient identity on the page for
   * them to learn.
   */
  @Get('lab-statements/:sourceTenantId/pdf')
  @Roles(UserRole.LAB_TECHNICIAN, UserRole.ADMIN)
  @AuditAction('LAB_STATEMENT_PRINT')
  async labStatement(
    @Param('sourceTenantId', ParseIntPipe) sourceTenantId: number,
    @Query('month') month: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ) {
    const { pdf, fileName } = await this.documents.labStatementPdf(sourceTenantId, {
      month,
      from,
      to,
    });
    send(res, pdf, fileName);
  }

  /**
   * A laboratory report.
   *
   * Reception is on this list and it is a deliberate choice, not an oversight:
   * a patient collecting a result at the front desk is the ordinary case, and
   * the alternative is a clinician being fetched to press a button. It matches
   * the prescription rule exactly — reception may *print* a document they may
   * not read as data, and `GET /lab-orders/:id` excludes them.
   *
   * ADMIN is absent, as on every other document. A printed report is the most
   * complete form of the record there is.
   */
  @Get('lab-orders/:id/pdf')
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.LAB_TECHNICIAN, UserRole.RECEPTIONIST)
  @AuditAction('LAB_REPORT_PRINT')
  async labReport(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const { pdf, fileName } = await this.documents.labReportPdf(id);
    send(res, pdf, fileName);
  }

  /**
   * The stickers for the tubes.
   *
   * NURSE and LAB_TECHNICIAN as well as the ordering doctor, because whoever
   * draws the blood is the person who needs the label in their hand — on a
   * ward that is a nurse, and in a clinic it is the phlebotomist at the bench.
   * Reception is excluded: they neither draw specimens nor handle them, and a
   * label is the one document here that is worthless without the tube.
   *
   * Not gated on authorisation, unlike the report — a label is printed before
   * any work happens and carries no result.
   */
  @Get('lab-orders/:id/labels')
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.LAB_TECHNICIAN)
  @AuditAction('SPECIMEN_LABEL_PRINT')
  async labels(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const { pdf, fileName } = await this.documents.specimenLabelsPdf(id);
    send(res, pdf, fileName);
  }

  @Get('records/:id/pdf')
  @Roles(UserRole.DOCTOR, UserRole.NURSE)
  @AuditAction('MEDICAL_RECORD_PRINT')
  async record(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const { pdf, fileName } = await this.documents.medicalRecordPdf(id);
    send(res, pdf, fileName);
  }
}

/**
 * `inline` rather than `attachment`.
 *
 * A doctor at a desk wants to see the prescription before committing it to
 * paper, and a browser shows an inline PDF in its own viewer with a print
 * button already on it. Save-as is one click from there; forcing a download
 * first is one click the other way and leaves a file nobody wanted.
 */
function send(res: Response, pdf: Buffer, fileName: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  res.setHeader('Content-Length', pdf.length);
  /*
   * Never cached. A prescription can be cancelled, and an invoice's balance
   * changes the moment a payment lands — a stale copy from a proxy is a
   * document that disagrees with the system about something that matters.
   */
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.end(pdf);
}
