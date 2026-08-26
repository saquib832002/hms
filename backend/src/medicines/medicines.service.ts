import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMedicineDto } from './dto/create-medicine.dto';
import { UpdateMedicineDto } from './dto/update-medicine.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';

@Injectable()
export class MedicinesService {
  constructor(private prisma: PrismaService) {}

  async findAll(query?: string, includeInactive = false) {
    return {
      data: await this.prisma.medicine.findMany({
        where: {
          ...(includeInactive ? {} : { isActive: true }),
          ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
        },
        orderBy: { name: 'asc' },
        take: 200,
      }),
    };
  }

  async create(dto: CreateMedicineDto) {
    try {
      return await this.prisma.medicine.create({
        data: { ...dto, tenantId: currentTenantId() },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A medicine with that name already exists');
      }
      throw err;
    }
  }

  async update(id: number, dto: UpdateMedicineDto) {
    await this.require(id);
    try {
      return await this.prisma.medicine.update({ where: { id }, data: dto });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A medicine with that name already exists');
      }
      throw err;
    }
  }

  /**
   * Link a free-text prescription item to the catalogue.
   *
   * Needed because `medicineName` is kept verbatim and the backfill only
   * matches exact names — anything the prescriber spelled differently arrives
   * here for a human to map. Until it is mapped the item cannot be
   * allergy-checked by class or dispensed against stock, which is why the
   * dispensing screen calls those items out.
   *
   * The prescribed text is never rewritten. Only the link is added.
   */
  async linkPrescriptionItem(itemId: number, medicineId: number) {
    const [item, medicine] = await Promise.all([
      this.prisma.prescriptionItem.findUnique({ where: { id: itemId } }),
      this.prisma.medicine.findUnique({ where: { id: medicineId } }),
    ]);
    if (!item) throw new NotFoundException(`Prescription item ${itemId} not found`);
    if (!medicine) throw new NotFoundException(`Medicine ${medicineId} not found`);

    return this.prisma.prescriptionItem.update({
      where: { id: itemId },
      data: { medicineId },
      include: { medicine: true },
    });
  }

  /** Items with no catalogue link — the backfill's leftovers. */
  async unmappedItems() {
    const items = await this.prisma.prescriptionItem.findMany({
      where: { medicineId: null },
      orderBy: { id: 'desc' },
      take: 200,
      include: { prescription: { select: { id: true, issuedAt: true, status: true } } },
    });

    // Grouped by the text as written, because the same misspelling recurs and
    // mapping it once per prescription would be tedious.
    const grouped = new Map<string, { medicineName: string; itemIds: number[] }>();
    for (const item of items) {
      const key = item.medicineName.trim().toLowerCase();
      const entry = grouped.get(key) ?? { medicineName: item.medicineName, itemIds: [] };
      entry.itemIds.push(item.id);
      grouped.set(key, entry);
    }
    return { data: [...grouped.values()] };
  }

  private async require(id: number) {
    const found = await this.prisma.medicine.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException(`Medicine ${id} not found`);
    return found;
  }
}
