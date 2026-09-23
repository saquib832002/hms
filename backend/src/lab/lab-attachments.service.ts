import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { LabAttachmentKind, LabOrderStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { AuthUser } from '../common/types/auth-user';
import {
  MAX_ATTACHMENT_BYTES,
  SniffedType,
  checksumOf,
  dispositionFor,
  refusalFor,
  safeFileName,
  sniffType,
} from './attachment-rules';

/**
 * Files attached to a test result.
 *
 * WHY THIS EXISTS
 * ---------------
 * Structured analytes and a typed narrative cover a full blood count. They do
 * not cover the thing a laboratory most often actually produces: a signed PDF,
 * an analyser's own printout, a histopathology report somebody typed in Word.
 * Reporting those by retyping them into a text box loses the signature, the
 * layout and the laboratory's own letterhead — and retyping a report is where
 * transcription errors come from.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not image storage, and the distinction is worth keeping. CLAUDE.md records
 * that imaging stores no images and that closing that gap needs more than a
 * file column — a radiograph a clinician cannot window, zoom or measure is not
 * a radiology result, it is a picture of one. Accepting JPEGs here would look
 * like closing that gap while doing something worse than leaving it open. PDF
 * and Word only.
 *
 * WHAT THE BYTES ARE STORED IN
 * ----------------------------
 * A separate table, joined by exactly one method. See the note on
 * `LabAttachment` in the schema: a `Bytes` column on the metadata row would
 * mean the query that lists filenames pulls every PDF into memory, and the
 * mistake would be invisible at the call site.
 *
 * `download` is the only method in this file that touches `data`. If a second
 * one ever needs to, that is the moment to move to object storage rather than
 * the moment to add a second `include`.
 */
/**
 * Everything except the bytes.
 *
 * Written out rather than left to Prisma's default so that adding a column to
 * `LabAttachment` cannot quietly start appearing in a list response — and so a
 * reader can see at a glance that `data` is absent.
 */
const METADATA = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  checksum: true,
  kind: true,
  description: true,
  uploadedAt: true,
  orderItemId: true,
  uploadedBy: { select: { fullName: true } },
} satisfies Prisma.LabAttachmentSelect;

type AttachmentRow = Prisma.LabAttachmentGetPayload<{ select: typeof METADATA }>;

@Injectable()
export class LabAttachmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attach a file to one test.
   *
   * REFUSED ONCE THE REPORT IS AUTHORISED
   * -------------------------------------
   * The same rule as editing values. A verified report is a document a
   * clinician may already have read and acted on; adding a file to it after the
   * fact changes what that document says without anybody re-authorising it. A
   * correction is a new order, so the original stays readable.
   */
  async upload(
    itemId: number,
    file: { originalname: string; buffer: Buffer },
    meta: { kind?: LabAttachmentKind; description?: string },
    user: AuthUser,
  ) {
    const item = await this.prisma.labOrderItem.findUnique({
      where: { id: itemId },
      select: { id: true, order: { select: { id: true, status: true } } },
    });
    if (!item) throw new NotFoundException('No such test on any order');

    if (item.order.status === LabOrderStatus.VERIFIED) {
      throw new ConflictException(
        'That report has been authorised. Adding a file now would change a document somebody may already have acted on — raise a new order instead',
      );
    }
    if (item.order.status === LabOrderStatus.CANCELLED) {
      throw new ConflictException('That order was cancelled');
    }

    const content = file.buffer;

    /*
     * Size is checked here as well as by the upload limit. Multer refuses
     * anything over the cap before this runs, but a limit enforced in one place
     * is a limit that moves when somebody reconfigures the interceptor — and
     * this is the check that produces a message a human can act on.
     */
    if (content.length > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException(refusalFor(file.originalname, content) as string);
    }

    const refusal = refusalFor(file.originalname, content);
    if (refusal) throw new BadRequestException(refusal);

    // Non-null: `refusalFor` returned nothing, which it only does when the
    // content sniffed to something we accept.
    const type = sniffType(content) as SniffedType;
    const tenantId = currentTenantId();

    const created = await this.prisma.labAttachment.create({
      data: {
        tenantId,
        orderItemId: itemId,
        fileName: safeFileName(file.originalname, type.extension),
        // The sniffed type, never the declared one. See `attachment-rules.ts`.
        mimeType: type.mimeType,
        sizeBytes: content.length,
        checksum: checksumOf(content),
        kind: meta.kind ?? LabAttachmentKind.REPORT,
        description: meta.description?.trim() || null,
        uploadedById: user.userId,
        /*
         * `Bytes` is a `Uint8Array` in the generated client, and a `Buffer` is
         * one — but the generic parameters differ under recent @types/node, so
         * the view is taken explicitly rather than cast away.
         */
        data: { create: { tenantId, content: new Uint8Array(content) } },
      },
      select: METADATA,
    });

    return this.shape(created);
  }

  /**
   * What is attached to an order, without any of the bytes.
   *
   * Withheld before authorisation for everybody except the laboratory, exactly
   * as values are. A report PDF that leaves the lab before it has been signed
   * off is the thing the verify gate exists to prevent, and a file is worse
   * than a screen: it gets saved, forwarded and read later with nothing on it
   * to say it was provisional.
   */
  async forOrder(orderId: number, user: AuthUser) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException('No such order');

    const visible =
      order.status === LabOrderStatus.VERIFIED || user.role === UserRole.LAB_TECHNICIAN;
    if (!visible) return { data: [], resultsAuthorised: false };

    const rows = await this.prisma.labAttachment.findMany({
      where: { orderItem: { orderId } },
      orderBy: { uploadedAt: 'asc' },
      select: METADATA,
    });

    return {
      data: rows.map((r) => this.shape(r)),
      resultsAuthorised: order.status === LabOrderStatus.VERIFIED,
    };
  }

  /**
   * The bytes. The only method that reads them.
   *
   * Returns everything the controller needs to write the response, including
   * how it may be served — the controller must not decide that, because the
   * decision depends on what the content sniffed to and that is settled here.
   */
  async download(id: number, user: AuthUser) {
    const attachment = await this.prisma.labAttachment.findUnique({
      where: { id },
      select: {
        ...METADATA,
        orderItem: { select: { order: { select: { status: true } } } },
        data: { select: { content: true } },
      },
    });
    if (!attachment?.data) throw new NotFoundException('No such attachment');

    const status = attachment.orderItem.order.status;
    if (status !== LabOrderStatus.VERIFIED && user.role !== UserRole.LAB_TECHNICIAN) {
      /*
       * A 403 rather than a 404. The row exists and the caller may well be
       * entitled to it in an hour — telling them it is not ready is more useful
       * than pretending it is not there, and they can already see from the
       * order that a test is in progress.
       */
      throw new ForbiddenException(
        'That report has not been authorised yet. It becomes available once the laboratory signs it off',
      );
    }

    const content = Buffer.from(attachment.data.content);
    const type = sniffType(content);
    if (!type) {
      /*
       * Stored content that no longer sniffs to anything we accept. It cannot
       * happen through the upload path, so if it happens the row was written by
       * something else — refuse rather than serve bytes of unknown type.
       */
      throw new NotFoundException('That file cannot be served');
    }

    return {
      fileName: attachment.fileName,
      mimeType: type.mimeType,
      disposition: dispositionFor(type),
      content,
    };
  }

  /**
   * Remove one, before the report is signed.
   *
   * Deleted outright rather than soft-deleted, and only while unauthorised.
   * This is the "wrong file" case — a scan of the previous patient's form, the
   * preview image instead of the report — and keeping it would mean a
   * withdrawn file staying attached to somebody's clinical record with a flag
   * nobody renders.
   *
   * After authorisation it is part of a document that has been issued, and the
   * correction is a new order.
   */
  async remove(id: number) {
    const attachment = await this.prisma.labAttachment.findUnique({
      where: { id },
      select: { id: true, orderItem: { select: { order: { select: { status: true } } } } },
    });
    if (!attachment) throw new NotFoundException('No such attachment');

    if (attachment.orderItem.order.status === LabOrderStatus.VERIFIED) {
      throw new ConflictException(
        'That report has been authorised, so its files are part of an issued document. A correction is a new order',
      );
    }

    // The data row goes with it — `onDelete: Cascade` on the relation.
    await this.prisma.labAttachment.delete({ where: { id } });
    return { id, removed: true };
  }

  private shape(row: AttachmentRow) {
    return {
      id: row.id,
      orderItemId: row.orderItemId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      checksum: row.checksum,
      kind: row.kind,
      description: row.description,
      uploadedAt: row.uploadedAt,
      uploadedByName: row.uploadedBy?.fullName ?? null,
    };
  }
}
