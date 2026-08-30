import { Injectable, NotFoundException } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseDateParam, zonedTimeToUtc, hospitalDate } from '../common/utils/hospital-time';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';

/*
 * Clinic hours used to be the three constants that lived here. They are now
 * per-hospital, on the Tenant row, because two hospitals on one deployment do
 * not share a clinic day: a walk-in clinic books 5-minute slots, an outpatient
 * department 30, and a hospital in another timezone opens at a different
 * instant entirely.
 *
 * Read through ClinicSettingsService, which resolves the caller's hospital.
 */

/** Statuses that still occupy a slot. A cancelled appointment frees it. */
const BLOCKING = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CHECKED_IN,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.COMPLETED,
];

@Injectable()
export class DoctorsService {
  constructor(
    private prisma: PrismaService,
    private clinic: ClinicSettingsService,
  ) {}

  /**
   * Update a doctor's profile.
   *
   * `fullName` is duplicated between `User` and `Doctor` — historical accident,
   * but a real one now. Both are updated together so a rename does not leave a
   * doctor listed under two different names on different screens.
   */
  async updateProfile(
    id: number,
    dto: {
      fullName?: string;
      specialization?: string;
      departmentId?: number | null;
      registrationNo?: string | null;
      phone?: string | null;
      consultationFee?: string;
    },
  ) {
    const doctor = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      if (dto.fullName) {
        await tx.user.update({ where: { id: doctor.userId }, data: { fullName: dto.fullName.trim() } });
      }
      return tx.doctor.update({
        where: { id },
        data: {
          fullName: dto.fullName?.trim(),
          specialization: dto.specialization?.trim(),
          ...(dto.departmentId !== undefined ? { departmentId: dto.departmentId } : {}),
          ...(dto.registrationNo !== undefined ? { registrationNo: dto.registrationNo } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          /*
           * An empty string clears the fee; a value sets it.
           *
           * Cleared and zero are deliberately different. No fee means checkout
           * refuses and tells reception to ask an administrator; zero means the
           * consultation is genuinely free. Collapsing them would make a
           * forgotten price look like a decision.
           */
          ...(dto.consultationFee !== undefined
            ? { consultationFee: dto.consultationFee === '' ? null : dto.consultationFee }
            : {}),
        },
        include: { department: { select: { id: true, name: true } } },
      });
    });
  }

  async findAll() {
    const doctors = await this.prisma.doctor.findMany({
      orderBy: { fullName: 'asc' },
      include: { department: { select: { id: true, name: true } } },
    });
    return doctors.map((d) => this.shape(d));
  }

  async findOne(id: number) {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id },
      include: { department: { select: { id: true, name: true } } },
    });
    if (!doctor) throw new NotFoundException(`Doctor ${id} not found`);
    return doctor;
  }

  /**
   * Money leaves as a string, like every other amount in this system.
   *
   * Prisma hands back a `Decimal` object here. Serialised straight to JSON it
   * is neither a number a client can use nor the plain string the rest of the
   * API sends, and the first thing a client would do is `parseFloat` it — the
   * exact loss `billing/money.ts` exists to prevent.
   *
   * `null` is preserved rather than defaulted to "0.00": no fee set and a free
   * consultation are different facts, and checkout depends on telling them
   * apart.
   */
  private shape<T extends { consultationFee: Prisma.Decimal | null }>(doctor: T) {
    return {
      ...doctor,
      consultationFee: doctor.consultationFee === null ? null : doctor.consultationFee.toFixed(2),
    };
  }

  /**
   * Slots for a day, each flagged available or taken.
   *
   * Returns the taken ones too rather than filtering them out — the booking
   * UI needs to show a full day with gaps, and "why is 10:00 missing" is a
   * worse question than "10:00 is taken".
   */
  async availability(doctorId: number, dateParam?: string) {
    await this.findOne(doctorId);

    const clinic = await this.clinic.current();
    const { start, end } = parseDateParam(dateParam, clinic.timezone);
    const day = hospitalDate(start, clinic.timezone);

    const booked = await this.prisma.appointment.findMany({
      where: { doctorId, scheduledAt: { gte: start, lt: end }, status: { in: BLOCKING } },
      select: { scheduledAt: true, status: true },
    });
    const takenAt = new Set(booked.map((b) => b.scheduledAt.getTime()));

    /*
     * `past` is decided here, not in the browser.
     *
     * The API refuses to book a time that has already gone, so the picker has
     * to agree with it — and the only clock they can both trust is this one. A
     * workstation whose time is wrong (or in another zone) would otherwise
     * offer slots the server then rejects, which reads as a broken booking
     * page rather than a wrong clock.
     *
     * Kept separate from `available`: "taken" and "gone" are different facts,
     * and reception asks about them differently ("who has 09:00?" versus "can
     * I still book this morning?").
     */
    const now = Date.now();

    const slots: { time: string; available: boolean; past: boolean }[] = [];
    for (let h = clinic.clinicStartHour; h < clinic.clinicEndHour; h++) {
      for (let m = 0; m < 60; m += clinic.slotMinutes) {
        const at = zonedTimeToUtc({ ...day, hour: h, minute: m }, clinic.timezone);
        const past = at.getTime() < now - 60_000; // same grace as the booking check
        slots.push({
          time: at.toISOString(),
          available: !takenAt.has(at.getTime()) && !past,
          past,
        });
      }
    }

    return {
      doctorId,
      date: `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`,
      timezone: clinic.timezone,
      slotMinutes: clinic.slotMinutes,
      clinicStartHour: clinic.clinicStartHour,
      clinicEndHour: clinic.clinicEndHour,
      slots,
    };
  }
}
