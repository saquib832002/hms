import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdmissionStatus, DoseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hospitalDayRange } from '../common/utils/hospital-time';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';
import { currentTenantId } from '../common/tenancy/tenant-context';
import {
  DEFAULT_FREQUENCY,
  isOverdue,
  nextDueAt,
} from '../observations/observation-frequency';

/*
 * `OBSERVATION_INTERVAL_HOURS = 4` used to live here, and the board applied it
 * to every patient in the hospital — somebody four hours post-operative and
 * somebody waiting for a lift home, on the same timer, with nobody able to
 * change it. The one number deciding whether a nurse gets chased about a
 * deteriorating patient was a constant in this file.
 *
 * It is now per patient: `ObservationOrder`, set by a doctor, tightened by a
 * nurse, defaulting to four-hourly so applying the feature re-times nobody.
 * See `observations/observation-frequency.ts`.
 */

@Injectable()
export class WardsService {
  constructor(
    private clinic: ClinicSettingsService,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  findAll() {
    return this.prisma.ward.findMany({ orderBy: { name: 'asc' } });
  }

  /**
   * Wards with their bed counts, for the setup screen.
   *
   * Separate from `findAll` because the pickers on the ward board and the drug
   * chart want a bare list and this wants occupancy — and a picker that pays
   * for an aggregate on every 15-second refresh is the kind of cost that is
   * invisible until a hospital has forty wards.
   */
  async findAllWithBeds() {
    const wards = await this.prisma.ward.findMany({
      orderBy: { name: 'asc' },
      include: {
        beds: {
          orderBy: { label: 'asc' },
          select: {
            id: true,
            label: true,
            isActive: true,
            admissions: {
              where: { status: AdmissionStatus.ADMITTED },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });

    return wards.map((w) => ({
      id: w.id,
      name: w.name,
      floor: w.floor,
      beds: w.beds.map((b) => ({
        id: b.id,
        label: b.label,
        isActive: b.isActive,
        /*
         * Whether somebody is in it right now, not the patient's name.
         *
         * This is an administrator's screen and admin is operational, never
         * clinical — occupancy is a number, "B-04 holds Mrs Shah" is not. Same
         * line the ward board itself draws by excluding ADMIN entirely.
         */
        occupied: b.admissions.length > 0,
      })),
    }));
  }

  /**
   * Create a ward, and optionally its beds in the same call.
   *
   * WHY THE BEDS COME WITH IT
   * -------------------------
   * A ward with no beds is not a half-built ward, it is a broken one: nobody
   * can be admitted, the board renders an empty table, and nothing on screen
   * says which of the two it is. Bundling the beds into the create means the
   * ordinary path produces something that works.
   */
  async createWard(dto: {
    name: string;
    floor?: string;
    bedCount?: number;
    bedPrefix?: string;
  }) {
    const name = dto.name.trim();
    const existing = await this.prisma.ward.findFirst({ where: { name } });
    if (existing) throw new ConflictException(`You already have a ward called "${name}"`);

    /*
     * `tenantId` is passed explicitly even though `withTenantWrites` would
     * inject it anyway. Same convention as every other service here: the proxy
     * is a safety net for the case somebody forgets, not a reason to leave it
     * out — and Prisma's types require it, which is the check working.
     */
    const tenantId = currentTenantId();

    return this.prisma.$transaction(async (tx) => {
      const ward = await tx.ward.create({
        data: { tenantId, name, floor: dto.floor?.trim() || null },
      });

      if (dto.bedCount && dto.bedCount > 0) {
        await tx.bed.createMany({
          data: bedLabels(dto.bedPrefix ?? defaultPrefix(name), 1, dto.bedCount).map((label) => ({
            tenantId,
            wardId: ward.id,
            label,
          })),
        });
      }

      return tx.ward.findUnique({ where: { id: ward.id }, include: { beds: true } });
    });
  }

  async updateWard(id: number, dto: { name?: string; floor?: string }) {
    const ward = await this.prisma.ward.findUnique({ where: { id } });
    if (!ward) throw new NotFoundException(`Ward ${id} not found`);

    if (dto.name && dto.name.trim() !== ward.name) {
      const clash = await this.prisma.ward.findFirst({ where: { name: dto.name.trim() } });
      if (clash) throw new ConflictException(`You already have a ward called "${dto.name.trim()}"`);
    }

    return this.prisma.ward.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.floor !== undefined ? { floor: dto.floor.trim() || null } : {}),
      },
    });
  }

  /**
   * Add beds to an existing ward.
   *
   * Numbering continues from the highest label already using the prefix rather
   * than restarting at 1, so adding six beds twice gives twelve beds and not a
   * unique-constraint error naming a label the administrator cannot see the
   * point of.
   */
  async addBeds(wardId: number, count: number, prefix?: string) {
    const ward = await this.prisma.ward.findUnique({
      where: { id: wardId },
      include: { beds: { select: { label: true } } },
    });
    if (!ward) throw new NotFoundException(`Ward ${wardId} not found`);

    const use = prefix ?? defaultPrefix(ward.name);
    const start = nextNumber(ward.beds.map((b) => b.label), use);

    await this.prisma.bed.createMany({
      data: bedLabels(use, start, count).map((label) => ({
        tenantId: currentTenantId(),
        wardId,
        label,
      })),
      // A label that already exists is skipped rather than failing the batch.
      // The alternative — refusing all fifteen because one collided — leaves
      // the administrator to work out which, by hand, from a constraint name.
      skipDuplicates: true,
    });

    return this.prisma.bed.findMany({ where: { wardId }, orderBy: { label: 'asc' } });
  }

  /**
   * Rename a bed, or take it out of service.
   *
   * An occupied bed cannot be taken out of service: the patient is in it, and
   * a bed that is simultaneously "closed" and holding somebody is a state the
   * board has no way to draw. Discharge or transfer first.
   */
  async updateBed(id: number, dto: { label?: string; isActive?: boolean }) {
    const bed = await this.prisma.bed.findUnique({
      where: { id },
      include: {
        admissions: { where: { status: AdmissionStatus.ADMITTED }, select: { id: true }, take: 1 },
      },
    });
    if (!bed) throw new NotFoundException(`Bed ${id} not found`);

    if (dto.isActive === false && bed.admissions.length > 0) {
      throw new ConflictException(
        `${bed.label} has a patient in it. Discharge or transfer them before taking the bed out of service.`,
      );
    }

    if (dto.label && dto.label.trim() !== bed.label) {
      const clash = await this.prisma.bed.findFirst({
        where: { wardId: bed.wardId, label: dto.label.trim() },
      });
      if (clash) throw new ConflictException(`This ward already has a bed called "${dto.label.trim()}"`);
    }

    return this.prisma.bed.update({
      where: { id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  /**
   * Delete a bed that has never been used.
   *
   * ANY admission history refuses, not just a current one. An admission names
   * the bed a patient was in, and deleting the row would either break that
   * reference or silently orphan it — "which bed was she in when she fell" is
   * exactly the question asked after the stay has ended. Out of service is the
   * answer for a bed that exists and should not be filled.
   */
  async removeBed(id: number) {
    const bed = await this.prisma.bed.findUnique({
      where: { id },
      include: { admissions: { select: { id: true }, take: 1 } },
    });
    if (!bed) throw new NotFoundException(`Bed ${id} not found`);

    if (bed.admissions.length > 0) {
      throw new ConflictException(
        `${bed.label} has been used before, so its history has to stay. Take it out of service instead.`,
      );
    }

    await this.prisma.bed.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** Same rule as a bed: a ward any patient has ever occupied is history. */
  async removeWard(id: number) {
    const ward = await this.prisma.ward.findUnique({
      where: { id },
      include: { beds: { include: { admissions: { select: { id: true }, take: 1 } } } },
    });
    if (!ward) throw new NotFoundException(`Ward ${id} not found`);

    const used = ward.beds.filter((b) => b.admissions.length > 0);
    if (used.length > 0) {
      throw new ConflictException(
        `${ward.name} has beds that have been used (${used.map((b) => b.label).join(', ')}), so its history has to stay.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.bed.deleteMany({ where: { wardId: id } });
      await tx.ward.delete({ where: { id } });
    });
    return { id, deleted: true };
  }

  /**
   * The ward board: every bed, who is in it, and what needs doing.
   *
   * Deliberately one query set rather than a bed list the client then
   * enriches. A nurse opens this at the start of a shift to find out what is
   * outstanding, and N+1 requests over hospital wifi would make the most
   * time-critical screen in the app the slowest.
   */
  async board(wardId: number) {
    const ward = await this.prisma.ward.findUnique({ where: { id: wardId } });
    if (!ward) throw new NotFoundException(`Ward ${wardId} not found`);

    const tz = (await this.clinic.current()).timezone;
    const now = new Date();
    const { end: endOfDay } = hospitalDayRange(now, tz);

    const beds = await this.prisma.bed.findMany({
      where: { wardId },
      orderBy: { label: 'asc' },
      include: {
        admissions: {
          where: { status: AdmissionStatus.ADMITTED },
          include: {
            /*
             * The newest order only. Each change writes a new row rather than
             * editing one, so the history stays readable — but the board wants
             * the plan in force now, and pulling every change for every bed
             * would grow with the length of the stay.
             */
            observationOrders: { orderBy: { setAt: 'desc' }, take: 1 },
            escalations: {
              where: { respondedAt: null },
              select: { id: true },
            },
            patient: {
              select: {
                id: true,
                fullName: true,
                dob: true,
                gender: true,
                allergies: { select: { id: true } },
              },
            },
            vitals: { orderBy: { recordedAt: 'desc' }, take: 1 },
            doses: {
              where: { status: DoseStatus.DUE, dueAt: { lt: endOfDay } },
              orderBy: { dueAt: 'asc' },
              take: 1,
              include: { prescriptionItem: { select: { medicineName: true, dosage: true } } },
            },
          },
        },
      },
    });

    const rows = beds.map((bed) => {
      const admission = bed.admissions?.[0] ?? null;
      const lastVital = admission?.vitals?.[0] ?? null;
      const nextDose = admission?.doses?.[0] ?? null;

      /*
       * This patient's own frequency, not one number for the hospital.
       *
       * `isOverdue` treats "never observed" as overdue, and that is the case
       * that matters most: somebody admitted an hour ago whose baseline was
       * never taken is exactly who the board should be shouting about, and
       * reading no data as nothing-to-worry-about is how they stay invisible.
       */
      const frequency = admission?.observationOrders?.[0]?.frequency ?? DEFAULT_FREQUENCY;
      const observationOverdue =
        admission !== null && isOverdue(lastVital?.recordedAt ?? null, frequency, now);

      return {
        bed: { id: bed.id, label: bed.label, isActive: bed.isActive },
        admission: admission
          ? {
              id: admission.id,
              admittedAt: admission.admittedAt,
              reason: admission.reason,
              patient: {
                id: admission.patient!.id,
                fullName: admission.patient!.fullName,
                age: ageFrom(admission.patient!.dob as Date),
                gender: admission.patient!.gender,
                // A flag, not the substances — the detail belongs on a screen
                // the nurse deliberately opened, which is an audited read.
                hasAllergies: (admission.patient!.allergies?.length ?? 0) > 0,
              },
              lastVital: lastVital
                ? {
                    recordedAt: lastVital.recordedAt,
                    systolic: lastVital.systolic,
                    diastolic: lastVital.diastolic,
                    pulse: lastVital.pulse,
                  }
                : null,
              observationOverdue,
              /*
               * Sent so the board can say "4-hourly" beside the flag rather
               * than only that something is late. A nurse deciding what to do
               * next needs to know whether this patient is on hourly obs or
               * once-daily, and "overdue" alone means different things.
               */
              observationFrequency: frequency,
              nextObservationDue: nextDueAt(lastVital?.recordedAt ?? null, frequency),
              /*
               * An escalation nobody answered is the single most useful thing
               * on this row. It is why the board shows a count rather than
               * leaving it to a screen somebody has to open.
               */
              openEscalations: admission.escalations?.length ?? 0,
              nextDose: nextDose
                ? {
                    id: nextDose.id,
                    dueAt: nextDose.dueAt,
                    medicineName: nextDose.prescriptionItem?.medicineName ?? '',
                    dosage: nextDose.prescriptionItem?.dosage ?? '',
                  }
                : null,
            }
          : null,
      };
    });

    const occupied = rows.filter((r) => r.admission).length;

    return {
      ward: { id: ward.id, name: ward.name, floor: ward.floor },
      stats: {
        beds: rows.length,
        occupied,
        available: rows.filter((r) => !r.admission && r.bed.isActive).length,
        outOfService: rows.filter((r) => !r.bed.isActive).length,
        observationsOverdue: rows.filter((r) => r.admission?.observationOverdue).length,
      },
      beds: rows,
    };
  }
}

/**
 * "General Ward" → "GEN". The initials of a multi-word name, otherwise the
 * first three letters — a guess at what the hospital would have typed, offered
 * so that the common case needs no decision. The administrator can override it.
 */
function defaultPrefix(wardName: string): string {
  const words = wardName.trim().split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'B');
  return initials.slice(0, 3).toUpperCase();
}

/**
 * Zero-padded to two digits so labels sort the way a person expects.
 *
 * `orderBy: { label: 'asc' }` is a string sort in Postgres, so B-2 lands
 * between B-19 and B-20 without the padding — the ward board would list beds
 * in an order no nurse walking the ward would recognise.
 */
function bedLabels(prefix: string, start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const n = start + i;
    return `${prefix}-${String(n).padStart(2, '0')}`;
  });
}

/** One past the highest number already using this prefix. */
function nextNumber(labels: string[], prefix: string): number {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}-(\\d+)$`);
  const highest = labels.reduce((max, label) => {
    const m = pattern.exec(label);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return highest + 1;
}

function ageFrom(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
