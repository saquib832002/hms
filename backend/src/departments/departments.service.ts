import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenantId } from '../common/tenancy/tenant-context';

@Injectable()
export class DepartmentsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const rows = await this.prisma.department.findMany({
      orderBy: { name: 'asc' },
      include: { doctors: { select: { id: true, fullName: true, specialization: true } } },
    });
    return {
      data: rows.map((d) => ({
        id: d.id,
        name: d.name,
        doctorCount: d.doctors?.length ?? 0,
        doctors: d.doctors ?? [],
      })),
    };
  }

  async create(name: string) {
    try {
      return await this.prisma.department.create({
        data: { tenantId: currentTenantId(), name: name.trim() },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A department with that name already exists');
      }
      throw err;
    }
  }

  async rename(id: number, name: string) {
    await this.require(id);
    try {
      return await this.prisma.department.update({ where: { id }, data: { name: name.trim() } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A department with that name already exists');
      }
      throw err;
    }
  }

  /**
   * Deleting a department is only allowed while it is empty.
   *
   * Doctors reference it, and historical appointments reference those doctors.
   * Removing a department out from under them would leave records pointing at a
   * department that never existed — better to make the admin move the doctors
   * first, which is what they would have to do in reality anyway.
   */
  async remove(id: number) {
    await this.require(id);
    const doctors = await this.prisma.doctor.count({ where: { departmentId: id } });
    if (doctors > 0) {
      throw new ConflictException(
        `${doctors} doctor${doctors === 1 ? '' : 's'} still assigned. Move them to another department first.`,
      );
    }
    await this.prisma.department.delete({ where: { id } });
    return { deleted: true };
  }

  private async require(id: number) {
    const found = await this.prisma.department.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException(`Department ${id} not found`);
    return found;
  }
}
