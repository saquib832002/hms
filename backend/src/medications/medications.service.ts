import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdmissionStatus, DoseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { hospitalDate, hospitalDayRange, zonedTimeToUtc } from '../common/utils/hospital-time';
import { doseTimesFor, parseFrequency, whyNotScheduled } from './dose-frequency';
import { ScheduleDosesDto } from './dto/schedule-doses.dto';
import { RecordDoseDto } from './dto/record-dose.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';

/** A dose still DUE this long after its time is shown as overdue. */
const OVERDUE_AFTER_MINUTES = 30;

@Injectable()
export class MedicationsService {
  constructor(
    private clinic: ClinicSettingsService,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * The caller's hospital timezone.
   *
   * Async because it is a per-tenant lookup now, not a process-wide
   * constant — two hospitals on one deployment keep different clocks, and
   * the clock decides what "today" contains.
   */
  private async tz(): Promise<string> {
    return (await this.clinic.current()).timezone;
  }

  /**
   * Build the drug chart for an admission from an existing prescription.
   *
   * Items whose frequency cannot be confidently parsed are NOT scheduled —
   * they come back in `unscheduled` with a reason, for a nurse to set by hand.
   * See dose-frequency.ts for why guessing is the wrong move.
   */
  async schedule(admissionId: number, dto: ScheduleDosesDto) {
    const admission = await this.prisma.admission.findUnique({
      where: { id: admissionId },
      select: { id: true, patientId: true, status: true },
    });
    if (!admission) throw new NotFoundException(`Admission ${admissionId} not found`);
    if (admission.status !== AdmissionStatus.ADMITTED) {
      throw new ConflictException('That patient has been discharged');
    }

    const prescription = await this.prisma.prescription.findUnique({
      where: { id: dto.prescriptionId },
      include: { items: true },
    });
    if (!prescription) throw new NotFoundException(`Prescription ${dto.prescriptionId} not found`);
    if (prescription.patientId !== admission.patientId) {
      throw new BadRequestException('That prescription belongs to a different patient');
    }

    const days = dto.days ?? 3;
    const now = new Date();
    // Resolved once, up front. These two closures run inside the scheduling
    // loop, and awaiting a lookup per dose would issue one query per scheduled
    // administration — a three-day chart for six medicines is a lot of
    // needless round trips for a value that cannot change mid-request.
    const tz = await this.tz();
    const toUtc = (p: { year: number; month: number; day: number; hour: number }) =>
      zonedTimeToUtc(p, tz);
    const dayOf = (d: Date) => hospitalDate(d, tz);

    const created: unknown[] = [];
    const unscheduled: { itemId: number; medicineName: string; reason: string }[] = [];

    for (const item of prescription.items ?? []) {
      const parsed = parseFrequency(item.frequency);
      if (!parsed) {
        unscheduled.push({
          itemId: item.id,
          medicineName: item.medicineName,
          reason: whyNotScheduled(item.frequency),
        });
        continue;
      }

      for (const dueAt of doseTimesFor(parsed, now, days, toUtc, dayOf)) {
        try {
          created.push(
            await this.prisma.medicationAdministration.create({
              data: {
                tenantId: currentTenantId(),
                prescriptionItemId: item.id,
                admissionId,
                patientId: admission.patientId,
                dueAt,
              },
            }),
          );
        } catch (err) {
          // @@unique([prescriptionItemId, dueAt]) — re-running the scheduler
          // must not duplicate a chart that already exists.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
          throw err;
        }
      }
    }

    return { scheduled: created.length, unscheduled };
  }

  /**
   * The medication round for a ward: what is overdue, due now, and coming up.
   *
   * Grouped by urgency rather than returned as a flat list, because that is
   * the question a nurse is actually asking — "what have I missed" comes
   * before "what is next".
   */
  async round(wardId: number, dateParam?: string) {
    const { start, end } = dateParam
      ? hospitalDayRange(new Date(`${dateParam}T12:00:00Z`), await this.tz())
      : hospitalDayRange(new Date(), await this.tz());

    const doses = await this.prisma.medicationAdministration.findMany({
      where: {
        dueAt: { gte: start, lt: end },
        admission: { status: AdmissionStatus.ADMITTED, bed: { wardId } },
      },
      orderBy: { dueAt: 'asc' },
      include: {
        prescriptionItem: {
          select: { id: true, medicineName: true, dosage: true, frequency: true },
        },
        admission: {
          select: {
            id: true,
            bed: { select: { id: true, label: true } },
            patient: {
              select: { id: true, fullName: true, allergies: { select: { id: true } } },
            },
          },
        },
        givenBy: { select: { id: true, fullName: true } },
      },
    });

    const now = Date.now();
    const overdueBefore = now - OVERDUE_AFTER_MINUTES * 60_000;

    const shaped = doses.map((d) => ({
      id: d.id,
      dueAt: d.dueAt,
      status: d.status,
      givenAt: d.givenAt,
      givenBy: d.givenBy?.fullName ?? null,
      notes: d.notes,
      medicineName: d.prescriptionItem?.medicineName ?? '',
      dosage: d.prescriptionItem?.dosage ?? '',
      bed: d.admission?.bed?.label ?? '',
      admissionId: d.admissionId,
      patient: {
        id: d.admission?.patient?.id ?? d.patientId,
        fullName: d.admission?.patient?.fullName ?? '',
        hasAllergies: (d.admission?.patient?.allergies?.length ?? 0) > 0,
      },
    }));

    const isPending = (s: DoseStatus) => s === DoseStatus.DUE;

    return {
      wardId,
      timezone: await this.tz(),
      overdue: shaped.filter((d) => isPending(d.status) && d.dueAt.getTime() < overdueBefore),
      dueNow: shaped.filter(
        (d) => isPending(d.status) && d.dueAt.getTime() >= overdueBefore && d.dueAt.getTime() <= now + 30 * 60_000,
      ),
      upcoming: shaped.filter((d) => isPending(d.status) && d.dueAt.getTime() > now + 30 * 60_000),
      completed: shaped.filter((d) => !isPending(d.status)),
    };
  }

  /**
   * Record what happened to a dose.
   *
   * Idempotent by `clientRef` for the same reason vitals are — medication
   * rounds happen in corridors, and a retry after a timeout must not record a
   * second administration of a medicine given once.
   *
   * A dose that has already been actioned cannot be re-actioned. Marking a
   * GIVEN dose as MISSED would rewrite the record of a medicine a patient
   * actually received; correcting a genuine mistake is a note, not an edit.
   */
  async record(doseId: number, dto: RecordDoseDto, user: AuthUser) {
    const dose = await this.prisma.medicationAdministration.findUnique({
      where: { id: doseId },
      include: { admission: { select: { status: true } } },
    });
    if (!dose) throw new NotFoundException(`Dose ${doseId} not found`);

    if (dto.clientRef && dose.clientRef === dto.clientRef) {
      return this.shapeDose(doseId); // replay of a write that already landed
    }

    if (dose.status !== DoseStatus.DUE) {
      throw new ConflictException(
        `That dose is already recorded as ${dose.status.toLowerCase()} and cannot be changed`,
      );
    }

    if (dto.status === DoseStatus.DUE) {
      throw new BadRequestException('Choose what happened to the dose');
    }

    // A reason is required for anything other than "given" — at a handover,
    // "not given" without a why is close to useless.
    if (dto.status !== DoseStatus.GIVEN && !dto.notes?.trim()) {
      throw new BadRequestException(`Add a note explaining why the dose was ${dto.status.toLowerCase()}`);
    }

    await this.prisma.medicationAdministration.update({
      where: { id: doseId },
      data: {
        status: dto.status,
        givenAt: dto.status === DoseStatus.GIVEN ? (dto.givenAt ? new Date(dto.givenAt) : new Date()) : null,
        givenById: user.userId,
        notes: dto.notes,
        clientRef: dto.clientRef,
      },
    });

    return this.shapeDose(doseId);
  }

  private async shapeDose(id: number) {
    return this.prisma.medicationAdministration.findUnique({
      where: { id },
      include: {
        prescriptionItem: { select: { medicineName: true, dosage: true } },
        givenBy: { select: { id: true, fullName: true } },
      },
    });
  }
}
