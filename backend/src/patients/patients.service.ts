import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { toPatientListItem, toPatientResponse } from './dto/patient-response';
import { AuthUser } from '../common/types/auth-user';
import { currentTenantId } from '../common/tenancy/tenant-context';

/** Roles permitted to see allergies and blood group. */
const CLINICAL_ROLES: UserRole[] = [UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST];

@Injectable()
export class PatientsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreatePatientDto, user: AuthUser) {
    const patient = await this.prisma.patient.create({
      data: {
        ...dto,
        tenantId: currentTenantId(),
        email: dto.email?.toLowerCase(),
        dob: new Date(dto.dob),
      },
    });
    return toPatientResponse(patient, user.role);
  }

  async findAll(query: PaginationDto, user: AuthUser) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const q = query.q?.trim();

    const where: Prisma.PatientWhereInput = q
      ? {
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            ...(Number.isInteger(Number(q)) ? [{ id: Number(q) }] : []),
          ],
        }
      : {};

    const needsClinical = CLINICAL_ROLES.includes(user.role);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.patient.findMany({
        where,
        orderBy: { fullName: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        // Only fetched for roles allowed to see it — the mapper would strip it
        // anyway, but not querying it at all means a future refactor of the
        // mapper cannot leak what was never loaded.
        ...(needsClinical ? { include: { allergies: { select: { id: true } } } } : {}),
      }),
      this.prisma.patient.count({ where }),
    ]);

    return {
      data: rows.map((p) => toPatientListItem(p as never, user.role)),
      meta: { total, page, limit },
    };
  }

  async findOne(id: number, user: AuthUser) {
    const patient = await this.prisma.patient.findUnique({
      where: { id },
      // NOTE: this previously included appointments, prescriptions,
      // medicalRecords and invoices for every caller. Those live behind their
      // own role-guarded endpoints now.
      ...(CLINICAL_ROLES.includes(user.role) ? { include: { allergies: true } } : {}),
    });

    if (!patient) throw new NotFoundException(`Patient ${id} not found`);
    return toPatientResponse(patient, user.role);
  }

  async update(id: number, dto: UpdatePatientDto, user: AuthUser) {
    await this.assertExists(id);

    // `undefined` leaves a column alone; `null` clears it. Spreading the DTO
    // and then overwriting with `dto.email?.toLowerCase()` would turn an
    // explicit null into undefined and silently ignore the clear.
    const patient = await this.prisma.patient.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.email !== undefined ? { email: dto.email?.toLowerCase() ?? null } : {}),
        ...(dto.dob !== undefined ? { dob: new Date(dto.dob) } : {}),
      },
    });
    return toPatientResponse(patient, user.role);
  }

  /**
   * Possible duplicates for the registration form.
   *
   * Split patient records are among the most damaging data problems in a
   * hospital system — clinical history divides across two IDs and neither
   * tells the whole story. Catching it at creation is far cheaper than
   * merging later.
   */
  async findPossibleDuplicates(fullName: string, phone?: string) {
    const rows = await this.prisma.patient.findMany({
      where: {
        OR: [
          { fullName: { equals: fullName, mode: 'insensitive' } },
          ...(phone ? [{ phone }] : []),
        ],
      },
      select: { id: true, fullName: true, dob: true, phone: true },
      take: 10,
    });
    return { data: rows };
  }

  private async assertExists(id: number) {
    const exists = await this.prisma.patient.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException(`Patient ${id} not found`);
  }
}
