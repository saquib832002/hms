import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppointmentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { parseDateParam } from '../common/utils/hospital-time';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';

/**
 * Aggregate endpoint for the doctor's queue screen.
 *
 * Everything one screen renders, in one round trip. The web app could happily
 * make four calls; a phone on hospital wifi between wards cannot, and the
 * doctor is standing in a corridor waiting for it. This is a latency
 * optimisation, not a mobile-only fork — web uses it too.
 */
@Injectable()
export class MeService {
  constructor(
    private clinic: ClinicSettingsService,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async queue(user: AuthUser, dateParam?: string) {
    if (!user.doctorId) {
      throw new ForbiddenException('Only a doctor has a patient queue');
    }

    const tz = (await this.clinic.current()).timezone;
    const { start, end } = parseDateParam(dateParam, tz);

    const [doctor, appointments] = await Promise.all([
      this.prisma.doctor.findUnique({
        where: { id: user.doctorId },
        include: { department: { select: { id: true, name: true } } },
      }),
      this.prisma.appointment.findMany({
        where: { doctorId: user.doctorId, scheduledAt: { gte: start, lt: end } },
        orderBy: { scheduledAt: 'asc' },
        include: {
          patient: {
            select: {
              id: true,
              fullName: true,
              dob: true,
              gender: true,
              // Only whether allergies exist, not what they are. The queue
              // needs a warning dot; the substances belong on the detail
              // view, where opening it is an audited act.
              allergies: { select: { id: true } },
            },
          },
        },
      }),
    ]);

    const byStatus = (s: AppointmentStatus) => appointments.filter((a) => a.status === s).length;

    return {
      doctor: doctor
        ? {
            id: doctor.id,
            fullName: doctor.fullName,
            specialization: doctor.specialization,
            department: doctor.department?.name ?? null,
          }
        : null,
      date: dateParam ?? 'today',
      timezone: tz,
      stats: {
        total: appointments.length,
        scheduled: byStatus(AppointmentStatus.SCHEDULED),
        waiting: byStatus(AppointmentStatus.CHECKED_IN),
        inProgress: byStatus(AppointmentStatus.IN_PROGRESS),
        completed: byStatus(AppointmentStatus.COMPLETED),
        noShow: byStatus(AppointmentStatus.NO_SHOW),
      },
      appointments: appointments.map((a) => ({
        id: a.id,
        scheduledAt: a.scheduledAt,
        status: a.status,
        reason: a.reason,
        patient: {
          id: a.patient!.id,
          fullName: a.patient!.fullName,
          age: ageFrom(a.patient!.dob as Date),
          gender: a.patient!.gender,
          hasAllergies: (a.patient!.allergies?.length ?? 0) > 0,
        },
      })),
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
