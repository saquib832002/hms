import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { parseDateParam } from '../common/utils/hospital-time';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { QueryAppointmentsDto } from './dto/query-appointments.dto';
import { isValidTransition, isTerminal, roleMayTransitionTo } from './appointment-status';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';
import { describeClinic, isOnGrid } from '../common/tenancy/clinic-settings';
import { zonedParts } from '../common/utils/hospital-time';

@Injectable()
export class AppointmentsService {
  constructor(
    private prisma: PrismaService,
    private clinic: ClinicSettingsService,
    private notifications: NotificationsService,
  ) {}

  async create(dto: CreateAppointmentDto) {
    const scheduledAt = new Date(dto.scheduledAt);

    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('scheduledAt is not a valid date');
    }
    if (scheduledAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('Cannot book an appointment in the past');
    }

    await this.assertOnGrid(scheduledAt);
    await this.assertPatientExists(dto.patientId);
    await this.assertDoctorExists(dto.doctorId);
    await this.assertPatientIsFree(dto.patientId, scheduledAt);

    try {
      const created = await this.prisma.appointment.create({
        data: {
          tenantId: currentTenantId(),
          patientId: dto.patientId,
          doctorId: dto.doctorId,
          scheduledAt,
          reason: dto.reason,
        },
        include: this.listInclude(),
      });
      return this.shapeFee(created);
    } catch (err) {
      throw this.translateSlotConflict(err);
    }
  }

  /**
   * A patient cannot be in two places at once.
   *
   * The check above is for the *message* — it can name the other doctor, which
   * is what a receptionist needs to resolve the situation. The guarantee is the
   * partial unique index in `prisma/sql/appointment-slots.sql`, because two
   * receptionists tapping "book" in the same second both pass this check and
   * both insert.
   *
   * Cancelled and no-show appointments are ignored, here and in the index: the
   * patient is not attending those, so they do not occupy the person.
   */
  private async assertPatientIsFree(
    patientId: number,
    scheduledAt: Date,
    excludeAppointmentId?: number,
  ) {
    const clash = await this.prisma.appointment.findFirst({
      where: {
        patientId,
        scheduledAt,
        status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      include: { doctor: { select: { fullName: true } } },
    });

    if (clash) {
      throw new ConflictException(
        `This patient already has an appointment at that time with Dr ${
          clash.doctor?.fullName ?? 'another doctor'
        }`,
      );
    }
  }

  /**
   * Turns a unique-violation into something a receptionist can act on.
   *
   * Two indexes can fire here and they mean opposite things — the doctor is
   * busy, or the patient is. "That slot is already booked" covered both and
   * sent reception looking at the wrong calendar.
   */
  private translateSlotConflict(err: unknown): unknown {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      return err;
    }

    const target = String((err.meta as { target?: unknown } | undefined)?.target ?? '');

    if (target.includes('patient')) {
      return new ConflictException('This patient already has an appointment at that time');
    }
    return new ConflictException('That slot is already booked for this doctor');
  }

  /**
   * Is this instant a real slot for the caller's hospital?
   *
   * The picker only offers valid times, but the API is the boundary and a
   * client can post anything. An off-grid appointment is quietly corrosive: it
   * never appears in the availability view, so it cannot be seen or cancelled
   * from the screen a receptionist actually uses, while still occupying the
   * doctor and blocking nothing.
   *
   * Judged on the hospital's wall clock, not the server's — 14:05 is a valid
   * slot in a 5-minute clinic and off-grid in a 30-minute one.
   */
  private async assertOnGrid(instant: Date) {
    const clinic = await this.clinic.current();
    const { hour, minute } = zonedParts(instant, clinic.timezone);

    if (!isOnGrid(hour, minute, clinic)) {
      throw new BadRequestException(
        `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} is not a bookable time — ` +
          `this hospital runs ${describeClinic(clinic)}`,
      );
    }
  }

  async findAll(query: QueryAppointmentsDto, user: AuthUser) {
    const clinic = await this.clinic.current();
    const { start, end } = parseDateParam(query.date, clinic.timezone);

    const where: Prisma.AppointmentWhereInput = {
      scheduledAt: { gte: start, lt: end },
      ...(query.status ? { status: query.status } : {}),
      ...(query.patientId ? { patientId: query.patientId } : {}),
      ...this.scopeToUser(query.doctorId, user),
    };

    const data = await this.prisma.appointment.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      include: this.listInclude(),
    });

    return {
      data: data.map((a) => this.shapeFee(a)),
      meta: { date: query.date ?? 'today', timezone: clinic.timezone, total: data.length },
    };
  }

  /**
   * Layer 2 of access control: which rows, not which endpoint.
   *
   * A doctor asking for "appointments" means *their* appointments. Letting a
   * doctor page through every other doctor's list is not something the route
   * guard can catch — it looks like a perfectly legitimate request.
   */
  private scopeToUser(requestedDoctorId: number | undefined, user: AuthUser): Prisma.AppointmentWhereInput {
    if (user.role === UserRole.DOCTOR) {
      if (requestedDoctorId && requestedDoctorId !== user.doctorId) {
        throw new ForbiddenException('You can only view your own appointments');
      }
      return { doctorId: user.doctorId };
    }
    return requestedDoctorId ? { doctorId: requestedDoctorId } : {};
  }

  async findOne(id: number, user: AuthUser) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: this.listInclude(),
    });
    if (!appointment) throw new NotFoundException(`Appointment ${id} not found`);

    if (user.role === UserRole.DOCTOR && appointment.doctorId !== user.doctorId) {
      // 404 rather than 403: confirming the appointment exists but belongs to
      // someone else already reveals that this patient saw another doctor.
      throw new NotFoundException(`Appointment ${id} not found`);
    }
    return this.shapeFee(appointment);
  }

  async update(id: number, dto: UpdateAppointmentDto, user: AuthUser) {
    const existing = await this.findOne(id, user);

    if (isTerminal(existing.status)) {
      throw new ConflictException(
        `This appointment is ${existing.status.toLowerCase()} and can no longer be changed`,
      );
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('Cannot reschedule into the past');
    }

    // Moving an appointment can create the same clash as booking one, and the
    // reschedule path had no check at all — the only thing standing in its way
    // was the doctor-slot index, which says nothing about the patient.
    if (scheduledAt) {
      await this.assertOnGrid(scheduledAt);
      await this.assertPatientIsFree(existing.patientId, scheduledAt, id);
    }

    /*
     * Reception may move an appointment to a different doctor.
     *
     * Checked here so an unknown id is a 404 rather than a foreign-key error
     * surfacing as a 500. The route already restricts this to reception and
     * admin; a doctor cannot reassign their own appointments to someone else.
     */
    if (dto.doctorId !== undefined && dto.doctorId !== existing.doctorId) {
      await this.assertDoctorExists(dto.doctorId);
    }

    try {
      const moved = await this.prisma.appointment.update({
        where: { id },
        data: { scheduledAt, reason: dto.reason, doctorId: dto.doctorId },
        include: this.listInclude(),
      });
      return this.shapeFee(moved);
    } catch (err) {
      throw this.translateSlotConflict(err);
    }
  }

  async changeStatus(id: number, to: AppointmentStatus, user: AuthUser) {
    const existing = await this.findOne(id, user);

    if (existing.status === to) return existing;

    if (!isValidTransition(existing.status, to)) {
      throw new ConflictException(
        `Cannot move an appointment from ${existing.status} to ${to}`,
      );
    }

    if (!roleMayTransitionTo(user.role, to)) {
      throw new ForbiddenException(`Your role cannot set an appointment to ${to}`);
    }

    // A doctor may only progress their own consultations.
    if (user.role === UserRole.DOCTOR && existing.doctorId !== user.doctorId) {
      throw new ForbiddenException('This is not your appointment');
    }

    const updated = await this.prisma.appointment.update({
      where: { id },
      data: { status: to },
      include: this.listInclude(),
    });

    // Reception checks a patient in on their machine; the doctor may be on a
    // ward two floors away. This is the moment the mobile app exists for.
    //
    // The notification itself carries no patient data — see
    // notifications/notification-payload.ts. It says only that someone is
    // waiting; the app fetches the detail after the doctor unlocks the phone,
    // and that fetch is audited.
    if (to === AppointmentStatus.CHECKED_IN) {
      const doctor = await this.prisma.doctor.findUnique({
        where: { id: updated.doctorId },
        select: { userId: true },
      });
      if (doctor) {
        this.notifications.notifyDoctor(doctor.userId, 'PATIENT_CHECKED_IN', { appointmentId: id });
      }
    }

    return this.shapeFee(updated);
  }

  /**
   * What every appointment response carries.
   *
   * `consultationFee` and `invoice` are here for reception's checkout: the fee
   * to read out to the patient, and whether this consultation has already been
   * billed so the button can say so rather than failing on the second tap.
   *
   * Only the invoice *id* — not its total, status or payments. Whether a charge
   * exists is administrative; what is on it is billing's business, and every
   * role that reads an appointment would otherwise receive it. A fee is a price
   * list entry, not PHI.
   */
  /**
   * The doctor's fee leaves as a string, never a Decimal object or a float.
   *
   * Same rule as everywhere else money appears: `parseFloat` on the client is
   * how pennies go missing, and a Decimal serialises to something no client can
   * use directly.
   */
  private shapeFee<T extends { doctor?: { consultationFee: Prisma.Decimal | null } | null }>(
    row: T,
  ) {
    if (!row.doctor) return row;
    return {
      ...row,
      doctor: {
        ...row.doctor,
        consultationFee:
          row.doctor.consultationFee === null ? null : row.doctor.consultationFee.toFixed(2),
      },
    };
  }

  private listInclude() {
    return {
      patient: { select: { id: true, fullName: true, dob: true, gender: true, phone: true } },
      doctor: {
        select: { id: true, fullName: true, specialization: true, consultationFee: true },
      },
      invoice: { select: { id: true } },
    };
  }

  private async assertPatientExists(id: number) {
    const p = await this.prisma.patient.findUnique({ where: { id }, select: { id: true } });
    if (!p) throw new NotFoundException(`Patient ${id} not found`);
  }

  private async assertDoctorExists(id: number) {
    const d = await this.prisma.doctor.findUnique({ where: { id }, select: { id: true } });
    if (!d) throw new NotFoundException(`Doctor ${id} not found`);
  }
}
