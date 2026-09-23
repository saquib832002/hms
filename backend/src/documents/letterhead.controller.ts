import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { currentTenantId } from '../common/tenancy/tenant-context';

/**
 * A logo, capped.
 *
 * ~200KB of base64 is roughly a 150KB image, which is a generous letterhead
 * logo and a bounded cost on a column read once per printed document. Without
 * a cap an administrator drops in a 6MB photograph and every print gets slower
 * for reasons nobody connects to the day they uploaded it.
 */
const MAX_LOGO_CHARS = 200_000;

/**
 * PNG and JPEG only, and only as a data URL.
 *
 * pdfkit embeds those two and nothing else. An SVG or a WebP reaches
 * `doc.image()` and throws — turning "the admin picked the wrong file type"
 * into "prescriptions cannot be printed", found by a doctor rather than by the
 * person who uploaded it. Refused here, where the message can name the problem.
 *
 * An `http(s)` URL is deliberately not accepted. Fetching one would make
 * printing depend on a third-party host staying up, and would let an
 * administrator point the renderer at an arbitrary address from inside the
 * hospital's own network.
 */
const LOGO_DATA_URL = /^(|data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+)$/;
//                     ^ empty string allowed, and it is load-bearing.
// An admin removes the logo by sending "". Without this alternative the
// pattern refuses it, and the only way back from a bad upload is a database
// console — which is precisely the "no way to undo" the update handler's own
// comment promises against.

/**
 * `string | null`, not `string`.
 *
 * The screen loads the letterhead, edits some of it, and sends the whole thing
 * back — so every field the hospital has never filled in arrives as `null`,
 * because that is what the GET returned. `@IsOptional()` accepts null as well
 * as undefined, so those values passed validation and reached the handler,
 * where `v.trim()` threw and the whole save 500'd.
 *
 * Typing them honestly is the fix rather than making the client send fewer
 * fields: a partial update is what the API promises, and "the client must not
 * send me the shape I just gave it" is not a contract anybody can follow.
 */
export class UpdateLetterheadDto {
  @IsOptional() @IsString() @MaxLength(120) addressLine1?: string | null;
  @IsOptional() @IsString() @MaxLength(120) addressLine2?: string | null;
  @IsOptional() @IsString() @MaxLength(80) city?: string | null;
  @IsOptional() @IsString() @MaxLength(20) postcode?: string | null;
  @IsOptional() @IsString() @MaxLength(60) country?: string | null;
  @IsOptional() @IsString() @MaxLength(40) contactPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(120) contactEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(120) website?: string | null;
  @IsOptional() @IsString() @MaxLength(60) registrationNo?: string | null;
  @IsOptional() @IsString() @MaxLength(300) footerText?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_LOGO_CHARS, { message: 'That logo is too large — use an image under about 150KB' })
  @Matches(LOGO_DATA_URL, { message: 'The logo must be a PNG or JPEG image' })
  logoDataUrl?: string | null;
}

/**
 * What this hospital prints at the top of anything a patient carries away.
 *
 * ADMIN only, and web-only in practice — it is a one-off setup task like
 * departments and staff accounts, done once at a desk with the hospital's
 * letterhead in front of you.
 *
 * Separate from `/admin/clinic-settings` on purpose. That endpoint feeds
 * `ClinicSettingsService`, which runs on nearly every authenticated request;
 * putting a base64 logo behind it would drag an image through the hot path to
 * answer questions about slot lengths and timezones.
 */
@Controller('letterhead')
export class LetterheadController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @Roles(UserRole.ADMIN)
  @AuditAction('LETTERHEAD_VIEW')
  async get() {
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
    return t;
  }

  /**
   * Partial by design.
   *
   * Three inputs, three meanings, and the middle one is what broke:
   *
   *   - **absent** (`undefined`) — untouched, leave the column alone.
   *   - **`null`** — the field the hospital has never filled in, sent straight
   *     back by a screen that loaded the letterhead and returned it. Same as
   *     empty: clear it.
   *   - **`''`** — the administrator emptied the box. Clear it.
   *
   * The first version handled `undefined` and `''` and called `.trim()` on
   * everything else, so a `null` from an unfilled field threw and took the
   * whole save down with it — a 500 on the ordinary path of the ordinary
   * screen, because a hospital with a complete letterhead is the rare case
   * and one with blanks is every new tenant.
   */
  @Patch()
  @Roles(UserRole.ADMIN)
  @AuditAction('LETTERHEAD_UPDATE')
  async update(@Body() dto: UpdateLetterheadDto) {
    const clear = (v: string | null | undefined) => {
      if (v === undefined) return undefined; // key absent — leave the column
      if (v === null) return null; // never set, or explicitly cleared
      return v.trim() === '' ? null : v.trim();
    };

    await this.prisma.tenant.update({
      where: { id: currentTenantId() },
      data: {
        addressLine1: clear(dto.addressLine1),
        addressLine2: clear(dto.addressLine2),
        city: clear(dto.city),
        postcode: clear(dto.postcode),
        country: clear(dto.country),
        contactPhone: clear(dto.contactPhone),
        contactEmail: clear(dto.contactEmail),
        website: clear(dto.website),
        registrationNo: clear(dto.registrationNo),
        footerText: clear(dto.footerText),
        logoDataUrl: clear(dto.logoDataUrl),
      },
    });

    return this.get();
  }
}
