import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { PriceBasis } from './tax';

/**
 * Which taxes a hospital charges, resolved once per sale.
 *
 * WHY THIS IS A SERVICE AND NOT A PRIVATE METHOD ANY MORE
 * -------------------------------------------------------
 * It was `PharmacyService.taxContext`, private, and correct. The lab needed the
 * identical rules — every active rate applies, an item may name one, off means
 * off — and the choice was to copy twenty lines or to move them.
 *
 * Copying would have been quicker and is the failure this repo has paid for
 * twice: two copies of the audit target extractor, one of which was wrong for
 * nested routes; two copies of the treating-scope rule, which had started to
 * drift in wording. Tax is worse than either, because a divergence here does
 * not throw. It under-collects on one kind of sale and over-collects on the
 * other, both invoices look plausible, and nobody finds out until a return is
 * reconciled.
 */
@Injectable()
export class TaxContextService {
  constructor(private readonly prisma: PrismaService) {}

  async current(): Promise<TaxContext> {
    const tenant = await this.prisma.tenant.findUnique({
      // Scoped client: `tenants` has no policy, and asking the pool for a
      // second connection inside the request's transaction is what deadlocked
      // the app once already.
      where: { id: currentTenantId() },
      select: { taxEnabled: true, pricesIncludeTax: true },
    });

    /*
     * Off means off, whatever rates exist.
     *
     * Checked here rather than by deleting rates, so a hospital can build its
     * table and check it before any of it reaches a patient's bill.
     */
    if (!tenant?.taxEnabled) {
      return {
        basis: 'EXCLUSIVE',
        rateFor: () => ({ basisPoints: 0, name: null, components: [] }),
      };
    }

    const rates = await this.prisma.taxRate.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        rateBasisPoints: true,
        isDefault: true,
        components: {
          orderBy: { position: 'asc' },
          select: { name: true, rateBasisPoints: true },
        },
      },
    });

    const byId = new Map(rates.map((r) => [r.id, r]));

    return {
      basis: tenant.pricesIncludeTax ? 'INCLUSIVE' : 'EXCLUSIVE',
      rateFor: (taxRateId) => {
        /*
         * An item with a rate named on it gets exactly that rate.
         *
         * An item with none gets every active rate the hospital has defined —
         * CGST 6% and SGST 6% both apply, and both print. The earlier design
         * made one rate the "default" and the rest inapplicable, so a hospital
         * entering CGST and SGST as two rows had only one of them charged:
         * half the tax, silently, on every sale, on an invoice that looked
         * entirely plausible.
         *
         * To make one item untaxed, point it at a 0% rate. "Exempt" and
         * "Zero-rated" are different on a statutory invoice and identical to
         * the arithmetic, which is exactly why rates carry names.
         */
        const named = taxRateId !== null ? byId.get(taxRateId) : undefined;

        if (named) {
          return {
            basisPoints: named.rateBasisPoints,
            name: named.name,
            components: named.components ?? [],
          };
        }

        /*
         * Every active rate, added — never compounded. Each is charged on the
         * same taxable value, so the combined rate is their sum and each one
         * becomes a component so it prints as its own line.
         */
        return {
          basisPoints: rates.reduce((sum, r) => sum + r.rateBasisPoints, 0),
          name: rates.length === 1 ? rates[0].name : null,
          components: rates.flatMap((r) =>
            // A rate that itself has parts contributes those parts, so a
            // hospital can express either shape without the invoice caring.
            (r.components ?? []).length > 0
              ? r.components
              : [{ name: r.name, rateBasisPoints: r.rateBasisPoints }],
          ),
        };
      },
    };
  }
}

export interface ResolvedRate {
  basisPoints: number;
  name: string | null;
  components: { name: string; rateBasisPoints: number }[];
}

export interface TaxContext {
  basis: PriceBasis;
  rateFor: (taxRateId: number | null) => ResolvedRate;
}
