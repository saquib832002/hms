import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { NOT_TREATING, resolveTreatingScope } from '../common/clinical/treating-scope';
import { CreateMedicalRecordDto } from './dto/create-medical-record.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';

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
   * is true and insufficient. Tying the write to a real encounter is what
   * makes the permission specific to *this* patient.
   *
   * Returns the appointment this record belongs to, or null when it belongs to
   * no single visit.
   */
  private async assertTreating(doctorId: number, patientId: number) {
    /*
     * Shared with prescribing, deliberately.
     *
     * It used to be "today", and moving only the prescribing rule would have
     * produced the worst of both: a doctor able to issue a medication and
     * unable to record the reasoning behind it. See `treating-scope.ts` for
     * what now counts as being this patient's doctor — a recent appointment,
     * or an open admission, which was missing entirely and meant no note could
     * be written about anybody in a bed.
     */
    const scope = await resolveTreatingScope(this.prisma, await this.tz(), doctorId, patientId);
    if (!scope) throw new ForbiddenException(NOT_TREATING);

    /*
     * Only a same-day visit claims the record.
     *
     * A note written weeks later is about that patient, not part of that
     * consultation, and filing it under the old appointment would backdate it
     * on the record — a clinical document appearing to have been written at a
     * time it was not. `createdAt` still says when it was actually written.
     */
    return scope.sameDay && scope.appointment ? scope.appointment.id : null;
  }

  async create(patientId: number, dto: CreateMedicalRecordDto, user: AuthUser) {
    if (!user.doctorId) {
      throw new ForbiddenException('Only a doctor can write a medical record');
    }
    await this.assertPatientExists(patientId);
    await this.assertTreating(user.doctorId, patientId);

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
