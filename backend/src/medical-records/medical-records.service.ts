import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppointmentStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { hospitalDayRange } from '../common/utils/hospital-time';
import { CreateMedicalRecordDto } from './dto/create-medical-record.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';

/** Statuses that mean the doctor is actually seeing this patient today. */
const IN_CONSULTATION = [
  AppointmentStatus.CHECKED_IN,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.COMPLETED,
];

@Injectable()
export class MedicalRecordsService {
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
   * Writing a clinical record requires an actual clinical relationship.
   *
   * Without this check any doctor could write a diagnosis against any patient
   * in the hospital — the route guard says "doctors may write records", which
   * is true and insufficient. Tying the write to today's appointment is what
   * makes the permission specific to *this* patient.
   */
  private async assertTreatingToday(doctorId: number, patientId: number) {
    const { start, end } = hospitalDayRange(new Date(), await this.tz());
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        doctorId,
        patientId,
        scheduledAt: { gte: start, lt: end },
        status: { in: IN_CONSULTATION },
      },
      select: { id: true },
    });

    if (!appointment) {
      throw new ForbiddenException(
        'You can only write records for patients you are seeing today',
      );
    }
    return appointment.id;
  }

  async create(patientId: number, dto: CreateMedicalRecordDto, user: AuthUser) {
    if (!user.doctorId) {
      throw new ForbiddenException('Only a doctor can write a medical record');
    }
    await this.assertPatientExists(patientId);
    await this.assertTreatingToday(user.doctorId, patientId);

    return this.prisma.medicalRecord.create({
      data: {
        tenantId: currentTenantId(),
        patientId,
        doctorId: user.doctorId,
        diagnosis: dto.diagnosis,
        notes: dto.notes,
        visitDate: dto.visitDate ? new Date(dto.visitDate) : new Date(),
      },
      include: { doctor: { select: { id: true, fullName: true, specialization: true } } },
    });
  }

  /**
   * Doctors and nurses may read any patient's history — a patient can be seen
   * by whoever is on shift, and withholding history from the clinician in
   * front of them is its own safety problem. Every read is audited, which is
   * the control that actually applies here.
   */
  async findForPatient(patientId: number, user: AuthUser) {
    if (user.role !== UserRole.DOCTOR && user.role !== UserRole.NURSE) {
      throw new ForbiddenException('You do not have access to clinical records');
    }
    await this.assertPatientExists(patientId);

    return {
      data: await this.prisma.medicalRecord.findMany({
        where: { patientId },
        orderBy: { visitDate: 'desc' },
        include: { doctor: { select: { id: true, fullName: true, specialization: true } } },
      }),
    };
  }

  private async assertPatientExists(id: number) {
    const p = await this.prisma.patient.findUnique({ where: { id }, select: { id: true } });
    if (!p) throw new NotFoundException(`Patient ${id} not found`);
  }
}
