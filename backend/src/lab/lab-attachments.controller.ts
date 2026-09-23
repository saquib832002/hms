import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { LabAttachmentKind, UserRole, TenantModule } from '@prisma/client';
import { LabAttachmentsService } from './lab-attachments.service';
import { MAX_ATTACHMENT_BYTES } from './attachment-rules';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

class UploadAttachmentDto {
  @IsOptional() @IsEnum(LabAttachmentKind) kind?: LabAttachmentKind;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
}

/**
 * Files attached to a lab result.
 *
 * WHY THE UPLOAD IS MULTIPART AND NOT BASE64 JSON
 * -----------------------------------------------
 * Base64 in a JSON body is a third larger, has to be held in memory twice, and
 * would need the global body limit raised for every route in the application to
 * accommodate one. Multipart streams it, and the limit is set here and applies
 * to this route only.
 *
 * A DOWNLOAD CANNOT BE A LINK, AND THAT IS NOT NEW
 * -----------------------------------------------
 * The access token lives in memory and travels as an `Authorization` header, so
 * a browser navigation to this route arrives unauthenticated and gets a 401.
 * That is exactly the bug the prescription print anchor had from Phase 1 —
 * correct every time, and invisible because it opens in a tab somebody closes.
 * Both clients fetch with the header and hand the bytes to the browser or the
 * share sheet, and `client-nav.spec.ts` fails the build on any anchor to the
 * API.
 */
@Controller('lab')
@RequiresModule(TenantModule.LABORATORY)
export class LabAttachmentsController {
  constructor(private readonly attachments: LabAttachmentsService) {}

  /**
   * Attach a file to one test.
   *
   * The size limit is enforced twice, here and in the service. Multer stops a
   * huge upload before it is buffered — which is the one that protects the
   * process — and the service produces the message a technician reads.
   */
  @Post('items/:itemId/attachments')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_ATTACHMENT_UPLOAD')
  @UseInterceptors(
    FileInterceptor('file', {
      // In memory, not on disk. The file goes straight into Postgres and never
      // touches the filesystem, so there is no temporary copy to clean up and
      // nothing left behind if the request fails.
      limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
    }),
  )
  upload(
    @Param('itemId', ParseIntPipe) itemId: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadAttachmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('No file was attached to that request.');
    return this.attachments.upload(itemId, file, dto, user);
  }

  /**
   * What is attached to an order.
   *
   * The same roles that may read the order itself. Values and files are
   * withheld together before authorisation — the service decides that, not
   * this list, because it depends on the order's state rather than the caller's
   * role alone.
   */
  @Get('orders/:id/attachments')
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_ATTACHMENT_LIST')
  list(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.attachments.forOrder(id, user);
  }

  /**
   * The file itself.
   *
   * Reception is deliberately absent, unlike the printed report. A rendered PDF
   * of an authorised result is a document the front desk hands to a patient; an
   * arbitrary file a technician uploaded is not — it may be an analyser dump or
   * a working note, and nothing here has decided it is fit to hand over.
   */
  @Get('attachments/:id/file')
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_ATTACHMENT_DOWNLOAD')
  async file(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const { content, fileName, mimeType, disposition } = await this.attachments.download(id, user);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', content.length);
    /*
     * `nosniff` unconditionally.
     *
     * Without it a browser may ignore the type above and guess from the
     * content — which hands the decision back to the file, and taking that
     * decision away from the file is the entire point of `attachment-rules.ts`.
     */
    res.setHeader('X-Content-Type-Options', 'nosniff');
    /*
     * Inline for a PDF, a download for anything else. A doctor wants to read a
     * report rather than save it; a Word document a browser cannot render would
     * download anyway, and forcing it makes the worst case for a mis-sniffed
     * file a file nobody can open rather than script running on this origin.
     */
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
    /*
     * Never cached. An attachment can be removed while a report is unsigned,
     * and a stale copy from a proxy is a document that disagrees with the
     * system about a patient's results.
     */
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.end(content);
  }

  /** Remove a file uploaded in error. Refused once the report is authorised. */
  @Delete('attachments/:id')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_ATTACHMENT_REMOVE')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.attachments.remove(id);
  }
}
