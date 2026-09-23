import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Prisma, UserRole, TenantModule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { formatRate } from './tax';

class ComponentDto {
  /** "CGST", "SGST", "State", "County" — printed on the invoice as written. */
  @IsString() @MaxLength(40) name: string;
  @IsInt() @Min(0) @Max(10_000) rateBasisPoints: number;
}

class TaxRateDto {
  /** "GST 12%", "Exempt", "Sales tax 8.25%" — whatever the staff call it. */
  @IsString() @MaxLength(60) name: string;

  /**
   * Basis points: 1250 is 12.5%.
   *
   * Capped at 100% in the DTO *and* by a CHECK constraint in the migration.
   * The realistic mistake is typing 12000 meaning 120%, and multiplying a
   * basket out by it produces an enormous, confident, wrong bill.
   */
  @IsInt() @Min(0) @Max(10_000) rateBasisPoints: number;

  @IsOptional() @IsBoolean() isDefault?: boolean;

  /**
   * The parts this rate is made of: CGST 6% + SGST 6%.
   *
   * Optional — most rates are flat and need none. When given, they must sum to
   * `rateBasisPoints`; the total stays authoritative so the sale arithmetic is
   * untouched and components are purely what the invoice shows.
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ComponentDto)
  components?: ComponentDto[];
}

class UpdateTaxRateDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) rateBasisPoints?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ComponentDto)
  components?: ComponentDto[];
}

/**
 * The tax rates a hospital charges.
 *
 * ADMIN ONLY, and it is a commercial setting rather than a clinical one — what
 * this business charges and which of its items are exempt. A pharmacist may
 * read them, because the dispensing screen has to show the tax on a line, and
 * a figure a pharmacist cannot see is one they cannot explain to the patient
 * asking about it.
 *
 * A hospital that charges no tax never comes here. There are no rates, every
 * line resolves to zero, and invoices look exactly as they did before this
 * existed — which is the state most clinics stay in.
 */
@Controller('tax-rates')
@RequiresModule(TenantModule.BILLING)
export class TaxRatesController {
  constructor(private prisma: PrismaService) {}


  /**
   * Components must add up to the rate they belong to.
   *
   * The total stays authoritative — it is what `taxLine` is given, so the sale
   * arithmetic never has to reason about parts. Letting the two disagree would
   * put a bill on a patient's hand whose components do not sum to its own tax
   * line, which is the thing an auditor checks first.
   *
   * Rejected rather than silently corrected: quietly rewriting the total to
   * match the parts, or the parts to match the total, would hide a typo in a
   * number that ends up on a statutory document.
   */
  private assertComponentsSum(total: number, components?: { name: string; rateBasisPoints: number }[]) {
    if (!components || components.length === 0) return;
    const sum = components.reduce((s, c) => s + c.rateBasisPoints, 0);
    if (sum !== total) {
      throw new BadRequestException(
        `The parts add up to ${formatRate(sum)} but the rate is ${formatRate(total)}. ` +
          'CGST and SGST are both charged on the same amount, so they must sum to the total rather than compound.',
      );
    }
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.PHARMACIST, UserRole.BILLING_STAFF)
  async findAll() {
    const rows = await this.prisma.taxRate.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { rateBasisPoints: 'asc' }],
      include: { components: { orderBy: { position: 'asc' } } },
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        rateBasisPoints: r.rateBasisPoints,
        /** Pre-formatted, so both clients cannot disagree about "8.25%". */
        label: formatRate(r.rateBasisPoints),
        isDefault: r.isDefault,
        /*
         * The parts, in the order the hospital entered them. CGST before SGST
         * is conventional on an Indian invoice and worth preserving; an empty
         * array is the ordinary flat-rate case.
         */
        components: r.components.map((c) => ({
          name: c.name,
          rateBasisPoints: c.rateBasisPoints,
          label: formatRate(c.rateBasisPoints),
        })),
      })),
    };
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @AuditAction('TAX_RATE_ADD')
  async add(@Body() dto: TaxRateDto) {
    const tenantId = currentTenantId();
    this.assertComponentsSum(dto.rateBasisPoints, dto.components);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Exactly one default. Enforced by a partial unique index as well —
        // two defaults would make the rate applied to an unassigned medicine
        // depend on row order, which surfaces months later as an unexplained
        // difference nobody can trace.
        if (dto.isDefault) {
          await tx.taxRate.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
        }
        return tx.taxRate.create({
          data: {
            tenantId,
            name: dto.name.trim(),
            rateBasisPoints: dto.rateBasisPoints,
            isDefault: dto.isDefault ?? false,
            components: {
              create: (dto.components ?? []).map((c, position) => ({
                tenantId,
                name: c.name.trim(),
                rateBasisPoints: c.rateBasisPoints,
                position,
              })),
            },
          },
          include: { components: { orderBy: { position: 'asc' } } },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('You already have a rate with that name');
      }
      throw err;
    }
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('TAX_RATE_UPDATE')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaxRateDto) {
    const existing = await this.prisma.taxRate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Tax rate ${id} not found`);

    this.assertComponentsSum(dto.rateBasisPoints ?? existing.rateBasisPoints, dto.components);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.taxRate.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      /*
       * Changing a rate does NOT restate past invoices. Every line captured
       * `taxRateBasisPoints` and `taxRateName` at the moment it was billed —
       * the same rule that keeps `unitPrice` and `medicineName` on the line
       * rather than following a foreign key. A rate rising from 5% to 12% must
       * not silently change what somebody was charged last year.
       */
      return tx.taxRate.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.rateBasisPoints !== undefined
            ? { rateBasisPoints: dto.rateBasisPoints }
            : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          /*
           * Components are replaced wholesale rather than diffed.
           *
           * They are a short ordered list a human retypes, not rows anybody
           * references — nothing points at a component, because invoices
           * capture the split as data at billing time. Diffing would add
           * identity to something that has none.
           */
          ...(dto.components !== undefined
            ? {
                components: {
                  deleteMany: {},
                  create: dto.components.map((c, position) => ({
                    tenantId: currentTenantId(),
                    name: c.name.trim(),
                    rateBasisPoints: c.rateBasisPoints,
                    position,
                  })),
                },
              }
            : {}),
        },
        include: { components: { orderBy: { position: 'asc' } } },
      });
    });
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('TAX_RATE_REMOVE')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const existing = await this.prisma.taxRate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Tax rate ${id} not found`);

    /*
     * Retired, never deleted.
     *
     * Retiring a rate stops it applying to future sales and leaves every
     * invoice that used it readable — each captured its rate, name and split
     * at the moment it was billed.
     *
     * There is no longer a "cannot retire the default" case: every active rate
     * applies to every sale, so retiring one simply removes that tax. The
     * consequence is visible on the Tax Rates screen, which states the combined
     * rate charged on a sale.
     */
    await this.prisma.taxRate.update({ where: { id }, data: { isActive: false } });
    return { id, removed: true };
  }
}
