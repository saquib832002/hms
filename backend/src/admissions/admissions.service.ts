import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdmissionStatus, DoseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdmitDto } from './dto/admit.dto';
import { TransferDto } from './dto/transfer.dto';
import { DischargeDto } from './dto/discharge.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';

@Injectable()
export class AdmissionsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Admit a patient to a bed.
   *
   * The uniqueness of `currentBedId` and `currentPatientId` is what actually
   * prevents a double occupancy — two nurses admitting from different
   * terminals in the same second both pass any check we could write here, and
   * only one survives the insert. The pre-checks exist to produce a useful
   * message in the common case, not to be the guarantee.
   */
  async admit(dto: AdmitDto) {
    const bed = await this.prisma.bed.findUnique({
      where: { id: dto.bedId },
      include: { ward: { select: { id: true, name: true } } },
    });
    if (!bed) throw new NotFoundException(`Bed ${dto.bedId} not found`);
    if (!bed.isActive) throw new ConflictException('That bed is out of service');

    const patient = await this.prisma.patient.findUnique({
      where: { id: dto.patientId },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException(`Patient ${dto.patientId} not found`);

    try {
      return await this.prisma.admission.create({
        data: {
          tenantId: currentTenantId(),
          patientId: dto.patientId,
          bedId: dto.bedId,
          reason: dto.reason,
          notes: dto.notes,
          currentBedId: dto.bedId,
          currentPatientId: dto.patientId,
        },
        include: this.detailInclude(),
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Which invariant was hit changes what the nurse should do next.
        const target = String(err.meta?.target ?? '');
        if (target.includes('currentPatientId')) {
          throw new ConflictException('That patient is already admitted to a bed');
        }
        throw new ConflictException('That bed is already occupied');
      }
      throw err;
    }
  }

  /**
   * Move a patient to a different bed.
   *
   * Modelled as an update rather than discharge-and-readmit: a transfer within
   * the hospital is one continuous stay, and splitting it would break the link
   * between the admission and the observations and doses already recorded
   * against it.
   */
  async transfer(admissionId: number, dto: TransferDto) {
    const admission = await this.requireActive(admissionId);

    if (admission.bedId === dto.bedId) {
      throw new BadRequestException('The patient is already in that bed');
    }

    const bed = await this.prisma.bed.findUnique({ where: { id: dto.bedId } });
    if (!bed) throw new NotFoundException(`Bed ${dto.bedId} not found`);
    if (!bed.isActive) throw new ConflictException('That bed is out of service');

    try {
      return await this.prisma.admission.update({
        where: { id: admissionId },
        data: { bedId: dto.bedId, currentBedId: dto.bedId },
        include: this.detailInclude(),
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That bed is already occupied');
      }
      throw err;
    }
  }

  /**
   * Discharge.
   *
   * Nulls both `current*` columns, which is what frees the bed. Outstanding
   * scheduled doses are closed off as WITHHELD rather than left DUE — a
   * discharged patient's medicines would otherwise sit on the ward's overdue
   * list forever, and an overdue list nobody can clear is an overdue list
   * nobody reads.
   */
  async discharge(admissionId: number, dto: DischargeDto) {
    await this.requireActive(admissionId);

    const [admission] = await this.prisma.$transaction([
      this.prisma.admission.update({
        where: { id: admissionId },
        data: {
          status: AdmissionStatus.DISCHARGED,
          dischargedAt: new Date(),
          notes: dto.notes,
          currentBedId: null,
          currentPatientId: null,
        },
        include: this.detailInclude(),
      }),
      this.prisma.medicationAdministration.updateMany({
        where: { admissionId, status: DoseStatus.DUE },
        data: { status: DoseStatus.WITHHELD, notes: 'Patient discharged' },
      }),
    ]);

    return admission;
  }

  async findActive(admissionId: number) {
    return this.requireActive(admissionId);
  }

  async findForPatient(patientId: number) {
    return {
      data: await this.prisma.admission.findMany({
        where: { patientId },
        orderBy: { admittedAt: 'desc' },
        include: this.detailInclude(),
      }),
    };
  }

  private async requireActive(id: number) {
    const admission = await this.prisma.admission.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!admission) throw new NotFoundException(`Admission ${id} not found`);
    if (admission.status !== AdmissionStatus.ADMITTED) {
      throw new ConflictException('That patient has already been discharged');
    }
    return admission;
  }

  private detailInclude() {
    return {
      patient: { select: { id: true, fullName: true, dob: true, gender: true } },
      bed: { select: { id: true, label: true, ward: { select: { id: true, name: true } } } },
    };
  }
}
