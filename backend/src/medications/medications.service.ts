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
import { doseTimesFor, isAsNeeded, parseFrequency, whyNotScheduled } from './dose-frequency';
import { ScheduleDosesDto } from './dto/schedule-doses.dto';
import { RecordDoseDto } from './dto/record-dose.dto';
import { ManualScheduleDto, OneOffDoseDto } from './dto/manual-schedule.dto';
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

    const times: Prisma.MedicationAdministrationCreateManyInput[] = [];
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

      times.push(
        ...doseTimesFor(parsed, now, days, toUtc, dayOf).map((dueAt) => ({
          tenantId: currentTenantId(),
          prescriptionItemId: item.id,
          admissionId,
          patientId: admission.patientId,
          dueAt,
        })),
      );
    }

    /*
     * One insert, not one per dose.
     *
     * This was a `create` inside a nested loop: a three-day chart for six
     * medicines given four times a day is 72 round trips, inside the request's
     * own transaction, holding a pool connection the whole time. `skipDuplicates`
     * does what the per-row P2002 catch did — `@@unique([prescriptionItemId,
     * dueAt])` means re-running the scheduler must not duplicate a chart that
     * already exists.
     */
    const { count } = await this.prisma.medicationAdministration.createMany({
      data: times,
      skipDuplicates: true,
    });

    return { scheduled: count, unscheduled };
  }

  /**
   * Dose times a nurse set by hand, for an item the parser would not guess at.
   *
   * The other half of `schedule()`. That method deliberately refuses anything
   * it cannot read confidently and hands the item back as `unscheduled` with a
   * reason — which was correct and went nowhere, because nothing in either
   * client could act on it. A medicine that is prescribed, not charted, and
   * explained only by a sentence in a dialog is a medicine that does not get
   * given.
   */
  async scheduleManually(admissionId: number, dto: ManualScheduleDto) {
    const admission = await this.requireOpenAdmission(admissionId);

    const item = await this.prisma.prescriptionItem.findUnique({
      where: { id: dto.prescriptionItemId },
      include: { prescription: { select: { patientId: true, status: true } } },
    });
    if (!item) throw new NotFoundException(`Prescription item ${dto.prescriptionItemId} not found`);
    if (item.prescription?.patientId !== admission.patientId) {
      throw new BadRequestException('That medicine belongs to a different patient');
    }
    /*
     * A cancelled prescription must not become a drug chart — the same rule
     * the automatic scheduler follows, restated because this path does not go
     * through it. `schedule-medication-sheet` already refuses to chart a
     * cancelled prescription client-side, and the client is not the boundary.
     */
    if (item.prescription?.status === 'CANCELLED') {
      throw new ConflictException('That prescription has been cancelled');
    }

    const days = dto.days ?? 3;
    const tz = await this.tz();
    const now = new Date();
    const first = hospitalDate(now, tz);

    const rows: Prisma.MedicationAdministrationCreateManyInput[] = [];
    for (let offset = 0; offset < days; offset++) {
      const base = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
      for (const hhmm of dto.times) {
        const [hour, minute] = hhmm.split(':').map(Number);
        const dueAt = zonedTimeToUtc(
          {
            year: base.getUTCFullYear(),
            month: base.getUTCMonth() + 1,
            day: base.getUTCDate(),
            hour,
            minute,
          },
          tz,
        );
        // Times already past today are skipped, exactly as the automatic
        // scheduler does — a chart built at 14:00 should not open showing a
        // missed 08:00 dose nobody was ever asked to give.
        if (dueAt.getTime() < now.getTime()) continue;
        rows.push({
          tenantId: currentTenantId(),
          prescriptionItemId: item.id,
          admissionId,
          patientId: admission.patientId,
          dueAt,
        });
      }
    }

    if (rows.length === 0) {
      throw new BadRequestException(
        'Every one of those times has already passed today. Add a later time, or schedule more than one day.',
      );
    }

    const { count } = await this.prisma.medicationAdministration.createMany({
      data: rows,
      skipDuplicates: true,
    });

    return { scheduled: count, requested: rows.length };
  }

  /**
   * A single dose: STAT, or an "as needed" one being recorded as given.
   *
   * With no `status` this creates a dose that is due — the ward-round STAT
   * case. With a status it creates the dose already signed for, which is what
   * PRN needs: nothing was ever *due*, so there is no row to find and action
   * later. `whyNotScheduled` has been telling nurses to "record each dose as it
   * is given" since Phase 3 with nowhere to do it.
   */
  async addOneOffDose(admissionId: number, dto: OneOffDoseDto, user: AuthUser) {
    const admission = await this.requireOpenAdmission(admissionId);

    const item = await this.prisma.prescriptionItem.findUnique({
      where: { id: dto.prescriptionItemId },
      include: { prescription: { select: { patientId: true, status: true } } },
    });
    if (!item) throw new NotFoundException(`Prescription item ${dto.prescriptionItemId} not found`);
    if (item.prescription?.patientId !== admission.patientId) {
      throw new BadRequestException('That medicine belongs to a different patient');
    }
    if (item.prescription?.status === 'CANCELLED') {
      throw new ConflictException('That prescription has been cancelled');
    }

    if (dto.status === DoseStatus.DUE) {
      throw new BadRequestException('Leave the status out to add a dose that is simply due');
    }
    // Same rule as `record()`, restated because this path does not go through
    // it: at a handover, "not given" without a why is close to useless.
    if (dto.status && dto.status !== DoseStatus.GIVEN && !dto.notes?.trim()) {
      throw new BadRequestException(
        `Add a note explaining why the dose was ${dto.status.toLowerCase()}`,
      );
    }

    const dueAt = dto.dueAt ? new Date(dto.dueAt) : new Date();

    const created = await this.prisma.medicationAdministration.create({
      data: {
        tenantId: currentTenantId(),
        prescriptionItemId: item.id,
        admissionId,
        patientId: admission.patientId,
        dueAt,
        ...(dto.status
          ? {
              status: dto.status,
              givenAt:
                dto.status === DoseStatus.GIVEN ? (dto.givenAt ? new Date(dto.givenAt) : dueAt) : null,
              givenById: user.userId,
              notes: dto.notes,
            }
          : {}),
      },
    });

    return this.shapeDose(created.id);
  }

  /**
   * The drug chart for one stay — the MAR.
   *
   * WHY A CHART AND NOT JUST THE ROUND
   * ----------------------------------
   * The round answers "what is due on this ward today", which is the right
   * question while giving out medicines and the wrong one everywhere else. A
   * nurse taking over a patient, or a doctor on a ward round, asks "what is
   * this person on, and what have they actually had" — and that view did not
   * exist anywhere in the system.
   *
   * **Prescribed-but-not-charted items are the point.** Querying the chart from
   * the doses would show only medicines that were successfully scheduled, so
   * the ones the parser refused — precisely the ones needing attention — would
   * be invisible. They are read from the prescription instead and returned
   * beside the charted ones, each carrying why it was not scheduled and what to
   * do about it.
   */
  async chart(admissionId: number) {
    const admission = await this.prisma.admission.findUnique({
      where: { id: admissionId },
      select: {
        id: true,
        admittedAt: true,
        status: true,
        patientId: true,
        bed: { select: { label: true, ward: { select: { id: true, name: true } } } },
        patient: {
          select: {
            id: true,
            fullName: true,
            dob: true,
            allergies: { select: { id: true, substance: true } },
          },
        },
      },
    });
    if (!admission) throw new NotFoundException(`Admission ${admissionId} not found`);

    const doses = await this.prisma.medicationAdministration.findMany({
      where: { admissionId },
      orderBy: { dueAt: 'asc' },
      include: { givenBy: { select: { fullName: true } } },
    });

    /*
     * Every non-cancelled prescription for this patient, not only those written
     * during the stay. A patient admitted on their regular medicines has those
     * on a prescription written before they arrived, and leaving them off the
     * chart is how a long-term drug gets quietly stopped by an admission.
     */
    const prescriptions = await this.prisma.prescription.findMany({
      where: { patientId: admission.patientId, status: { not: 'CANCELLED' } },
      orderBy: { issuedAt: 'desc' },
      include: {
        items: true,
        doctor: { select: { user: { select: { fullName: true } } } },
      },
    });

    const dosesByItem = new Map<number, typeof doses>();
    for (const d of doses) {
      const list = dosesByItem.get(d.prescriptionItemId) ?? [];
      list.push(d);
      dosesByItem.set(d.prescriptionItemId, list);
    }

    const medicines = prescriptions.flatMap((p) =>
      p.items.map((item) => {
        const itemDoses = dosesByItem.get(item.id) ?? [];
        const parsed = parseFrequency(item.frequency);

        return {
          prescriptionItemId: item.id,
          prescriptionId: p.id,
          issuedAt: p.issuedAt,
          prescriber: p.doctor?.user?.fullName ?? null,
          medicineName: item.medicineName,
          dosage: item.dosage,
          frequency: item.frequency,
          duration: item.duration,
          /** What the parser made of the frequency, or null if it refused. */
          scheduleLabel: parsed?.label ?? null,
          /** Why there are no times, in words the nurse can act on. */
          notScheduledReason: itemDoses.length === 0 ? whyNotScheduled(item.frequency) : null,
          /*
           * PRN is not "unrecognised", and the difference decides what the
           * screen should offer. An unreadable frequency wants times set; an
           * as-needed medicine must never get them, and wants a dose recorded
           * when it is actually given.
           */
          asNeeded: isAsNeeded(item.frequency),
          doses: itemDoses.map((d) => ({
            id: d.id,
            dueAt: d.dueAt,
            status: d.status,
            givenAt: d.givenAt,
            givenBy: d.givenBy?.fullName ?? null,
            notes: d.notes,
          })),
        };
      }),
    );

    return {
      admission: {
        id: admission.id,
        admittedAt: admission.admittedAt,
        status: admission.status,
        bed: admission.bed?.label ?? null,
        ward: admission.bed?.ward?.name ?? null,
      },
      patient: {
        id: admission.patient!.id,
        fullName: admission.patient!.fullName,
        age: ageFrom(admission.patient!.dob as Date),
        /*
         * The substances, not a flag.
         *
         * The ward board shows a dot because it is a list of many patients and
         * the detail belongs on a screen somebody deliberately opened. This is
         * that screen, and it is the one where a nurse is about to give a drug
         * — "has allergies" without saying to what is the least useful possible
         * form of that warning at the moment it matters.
         */
        allergies: admission.patient!.allergies.map((a) => a.substance),
      },
      timezone: await this.tz(),
      medicines,
    };
  }

  /** Shared by both manual paths: the stay has to be open to chart against. */
  private async requireOpenAdmission(admissionId: number) {
    const admission = await this.prisma.admission.findUnique({
      where: { id: admissionId },
      select: { id: true, patientId: true, status: true },
    });
    if (!admission) throw new NotFoundException(`Admission ${admissionId} not found`);
    if (admission.status !== AdmissionStatus.ADMITTED) {
      throw new ConflictException('That patient has been discharged');
    }
    return admission;
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

/** Age today, not at admission — a chart is read now, not filed. */
function ageFrom(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
