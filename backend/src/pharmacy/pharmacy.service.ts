import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DrugClass, PrescriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { checkAllergies, hasBlockingConflict } from './allergy-check';
import { allocateFefo, expiringSoon, inDateQuantity, InsufficientStockError, suggestQuantity } from './stock-selection';
import { DispenseDto } from './dto/dispense.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';

/** Batches inside this window show on the "use or lose" report. */
const EXPIRY_WARNING_DAYS = 60;

@Injectable()
export class PharmacyService {
  constructor(private prisma: PrismaService) {}

  /**
   * Prescriptions waiting to be dispensed, oldest first.
   *
   * A patient standing at the counter has been waiting longest, so the queue
   * is FIFO regardless of who wrote the prescription.
   */
  async queue() {
    const prescriptions = await this.prisma.prescription.findMany({
      where: {
        status: { in: [PrescriptionStatus.ISSUED, PrescriptionStatus.PARTIALLY_DISPENSED] },
      },
      orderBy: { issuedAt: 'asc' },
      take: 100,
      include: {
        items: { include: { medicine: true } },
        patient: {
          select: { id: true, fullName: true, dob: true, allergies: { select: { id: true } } },
        },
        doctor: { select: { id: true, fullName: true } },
      },
    });

    return {
      data: prescriptions.map((p) => ({
        id: p.id,
        issuedAt: p.issuedAt,
        status: p.status,
        notes: p.notes,
        patient: {
          id: p.patient!.id,
          fullName: p.patient!.fullName,
          // A flag only. The substances appear when the pharmacist opens the
          // prescription, which is an audited read.
          hasAllergies: (p.patient!.allergies?.length ?? 0) > 0,
        },
        doctor: p.doctor?.fullName ?? null,
        itemCount: p.items?.length ?? 0,
        /** Any item with no catalogue link cannot be allergy-checked by class. */
        hasUncataloguedItem: (p.items ?? []).some((i) => i.medicineId === null),
      })),
    };
  }

  /**
   * Everything the dispensing screen needs: the prescription, per-item stock,
   * a suggested quantity where one can be worked out, and the allergy check.
   *
   * One call rather than several — a pharmacist should not be able to see the
   * medicines before the allergy check has loaded.
   */
  async prepareDispense(prescriptionId: number) {
    const prescription = await this.prisma.prescription.findUnique({
      where: { id: prescriptionId },
      include: {
        items: { include: { medicine: true } },
        patient: { select: { id: true, fullName: true, dob: true, allergies: true } },
        doctor: { select: { id: true, fullName: true, registrationNo: true } },
      },
    });
    if (!prescription) throw new NotFoundException(`Prescription ${prescriptionId} not found`);

    const now = new Date();
    const items = [];

    for (const item of prescription.items ?? []) {
      const batches = item.medicineId
        ? await this.prisma.stockBatch.findMany({
            where: { medicineId: item.medicineId, quantity: { gt: 0 } },
            orderBy: { expiresAt: 'asc' },
          })
        : [];

      const outstanding = Math.max(0, (suggestQuantity(item.frequency, item.duration) ?? 0) - item.quantityDispensed);

      items.push({
        id: item.id,
        medicineName: item.medicineName,
        dosage: item.dosage,
        frequency: item.frequency,
        duration: item.duration,
        quantityDispensed: item.quantityDispensed,
        medicine: item.medicine
          ? {
              id: item.medicine.id,
              name: item.medicine.name,
              form: item.medicine.form,
              strength: item.medicine.strength,
              drugClass: item.medicine.drugClass,
              isControlled: item.medicine.isControlled,
            }
          : null,
        /** Null means the system will not guess — the pharmacist types it. */
        suggestedQuantity: suggestQuantity(item.frequency, item.duration),
        outstandingQuantity: outstanding > 0 ? outstanding : null,
        inDateStock: inDateQuantity(batches, now),
        batches: batches.map((b) => ({
          id: b.id,
          batchNumber: b.batchNumber,
          expiresAt: b.expiresAt,
          quantity: b.quantity,
          expired: b.expiresAt <= now,
        })),
      });
    }

    const { conflicts, unmatched } = checkAllergies(
      (prescription.items ?? []).map((i) => ({
        medicineName: i.medicineName,
        drugClass: (i.medicine?.drugClass as DrugClass | undefined) ?? null,
        catalogueName: i.medicine?.name ?? null,
      })),
      (prescription.patient?.allergies ?? []).map((a) => ({
        substance: a.substance,
        severity: a.severity,
      })),
    );

    return {
      id: prescription.id,
      issuedAt: prescription.issuedAt,
      status: prescription.status,
      notes: prescription.notes,
      patient: {
        id: prescription.patient!.id,
        fullName: prescription.patient!.fullName,
        dob: prescription.patient!.dob,
        allergies: (prescription.patient?.allergies ?? []).map((a) => ({
          id: a.id,
          substance: a.substance,
          severity: a.severity,
          notes: a.notes,
        })),
      },
      doctor: prescription.doctor,
      items,
      allergyConflicts: conflicts,
      uncataloguedItems: unmatched,
      requiresOverride: hasBlockingConflict(conflicts),
    };
  }

  /**
   * Hand over medicine.
   *
   * Everything happens in one transaction: stock decremented, dispense event
   * written, item totals updated, prescription status recalculated. A partial
   * failure here would leave stock counted as gone with no record of where it
   * went, or a signed dispense against stock that was never taken.
   */
  async dispense(prescriptionId: number, dto: DispenseDto, user: AuthUser) {
    const prepared = await this.prepareDispense(prescriptionId);

    if (prepared.status === PrescriptionStatus.CANCELLED) {
      throw new ConflictException('That prescription was cancelled and cannot be dispensed');
    }
    if (prepared.status === PrescriptionStatus.DISPENSED) {
      throw new ConflictException('That prescription has already been fully dispensed');
    }
    if (dto.lines.length === 0) {
      throw new BadRequestException('Nothing to dispense');
    }

    /**
     * A blocking allergy conflict stops here unless the pharmacist explicitly
     * overrides with a reason.
     *
     * Not a hard refusal: there are real situations where a medicine is given
     * despite a recorded allergy — a label that turns out to be an intolerance
     * rather than an allergy, or a decision taken with the prescriber. A system
     * that cannot express that gets worked around, and the workaround is
     * invisible.
     *
     * So the override exists, demands a reason, and is recorded on the event
     * where anyone reviewing the dispense will see it.
     */
    if (prepared.requiresOverride) {
      if (!dto.overrideReason?.trim()) {
        throw new ConflictException(
          `Blocked: ${prepared.allergyConflicts
            .filter((c) => c.level === 'BLOCKING')
            .map((c) => c.message)
            .join('; ')}. Dispensing this requires a documented reason.`,
        );
      }
      if (dto.overrideReason.trim().length < 10) {
        throw new BadRequestException('The override reason needs to explain the decision');
      }
    }

    const itemsById = new Map(prepared.items.map((i) => [i.id, i]));
    const now = new Date();

    // Work out every allocation before touching anything. If one line cannot
    // be filled, nothing should have moved.
    const planned: { itemId: number; medicineId: number; batchId: number; quantity: number }[] = [];

    for (const line of dto.lines) {
      const item = itemsById.get(line.prescriptionItemId);
      if (!item) {
        throw new BadRequestException(`Item ${line.prescriptionItemId} is not on this prescription`);
      }
      if (!item.medicine) {
        throw new BadRequestException(
          `"${item.medicineName}" is not linked to the catalogue, so stock cannot be tracked. Map it to a medicine first.`,
        );
      }
      if (line.quantity <= 0) {
        throw new BadRequestException('Quantity must be greater than zero');
      }

      try {
        const allocations = allocateFefo(
          item.batches.map((b) => ({
            id: b.id,
            batchNumber: b.batchNumber,
            expiresAt: b.expiresAt as Date,
            quantity: b.quantity,
          })),
          line.quantity,
          now,
        );
        for (const a of allocations) {
          planned.push({
            itemId: item.id,
            medicineId: item.medicine.id,
            batchId: a.batchId,
            quantity: a.quantity,
          });
        }
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          throw new ConflictException(
            `Not enough in-date stock for ${item.medicineName}: ${err.available} available, ${line.quantity} requested`,
          );
        }
        throw err;
      }
    }

    const eventId = await this.prisma.$transaction(async (tx) => {
      const event = await tx.dispenseEvent.create({
        data: {
          tenantId: currentTenantId(),
          prescriptionId,
          pharmacistId: user.userId,
          notes: dto.overrideReason
            ? `ALLERGY OVERRIDE: ${dto.overrideReason.trim()}${dto.notes ? ` — ${dto.notes}` : ''}`
            : dto.notes,
        },
      });

      for (const p of planned) {
        // Conditional decrement: `quantity: { gte: p.quantity }` means a
        // concurrent dispense that emptied the batch first makes this update
        // match zero rows rather than driving stock negative.
        const updated = await tx.stockBatch.updateMany({
          where: { id: p.batchId, quantity: { gte: p.quantity } },
          data: { quantity: { decrement: p.quantity } },
        });
        if (updated.count === 0) {
          throw new ConflictException(
            'Stock changed while this was being dispensed. Reload and try again.',
          );
        }

        await tx.dispenseLine.create({
          data: {
            tenantId: currentTenantId(),
            eventId: event.id,
            prescriptionItemId: p.itemId,
            medicineId: p.medicineId,
            batchId: p.batchId,
            quantity: p.quantity,
          },
        });
      }

      // Per-item running totals.
      const perItem = new Map<number, number>();
      for (const p of planned) perItem.set(p.itemId, (perItem.get(p.itemId) ?? 0) + p.quantity);
      for (const [itemId, quantity] of perItem) {
        await tx.prescriptionItem.update({
          where: { id: itemId },
          data: { quantityDispensed: { increment: quantity } },
        });
      }

      // Fully dispensed only when every item has met its suggested course.
      // Where no quantity could be suggested there is nothing to compare
      // against, so the prescription stays PARTIALLY_DISPENSED and a human
      // decides — better than declaring "complete" on a guess.
      const items = await tx.prescriptionItem.findMany({ where: { prescriptionId } });
      const complete = items.every((i) => {
        const needed = suggestQuantity(i.frequency, i.duration);
        return needed !== null && i.quantityDispensed >= needed;
      });

      await tx.prescription.update({
        where: { id: prescriptionId },
        data: {
          status: complete ? PrescriptionStatus.DISPENSED : PrescriptionStatus.PARTIALLY_DISPENSED,
          dispensedAt: complete ? new Date() : null,
          dispensedById: complete ? user.userId : null,
        },
      });

      return event.id;
    });

    return this.dispenseEvent(eventId);
  }

  async dispenseEvent(id: number) {
    return this.prisma.dispenseEvent.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            medicine: { select: { id: true, name: true, form: true, strength: true } },
            batch: { select: { id: true, batchNumber: true, expiresAt: true } },
          },
        },
        pharmacist: { select: { id: true, fullName: true } },
        prescription: {
          select: { id: true, status: true, patient: { select: { id: true, fullName: true } } },
        },
      },
    });
  }

  async history(limit = 50) {
    return {
      data: await this.prisma.dispenseEvent.findMany({
        orderBy: { dispensedAt: 'desc' },
        take: Math.min(limit, 200),
        include: {
          lines: { include: { medicine: { select: { name: true } } } },
          pharmacist: { select: { id: true, fullName: true } },
          prescription: {
            select: { id: true, patient: { select: { id: true, fullName: true } } },
          },
        },
      }),
    };
  }

  /**
   * Stock, with the two questions a pharmacist actually asks: what is running
   * out, and what is about to expire.
   */
  async inventory(query?: string) {
    const now = new Date();
    const medicines = await this.prisma.medicine.findMany({
      where: {
        isActive: true,
        ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
      include: { batches: { orderBy: { expiresAt: 'asc' } } },
    });

    const rows = medicines.map((m) => {
      const batches = (m.batches ?? []).map((b) => ({
        id: b.id,
        batchNumber: b.batchNumber,
        expiresAt: b.expiresAt,
        quantity: b.quantity,
        expired: b.expiresAt <= now,
      }));
      const inDate = inDateQuantity(
        batches.map((b) => ({ ...b, expiresAt: b.expiresAt as Date })),
        now,
      );

      return {
        id: m.id,
        name: m.name,
        form: m.form,
        strength: m.strength,
        drugClass: m.drugClass,
        isControlled: m.isControlled,
        reorderLevel: m.reorderLevel,
        inDateQuantity: inDate,
        expiredQuantity: batches.filter((b) => b.expired).reduce((s, b) => s + b.quantity, 0),
        belowReorderLevel: inDate < m.reorderLevel,
        expiringSoon: expiringSoon(
          batches.map((b) => ({ ...b, expiresAt: b.expiresAt as Date })),
          EXPIRY_WARNING_DAYS,
          now,
        ),
        batches,
      };
    });

    return {
      data: rows,
      stats: {
        medicines: rows.length,
        belowReorderLevel: rows.filter((r) => r.belowReorderLevel).length,
        outOfStock: rows.filter((r) => r.inDateQuantity === 0).length,
        expiringSoon: rows.filter((r) => r.expiringSoon.length > 0).length,
        hasExpiredStock: rows.filter((r) => r.expiredQuantity > 0).length,
      },
    };
  }

  async receiveStock(
    medicineId: number,
    batchNumber: string,
    expiresAt: Date,
    quantity: number,
    user: AuthUser,
  ) {
    if (user.role !== 'PHARMACIST' && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only pharmacy staff can receive stock');
    }
    if (quantity <= 0) throw new BadRequestException('Quantity must be greater than zero');
    if (expiresAt <= new Date()) {
      throw new BadRequestException('That batch has already expired');
    }

    const medicine = await this.prisma.medicine.findUnique({ where: { id: medicineId } });
    if (!medicine) throw new NotFoundException(`Medicine ${medicineId} not found`);

    // A repeat delivery of the same batch adds to it rather than colliding.
    return this.prisma.stockBatch.upsert({
      where: { medicineId_batchNumber: { medicineId, batchNumber } },
      create: { tenantId: currentTenantId(), medicineId, batchNumber, expiresAt, quantity },
      update: { quantity: { increment: quantity } },
    });
  }
}
