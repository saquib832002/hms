import { Body, Controller, Delete, HttpCode, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

/**
 * Device registration for push notifications.
 *
 * Restricted to the roles that actually have a mobile app. A billing clerk
 * registering a device would be harmless today but is not something to leave
 * open by default.
 */
@Controller('devices')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST)
  @HttpCode(204)
  @AuditAction('DEVICE_REGISTER')
  async register(@Body() dto: RegisterDeviceDto, @CurrentUser() user: AuthUser) {
    await this.notifications.registerDevice(user.userId, dto.pushToken, dto.platform);
  }

  @Delete()
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST)
  @HttpCode(204)
  @AuditAction('DEVICE_UNREGISTER')
  async unregister(@Body() dto: RegisterDeviceDto, @CurrentUser() user: AuthUser) {
    await this.notifications.unregisterDevice(user.userId, dto.pushToken);
  }
}
