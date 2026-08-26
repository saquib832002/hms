import { IsEnum } from 'class-validator';
import { AppointmentStatus } from '@prisma/client';

export class ChangeStatusDto {
  @IsEnum(AppointmentStatus)
  status: AppointmentStatus;
}
