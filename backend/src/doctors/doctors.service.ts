import { Injectable, NotFoundException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
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
    dto: { fullName?: string; specialization?: string; departmentId?: number | null; registrationNo?: string | null; phone?: string | null },
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
        },
        include: { department: { select: { id: true, name: true } } },
      });
    });
  }

  findAll() {
    return this.prisma.doctor.findMany({
      orderBy: { fullName: 'asc' },
      include: { department: { select: { id: true, name: true } } },
    });
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
