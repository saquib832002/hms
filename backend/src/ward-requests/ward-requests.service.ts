import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdmissionStatus,
  MedicationRequestStatus,
  SupplyRequestStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { currentTenantId } from '../common/tenancy/tenant-context';
import {
  CreateMedicationRequestDto,
  CreateSupplyRequestDto,
  FulfilMedicationRequestDto,
} from './dto/ward-requests.dto';

/**
 * The two things a nurse can ask for, and they are not the same thing.
 *
 * WHY TWO MODELS AND NOT ONE "REQUEST MEDICATION"
 * ----------------------------------------------
 * Both start from the same sentence — "the patient needs a medicine that is not
 * here" — and they differ in *what is missing*, which decides who can answer:
 *
 *   - **Supply.** The prescription exists; the drug is not physically on the
 *     ward. A logistics problem, answered by a pharmacist.
 *   - **Medication.** The drug is not prescribed at all. A clinical decision,
 *     answered by a prescriber.
 *
 * One button covering both would route half of each to the wrong person, and
 * the failure available at that point is a drug supplied that nobody
 * prescribed. So they are separate models, separate queues, separate roles.
 *
 * NEITHER PATH PUTS A MEDICINE ON A CHART
 * ---------------------------------------
 * A nurse asks; a nurse never prescribes. Prescribing is a prescriber's act in
 * every jurisdiction this product targets unless the nurse holds a separate
 * qualification the system does not model. A supply request can only name a
 * `PrescriptionItem` that already exists, and a medication request produces
 * either a `Prescription` written by a doctor or a decline with a reason.
 * `ward-requests.spec.ts` asserts the absence of any write to `prescription`
 * from this service.
 */
@Injectable()
export class WardRequestsService {
  constructor(private prisma: PrismaService) {}

  // ---------------------------------------------------------------- supply

  async createSupplyRequest(
    admissionId: number,
    dto: CreateSupplyRequestDto,
    user: AuthUser,
  ) {
    const admission = await this.requireOpenAdmission(admissionId);

    /*
     * The item must belong to this patient.
     *
     * Without this a nurse could raise a supply request against any
     * prescription line in the hospital, and the pharmacist would see a
     * plausible-looking row naming the wrong patient's medicine. The API is the
     * boundary; the client picking from a list of this patient's items is a
     * convenience, not a guarantee.
     */
    const item = await this.prisma.prescriptionItem.findUnique({
      where: { id: dto.prescriptionItemId },
      include: { prescription: { select: { patientId: true, status: true } } },
    });
    if (!item) throw new NotFoundException(`Prescription item ${dto.prescriptionItemId} not found`);
    if (item.prescription?.patientId !== admission.patientId) {
      throw new BadRequestException('That medicine belongs to a different patient');
    }
    if (item.prescription?.status === 'CANCELLED') {
      throw new ConflictException(
        'That prescription has been cancelled, so there is nothing to supply against it.',
      );
    }

    return this.prisma.supplyRequest.create({
      data: {
        tenantId: currentTenantId(),
        admissionId,
        patientId: admission.patientId,
        prescriptionItemId: item.id,
        quantity: dto.quantity ?? null,
        note: dto.note?.trim() || null,
        requestedById: user.userId,
      },
      include: SUPPLY_INCLUDE,
    });
  }

  /**
   * The pharmacist's queue.
   *
   * Segmented by status rather than filtered to the open ones. Same lesson the
   * referral queue and the pharmacy invoice list both taught: the question
   * people bring to a screen is often about something that has already
   * finished — "did that insulin ever go up to the ward" is asked precisely
   * once the row would have vanished.
   */
  supplyQueue(status: 'waiting' | 'supplied' | 'declined' | 'all') {
    const where =
      status === 'all'
        ? {}
        : {
            status:
              status === 'waiting'
                ? SupplyRequestStatus.REQUESTED
                : status === 'supplied'
                  ? SupplyRequestStatus.SUPPLIED
                  : SupplyRequestStatus.DECLINED,
          };

    return this.prisma.supplyRequest.findMany({
      where,
      orderBy: { requestedAt: 'asc' },
      take: 200,
      include: SUPPLY_INCLUDE,
    });
  }

  /** What this admission has asked for, so the ward can see where it got to. */
  supplyRequestsFor(admissionId: number) {
    return this.prisma.supplyRequest.findMany({
      where: { admissionId },
      orderBy: { requestedAt: 'desc' },
      include: SUPPLY_INCLUDE,
    });
  }

  /**
   * Marking a request supplied.
   *
   * **This does not move stock, and that is deliberate.** Decrementing here
   * would give the hospital a second stock ledger beside `DispenseEvent`, and
   * the day one of them was forgotten the count would still look plausible —
   * the same argument that keeps counter sales inside `DispenseEvent` rather
   * than in a `CounterSale` table of their own.
   *
   * It would also skip batch selection, the expiry check, the allergy check and
   * the pricing that the dispensing flow does properly. So this records that the
   * ward's request was answered, and the medicine leaves the shelf through
   * dispensing, where it is counted and charged once.
   */
  async supply(id: number, note: string | undefined, user: AuthUser) {
    const request = await this.prisma.supplyRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException(`Supply request ${id} not found`);
    if (request.status !== SupplyRequestStatus.REQUESTED) {
      throw new ConflictException(
        `That request was already ${request.status.toLowerCase()} and cannot be answered twice`,
      );
    }

    return this.prisma.supplyRequest.update({
      where: { id },
      data: {
        status: SupplyRequestStatus.SUPPLIED,
        respondedById: user.userId,
        respondedAt: new Date(),
        responseNote: note?.trim() || null,
      },
      include: SUPPLY_INCLUDE,
    });
  }

  async declineSupply(id: number, reason: string, user: AuthUser) {
    const request = await this.prisma.supplyRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException(`Supply request ${id} not found`);
    if (request.status !== SupplyRequestStatus.REQUESTED) {
      throw new ConflictException(
        `That request was already ${request.status.toLowerCase()} and cannot be answered twice`,
      );
    }

    return this.prisma.supplyRequest.update({
      where: { id },
      data: {
        status: SupplyRequestStatus.DECLINED,
        respondedById: user.userId,
        respondedAt: new Date(),
        // Required by the DTO. "Out of stock, ordered, expect Thursday" is
        // something a ward can act on; a bare refusal is not.
        responseNote: reason.trim(),
      },
      include: SUPPLY_INCLUDE,
    });
  }

  // ------------------------------------------------------------ medication

  async createMedicationRequest(
    admissionId: number,
    dto: CreateMedicationRequestDto,
    user: AuthUser,
  ) {
    const admission = await this.requireOpenAdmission(admissionId);

    return this.prisma.medicationRequest.create({
      data: {
        tenantId: currentTenantId(),
        admissionId,
        patientId: admission.patientId,
        medicineText: dto.medicineText.trim(),
        reason: dto.reason.trim(),
        requestedById: user.userId,
      },
      include: MED_INCLUDE,
    });
  }

  /**
   * The prescriber's inbox.
   *
   * Deliberately every open request in the hospital, not only this doctor's
   * patients. Ward cover means the doctor who answers at 3am is routinely not
   * the one who admitted — the same reasoning that let `resolveTreatingScope`
   * accept an open admission rather than only the admitting doctor.
   */
  medicationQueue(status: 'waiting' | 'prescribed' | 'declined' | 'all') {
    const where =
      status === 'all'
        ? {}
        : {
            status:
              status === 'waiting'
                ? MedicationRequestStatus.REQUESTED
                : status === 'prescribed'
                  ? MedicationRequestStatus.PRESCRIBED
                  : MedicationRequestStatus.DECLINED,
          };

    return this.prisma.medicationRequest.findMany({
      where,
      orderBy: { requestedAt: 'asc' },
      take: 200,
      include: MED_INCLUDE,
    });
  }

  medicationRequestsFor(admissionId: number) {
    return this.prisma.medicationRequest.findMany({
      where: { admissionId },
      orderBy: { requestedAt: 'desc' },
      include: MED_INCLUDE,
    });
  }

  /**
   * Closing a request because the doctor actually wrote the prescription.
   *
   * The prescription must exist and belong to this patient. A status settable
   * without one would let the request and the chart disagree about whether a
   * medicine exists — and a nurse reading "prescribed" and finding nothing is
   * worse off than one still waiting, because they stop chasing.
   *
   * This service does not create the prescription. The doctor writes it through
   * `POST /prescriptions` like any other, which keeps one prescribing path with
   * one set of rules; a second one reachable from a nurse's request is exactly
   * how "the nurse never prescribes" quietly stops being true.
   */
  async fulfilMedicationRequest(id: number, dto: FulfilMedicationRequestDto, user: AuthUser) {
    const request = await this.prisma.medicationRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException(`Medication request ${id} not found`);
    if (request.status !== MedicationRequestStatus.REQUESTED) {
      throw new ConflictException(
        `That request was already ${request.status.toLowerCase()} and cannot be answered twice`,
      );
    }

    const prescription = await this.prisma.prescription.findUnique({
      where: { id: dto.prescriptionId },
      select: { id: true, patientId: true },
    });
    if (!prescription) {
      throw new NotFoundException(`Prescription ${dto.prescriptionId} not found`);
    }
    if (prescription.patientId !== request.patientId) {
      throw new BadRequestException('That prescription is for a different patient');
    }

    return this.prisma.medicationRequest.update({
      where: { id },
      data: {
        status: MedicationRequestStatus.PRESCRIBED,
        prescriptionId: prescription.id,
        respondedById: user.userId,
        respondedAt: new Date(),
        responseNote: dto.note?.trim() || null,
      },
      include: MED_INCLUDE,
    });
  }

  /**
   * Declining, with a reason that is kept.
   *
   * "I asked and was told no, and here is why" is precisely what a nurse needs
   * on record afterwards — and a decline is a clinical decision worth reading
   * later, not an absence of one.
   */
  async declineMedicationRequest(id: number, reason: string, user: AuthUser) {
    const request = await this.prisma.medicationRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException(`Medication request ${id} not found`);
    if (request.status !== MedicationRequestStatus.REQUESTED) {
      throw new ConflictException(
        `That request was already ${request.status.toLowerCase()} and cannot be answered twice`,
      );
    }

    return this.prisma.medicationRequest.update({
      where: { id },
      data: {
        status: MedicationRequestStatus.DECLINED,
        respondedById: user.userId,
        respondedAt: new Date(),
        responseNote: reason.trim(),
      },
      include: MED_INCLUDE,
    });
  }

  // ------------------------------------------------------------------ util

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
}

/**
 * Both queues name the patient and the bed.
 *
 * A pharmacist filling a ward request needs to know who it is for — that is how
 * the wrong medicine going to the wrong bed is caught at the counter rather than
 * at the bedside. Same reason the dispensing queue names patients, and the same
 * reason ADMIN is excluded from all of it.
 */
const SUPPLY_INCLUDE = {
  prescriptionItem: {
    select: { id: true, medicineName: true, dosage: true, frequency: true, medicineId: true },
  },
  admission: {
    select: {
      id: true,
      bed: { select: { label: true, ward: { select: { name: true } } } },
      patient: { select: { id: true, fullName: true } },
    },
  },
  requestedBy: { select: { fullName: true } },
  respondedBy: { select: { fullName: true } },
} as const;

const MED_INCLUDE = {
  admission: {
    select: {
      id: true,
      bed: { select: { label: true, ward: { select: { name: true } } } },
      patient: {
        select: {
          id: true,
          fullName: true,
          // The prescriber is about to decide whether to write something. An
          // allergy list is the first thing they need and the last thing that
          // should require another screen.
          allergies: { select: { substance: true } },
        },
      },
    },
  },
  requestedBy: { select: { fullName: true } },
  respondedBy: { select: { fullName: true } },
} as const;
