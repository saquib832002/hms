import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdmissionStatus, ObservationFrequency, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { currentTenantId } from '../common/tenancy/tenant-context';
import {
  DEFAULT_FREQUENCY,
  FREQUENCY_LABEL,
  FREQUENCY_MINUTES,
  isOverdue,
  isTighter,
  nextDueAt,
} from './observation-frequency';

/**
 * How closely a patient is watched, and what happened when they were not well.
 *
 * TWO THINGS, AND THEY ANSWER DIFFERENT QUESTIONS
 * ----------------------------------------------
 * An **order** is the plan: this patient's observations are due every N
 * minutes. A doctor sets it; a nurse may tighten it and never relax it.
 *
 * An **escalation** is what happened when the plan produced a worrying number:
 * who was told, what the concern was, and what came back. That is the fact an
 * incident review asks for first and the one the system had nowhere to put.
 */
@Injectable()
export class ObservationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * The current order for an admission, falling back to the default.
   *
   * Returns a shape rather than a row because callers want the *decision*, and
   * "nobody has set one, so it is four-hourly" is a legitimate answer that no
   * row expresses. Making the caller handle a null would push that reasoning
   * into every call site, which is how two screens end up disagreeing about how
   * often a patient is due.
   */
  async currentOrder(admissionId: number) {
    const order = await this.prisma.observationOrder.findFirst({
      where: { admissionId },
      orderBy: { setAt: 'desc' },
      include: { setBy: { select: { fullName: true } } },
    });

    const frequency = order?.frequency ?? DEFAULT_FREQUENCY;
    return {
      frequency,
      label: FREQUENCY_LABEL[frequency],
      intervalMinutes: FREQUENCY_MINUTES[frequency],
      /** False when nobody has decided and this is the system default. */
      isExplicit: order !== null,
      reason: order?.reason ?? null,
      isEscalation: order?.isEscalation ?? false,
      setBy: order?.setBy?.fullName ?? null,
      setAt: order?.setAt ?? null,
    };
  }

  /** Every order this stay has had, newest first — the plan's own history. */
  orderHistory(admissionId: number) {
    return this.prisma.observationOrder.findMany({
      where: { admissionId },
      orderBy: { setAt: 'desc' },
      include: { setBy: { select: { fullName: true, role: true } } },
    });
  }

  /**
   * Set the frequency.
   *
   * **A nurse may tighten and never relax.** Watching somebody more closely
   * because they look unwell is the entire reason there is a nurse at the
   * bedside, and it must not need a doctor found first. Deciding somebody needs
   * *less* watching is a judgement about their condition, and getting it wrong
   * is silent — nothing looks broken until the patient is found deteriorated
   * between two sets nobody was asked to take.
   */
  async setOrder(
    admissionId: number,
    frequency: ObservationFrequency,
    reason: string | undefined,
    user: AuthUser,
  ) {
    const admission = await this.requireOpenAdmission(admissionId);
    const current = await this.currentOrder(admissionId);

    const isNurse = user.role === UserRole.NURSE;
    if (isNurse && !isTighter(frequency, current.frequency)) {
      throw new ForbiddenException(
        `This patient is on ${current.label.toLowerCase()} observations. A nurse can increase how often ` +
          'observations are taken, but relaxing them is a doctor’s decision — ask the treating doctor.',
      );
    }

    return this.prisma.observationOrder.create({
      data: {
        tenantId: currentTenantId(),
        admissionId,
        patientId: admission.patientId,
        frequency,
        reason: reason?.trim() || null,
        // Records which of the two happened, so a chart shows a doctor's plan
        // and a nurse's concern as different things rather than one list of
        // frequency changes.
        isEscalation: isNurse,
        setById: user.userId,
      },
      include: { setBy: { select: { fullName: true } } },
    });
  }

  /**
   * The whole observation picture for one admission.
   *
   * Order, when the next set is due, the recent chart and any escalations —
   * because a nurse arriving at a bed asks all four at once, and four requests
   * over ward wifi is how the most time-critical screen becomes the slowest.
   */
  async summary(admissionId: number) {
    const admission = await this.prisma.admission.findUnique({
      where: { id: admissionId },
      select: {
        id: true,
        patientId: true,
        status: true,
        admittedAt: true,
        bed: { select: { label: true, ward: { select: { name: true } } } },
        patient: { select: { id: true, fullName: true, dob: true } },
      },
    });
    if (!admission) throw new NotFoundException(`Admission ${admissionId} not found`);

    const [order, last, escalations] = await Promise.all([
      this.currentOrder(admissionId),
      this.prisma.vital.findFirst({
        where: { admissionId },
        orderBy: { recordedAt: 'desc' },
        select: { recordedAt: true },
      }),
      this.prisma.observationEscalation.findMany({
        where: { admissionId },
        orderBy: { raisedAt: 'desc' },
        take: 50,
        include: {
          raisedBy: { select: { fullName: true } },
          vital: { select: { id: true, recordedAt: true } },
        },
      }),
    ]);

    const lastAt = last?.recordedAt ?? null;

    return {
      admission: {
        id: admission.id,
        admittedAt: admission.admittedAt,
        bed: admission.bed?.label ?? null,
        ward: admission.bed?.ward?.name ?? null,
      },
      patient: {
        id: admission.patient!.id,
        fullName: admission.patient!.fullName,
      },
      order,
      lastObservedAt: lastAt,
      nextDueAt: nextDueAt(lastAt, order.frequency),
      /*
       * A patient with no observations at all is overdue, and that is the
       * important case rather than an edge one: somebody admitted an hour ago
       * whose baseline was never taken is exactly who the board should be
       * shouting about, and treating "no data" as "nothing to worry about" is
       * how they stay invisible.
       */
      overdue: isOverdue(lastAt, order.frequency),
      neverObserved: lastAt === null,
      escalations,
      openEscalations: escalations.filter((e) => e.respondedAt === null).length,
    };
  }

  /**
   * Record that a deteriorating patient was escalated.
   *
   * `escalatedTo` is free text because the on-call registrar covering a ward at
   * 3am usually has no account in this hospital's system, and demanding a user
   * id would mean the commonest real escalation could not be recorded at all.
   *
   * NURSE and DOCTOR both — a doctor escalating to a critical care team is the
   * same act one level up, and giving it a different model would split the
   * trail somebody has to reassemble later.
   */
  async raiseEscalation(
    admissionId: number,
    dto: { escalatedTo: string; concern: string; vitalId?: number },
    user: AuthUser,
  ) {
    const admission = await this.requireOpenAdmission(admissionId);

    if (dto.vitalId) {
      // The observation must belong to this stay. Otherwise an escalation could
      // cite a reading from another patient, which is worse than citing none.
      const vital = await this.prisma.vital.findUnique({
        where: { id: dto.vitalId },
        select: { admissionId: true, patientId: true },
      });
      if (!vital) throw new NotFoundException(`Observation ${dto.vitalId} not found`);
      if (vital.patientId !== admission.patientId) {
        throw new BadRequestException('That observation belongs to a different patient');
      }
    }

    return this.prisma.observationEscalation.create({
      data: {
        tenantId: currentTenantId(),
        admissionId,
        patientId: admission.patientId,
        vitalId: dto.vitalId ?? null,
        escalatedTo: dto.escalatedTo.trim(),
        concern: dto.concern.trim(),
        raisedById: user.userId,
      },
      include: { raisedBy: { select: { fullName: true } } },
    });
  }

  /**
   * Record what came back.
   *
   * Separate from raising it, because the gap between the two is the finding.
   * An escalation with no response is a nurse who rang somebody and got nothing
   * — exactly what a review is looking for — so it stays visibly open rather
   * than being written in one go once the answer arrives, which would quietly
   * lose every unanswered call.
   */
  async recordResponse(id: number, response: string) {
    const escalation = await this.prisma.observationEscalation.findUnique({ where: { id } });
    if (!escalation) throw new NotFoundException(`Escalation ${id} not found`);
    if (escalation.respondedAt) {
      throw new ConflictException('A response has already been recorded against that escalation');
    }

    return this.prisma.observationEscalation.update({
      where: { id },
      data: { response: response.trim(), respondedAt: new Date() },
      include: { raisedBy: { select: { fullName: true } } },
    });
  }

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
