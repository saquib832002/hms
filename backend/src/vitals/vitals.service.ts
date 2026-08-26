import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AdmissionStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { CreateVitalDto } from './dto/create-vital.dto';
import { flagVitals, implausible, isEmptyReading, VitalReading } from './vital-ranges';
import { currentTenantId } from '../common/tenancy/tenant-context';

@Injectable()
export class VitalsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Record a set of observations.
   *
   * IDEMPOTENT BY `clientRef`
   * -------------------------
   * These are entered at the bedside, frequently with no signal, and replayed
   * from the device's outbox when it returns. The failure this guards against
   * is not a double-tap: it is a request that reached the server, was written,
   * and then timed out on the way back. The device cannot tell that apart from
   * a request that never arrived, so it retries — and without a dedupe key the
   * observation chart grows a phantom duplicate reading.
   *
   * Returning the existing row (rather than erroring) makes the replay a no-op
   * from the device's point of view, which is what lets the outbox retry
   * blindly.
   */
  async create(dto: CreateVitalDto, user: AuthUser) {
    if (user.role !== UserRole.NURSE && user.role !== UserRole.DOCTOR) {
      throw new ForbiddenException('Only clinical staff can record observations');
    }

    if (dto.clientRef) {
      const existing = await this.prisma.vital.findUnique({
        where: { clientRef: dto.clientRef },
        include: this.include(),
      });
      if (existing) return this.withFlags(existing);
    }

    const reading: VitalReading = {
      systolic: dto.systolic,
      diastolic: dto.diastolic,
      pulse: dto.pulse,
      temperatureC: dto.temperatureC,
      respiratoryRate: dto.respiratoryRate,
      spo2: dto.spo2,
      painScore: dto.painScore,
    };

    if (isEmptyReading(reading) && !dto.notes) {
      throw new BadRequestException('Record at least one observation');
    }

    // Typos are rejected rather than flagged. A temperature of 370 stored as
    // "critical" pollutes the chart a clinician reads at a glance.
    const problems = implausible(reading);
    if (problems.length) throw new BadRequestException(problems.join('; '));

    const patient = await this.prisma.patient.findUnique({
      where: { id: dto.patientId },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException(`Patient ${dto.patientId} not found`);

    // Link to the current admission if there is one, so the observation lands
    // on this stay's chart rather than floating free.
    const admission = await this.prisma.admission.findFirst({
      where: { patientId: dto.patientId, status: AdmissionStatus.ADMITTED },
      select: { id: true },
    });

    try {
      const created = await this.prisma.vital.create({
        data: {
          tenantId: currentTenantId(),
          patientId: dto.patientId,
          admissionId: admission?.id ?? null,
          recordedById: user.userId,
          recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : new Date(),
          systolic: dto.systolic,
          diastolic: dto.diastolic,
          pulse: dto.pulse,
          temperatureC: dto.temperatureC,
          respiratoryRate: dto.respiratoryRate,
          spo2: dto.spo2,
          painScore: dto.painScore,
          notes: dto.notes,
          clientRef: dto.clientRef,
        },
        include: this.include(),
      });
      return this.withFlags(created);
    } catch (err) {
      // Two replays racing each other — the loser reads the winner's row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && dto.clientRef) {
        const existing = await this.prisma.vital.findUnique({
          where: { clientRef: dto.clientRef },
          include: this.include(),
        });
        if (existing) return this.withFlags(existing);
      }
      throw err;
    }
  }

  async findForPatient(patientId: number, limit = 50) {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: { dob: true },
    });
    if (!patient) throw new NotFoundException(`Patient ${patientId} not found`);

    const rows = await this.prisma.vital.findMany({
      where: { patientId },
      orderBy: { recordedAt: 'desc' },
      take: Math.min(limit, 200),
      include: this.include(),
    });

    return { data: rows.map((r) => this.withFlags(r, ageFrom(patient.dob as Date))) };
  }

  /**
   * Flags are computed on read rather than stored.
   *
   * Reference ranges are a clinical policy that changes; a stored flag would
   * be frozen at whatever the thresholds were on the day it was written, and
   * the chart would show two different judgements of the same number.
   */
  private withFlags(vital: Record<string, unknown>, ageYears?: number) {
    const age = ageYears ?? ageFrom((vital.patient as { dob?: Date })?.dob ?? new Date());
    const reading: VitalReading = {
      systolic: vital.systolic as number | null,
      diastolic: vital.diastolic as number | null,
      pulse: vital.pulse as number | null,
      temperatureC: vital.temperatureC != null ? Number(vital.temperatureC) : null,
      respiratoryRate: vital.respiratoryRate as number | null,
      spo2: vital.spo2 as number | null,
      painScore: vital.painScore as number | null,
    };
    return {
      ...vital,
      // Decimal serialises awkwardly to JSON — send it as a string.
      temperatureC: vital.temperatureC != null ? String(vital.temperatureC) : null,
      flags: flagVitals(reading, age),
    };
  }

  private include() {
    return {
      recordedBy: { select: { id: true, fullName: true, role: true } },
      patient: { select: { id: true, fullName: true, dob: true } },
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
