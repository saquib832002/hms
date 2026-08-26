import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../auth/token.service';
import { AuthUser } from '../common/types/auth-user';
import {
  checkAccountChange,
  checkPasswordStrength,
  generateTemporaryPassword,
} from './account-rules';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { currentTenantId } from '../common/tenancy/tenant-context';
import {
  assignedRoles,
  checkRoleAssignment,
  resolveActiveRole,
  sortRolesForDisplay,
} from './role-assignment';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private tokens: TokenService,
  ) {}

  async findAll(includeInactive = true) {
    const users = await this.prisma.user.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      include: {
        doctorProfile: {
          select: { id: true, specialization: true, department: { select: { id: true, name: true } } },
        },
        roleAssignments: { select: { role: true } },
      },
    });

    // Never a raw model — `passwordHash` is on it, and one careless controller
    // return is all it takes.
    return {
      data: users.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        /** Where they land at sign-in. One of `roles`. */
        role: u.role,
        /**
         * Every role they may act as, one at a time. Sent so the admin screen
         * can show what a person is actually able to do — the default role
         * alone is misleading for an owner-doctor.
         */
        roles: sortRolesForDisplay(assignedRoles(u.roleAssignments, u.role)),
        isActive: u.isActive,
        mustChangePassword: u.mustChangePassword,
        lastLoginAt: u.lastLoginAt,
        lockedUntil: u.lockedUntil,
        createdAt: u.createdAt,
        doctor: u.doctorProfile
          ? {
              id: u.doctorProfile.id,
              specialization: u.doctorProfile.specialization,
              department: u.doctorProfile.department?.name ?? null,
            }
          : null,
      })),
    };
  }

  /**
   * Create a staff account.
   *
   * Returns a temporary password **once**. It is never stored in plaintext and
   * never retrievable — if the admin loses it before handing it over, they reset
   * it, which is a cheap operation. Emailing it would need a mail service that
   * does not exist here, and putting a credential in an unencrypted email is not
   * obviously better than reading it aloud.
   *
   * A DOCTOR also gets a `Doctor` profile in the same transaction. Without one
   * they cannot hold a clinic at all — appointments key on `Doctor.id` — and a
   * doctor account that silently cannot be booked is a confusing failure to
   * diagnose later.
   */
  async create(dto: CreateUserDto) {
    const email = dto.email.trim().toLowerCase();

    if (dto.role === UserRole.DOCTOR && !dto.specialization?.trim()) {
      throw new BadRequestException('A doctor needs a specialization');
    }

    const temporaryPassword = generateTemporaryPassword((n) => randomBytes(n));
    const passwordHash = await hash(temporaryPassword);

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            tenantId: currentTenantId(),
            email,
            fullName: dto.fullName.trim(),
            role: dto.role,
            passwordHash,
            mustChangePassword: true,
          },
        });

        // Mirror the default into an assignment, so every user has an explicit
        // record of what they may do rather than one implied by a column.
        await tx.userRoleAssignment.create({
          data: { tenantId: currentTenantId(), userId: created.id, role: dto.role },
        });

        if (dto.role === UserRole.DOCTOR) {
          await tx.doctor.create({
            data: {
              tenantId: currentTenantId(),
              userId: created.id,
              fullName: dto.fullName.trim(),
              specialization: dto.specialization!.trim(),
              departmentId: dto.departmentId ?? null,
              registrationNo: dto.registrationNo?.trim() || null,
            },
          });
        }

        return created;
      });

      return {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        /** Shown once. Not stored, not retrievable. */
        temporaryPassword,
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('An account with that email already exists');
      }
      throw err;
    }
  }

  /**
   * Change a role or activation state.
   *
   * The safety rules live in `account-rules.ts` and are checked before anything
   * is written. Deactivating also revokes every refresh token the user holds —
   * otherwise a deactivated account keeps working for up to seven days, which
   * makes "deactivate" a suggestion rather than an action.
   */
  async update(id: number, dto: UpdateUserDto, actor: AuthUser) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException(`User ${id} not found`);

    /*
     * Counted by who HOLDS admin, not whose default role is admin.
     *
     * This used to be `where: { role: ADMIN }`, which was right when a user had
     * exactly one role and is now the subtle version of the last-admin bug. An
     * owner-doctor who defaults to DOCTOR still holds ADMIN and can still
     * administer the hospital — counting defaults would report zero other
     * admins and block a perfectly safe change, and in the mirror case would
     * let the last real administrator be stripped while the count looked fine.
     */
    const otherActiveAdmins = await this.prisma.user.count({
      where: {
        isActive: true,
        id: { not: id },
        OR: [
          { role: UserRole.ADMIN },
          { roleAssignments: { some: { role: UserRole.ADMIN } } },
        ],
      },
    });

    if (dto.role !== undefined || dto.isActive !== undefined) {
      const violation = checkAccountChange({
        actorId: actor.userId,
        targetId: id,
        targetRole: target.role,
        targetIsActive: target.isActive,
        otherActiveAdmins,
        newRole: dto.role,
        newIsActive: dto.isActive,
      });

      if (violation && violation.code !== 'NO_CHANGE') {
        // 403 rather than 400 — the request is well-formed, it is just not
        // something this actor is allowed to do.
        throw new ForbiddenException(violation.message);
      }
    }

    // Promoting to DOCTOR needs a profile, same as creating one.
    if (dto.role === UserRole.DOCTOR && target.role !== UserRole.DOCTOR) {
      const existing = await this.prisma.doctor.findUnique({ where: { userId: id } });
      if (!existing) {
        throw new BadRequestException(
          'Create the doctor profile first — a doctor without one cannot be booked.',
        );
      }
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        fullName: dto.fullName?.trim(),
        role: dto.role,
        isActive: dto.isActive,
      },
    });

    if (dto.isActive === false) {
      await this.tokens.revokeAllForUser(id);
    }

    const { data } = await this.findAll();
    return data.find((u) => u.id === id);
  }

  /**
   * Set which roles a user may act as.
   *
   * The owner-doctor case: one login, several hats, one worn at a time. The
   * union is never granted — see role-assignment.ts and UserRoleAssignment.
   *
   * Sessions are NOT revoked on change. Removing a role cannot leak anything,
   * because JwtStrategy re-reads the assignments on every request and falls
   * back to a role the user still holds; a token claiming a revoked role stops
   * working on the next call rather than at expiry.
   */
  async setRoles(id: number, roles: UserRole[], actor: AuthUser) {
    const target = await this.prisma.user.findUnique({
      where: { id },
      include: { roleAssignments: { select: { role: true } }, doctorProfile: { select: { id: true } } },
    });
    if (!target) throw new NotFoundException(`User ${id} not found`);

    const current = assignedRoles(target.roleAssignments, target.role);
    const next = [...new Set(roles)];

    const otherAdminHolders = await this.prisma.user.count({
      where: {
        isActive: true,
        id: { not: id },
        OR: [
          { role: UserRole.ADMIN },
          { roleAssignments: { some: { role: UserRole.ADMIN } } },
        ],
      },
    });

    const violation = checkRoleAssignment({
      next,
      current,
      otherAdminHolders,
      hasDoctorProfile: Boolean(target.doctorProfile),
    });

    if (violation && violation.code !== 'NO_CHANGE') {
      throw new ForbiddenException(violation.message);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRoleAssignment.deleteMany({ where: { userId: id } });
      await tx.userRoleAssignment.createMany({
        data: next.map((role) => ({
          tenantId: target.tenantId,
          userId: id,
          role,
          grantedById: actor.userId,
        })),
      });

      // Keep the default valid. If the role they landed in was removed, move
      // the default to one they still hold rather than leaving a user whose
      // default is a role they cannot act as.
      if (!next.includes(target.role)) {
        await tx.user.update({
          where: { id },
          data: { role: resolveActiveRole(undefined, next.map((role) => ({ role })), next[0]) },
        });
      }
    });

    return { id, roles: sortRolesForDisplay(next) };
  }

  /** Issues a fresh temporary password and forces a change at next login. */
  async resetPassword(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundException(`User ${id} not found`);

    const temporaryPassword = generateTemporaryPassword((n) => randomBytes(n));
    await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash: await hash(temporaryPassword),
        mustChangePassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // A reset is also a "this account may be compromised" action, so existing
    // sessions go with it.
    await this.tokens.revokeAllForUser(id);

    return { id, temporaryPassword };
  }

  /**
   * A user changing their own password.
   *
   * Requires the current one even though the caller is already authenticated —
   * an unattended session should not be enough to lock the real owner out.
   *
   * Every other session is revoked afterwards. If the reason for changing was a
   * suspected compromise, leaving the attacker's session alive defeats the point.
   */
  async changeOwnPassword(dto: ChangePasswordDto, actor: AuthUser) {
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user) throw new NotFoundException('Account not found');

    const ok = await verify(user.passwordHash, dto.currentPassword).catch(() => false);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('The new password must be different');
    }

    const weakness = checkPasswordStrength(dto.newPassword);
    if (weakness) throw new BadRequestException(weakness);

    await this.prisma.user.update({
      where: { id: actor.userId },
      data: {
        passwordHash: await hash(dto.newPassword),
        mustChangePassword: false,
      },
    });

    await this.tokens.revokeAllForUser(actor.userId);
    return { changed: true };
  }
}
