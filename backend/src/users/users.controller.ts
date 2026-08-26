import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetRolesDto } from './dto/set-roles.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

@Controller('users')
@Roles(UserRole.ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @AuditAction('USER_LIST')
  findAll() {
    return this.users.findAll();
  }

  @Post()
  @AuditAction('USER_CREATE')
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  /**
   * Which roles this person may act as.
   *
   * The owner-doctor case: one login, several hats, one worn at a time. The
   * union of permissions is never granted — see role-assignment.ts.
   */
  @Patch(':id/roles')
  @AuditAction('USER_SET_ROLES')
  setRoles(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetRolesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.users.setRoles(id, dto.roles, user);
  }

  @Patch(':id')
  @AuditAction('USER_UPDATE')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.users.update(id, dto, user);
  }

  @Post(':id/reset-password')
  @AuditAction('USER_PASSWORD_RESET')
  resetPassword(@Param('id', ParseIntPipe) id: number) {
    return this.users.resetPassword(id);
  }

  // No DELETE. Audit rows reference users, and a deleted user turns every
  // historical entry into "unknown" — which is the opposite of an audit trail.
}

/**
 * Changing your own password is not an admin action, so it lives outside the
 * admin-gated controller. Any authenticated user can — and a user with
 * `mustChangePassword` set has to before anything else works.
 */
@Controller('me')
export class MePasswordController {
  constructor(private readonly users: UsersService) {}

  @Post('password')
  @AuditAction('PASSWORD_CHANGE')
  changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthUser) {
    return this.users.changeOwnPassword(dto, user);
  }
}
