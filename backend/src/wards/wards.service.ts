import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdmissionStatus, DoseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hospitalDayRange } from '../common/utils/hospital-time';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';

/** An observation older than this is flagged as due on the ward board. */
const OBSERVATION_INTERVAL_HOURS = 4;

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
    const observationsDueBefore = new Date(now.getTime() - OBSERVATION_INTERVAL_HOURS * 3600_000);

    const beds = await this.prisma.bed.findMany({
      where: { wardId },
      orderBy: { label: 'asc' },
      include: {
        admissions: {
          where: { status: AdmissionStatus.ADMITTED },
          include: {
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

      // An empty bed cannot be overdue for observations.
      const observationOverdue =
        admission !== null && (!lastVital || lastVital.recordedAt < observationsDueBefore);

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

function ageFrom(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
