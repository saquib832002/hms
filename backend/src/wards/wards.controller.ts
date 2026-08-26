import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { WardsService } from './wards.service';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';

/**
 * Ward and bed state.
 *
 * Reception is included on the ward list only — knowing which wards exist is
 * not clinical. The board itself shows patients, so it is clinical staff and
 * admin only.
 */
@Controller('wards')
export class WardsController {
  constructor(private readonly wards: WardsService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.NURSE, UserRole.DOCTOR, UserRole.RECEPTIONIST)
  findAll() {
    return this.wards.findAll();
  }

  /**
   * The board lists who is in which bed, with an allergy flag — clinical, so
   * clinical staff only.
   *
   * ADMIN is deliberately excluded. An administrator's legitimate need is bed
   * *occupancy*, which is a number and lives on the admin dashboard. Knowing
   * that B-04 holds a named patient with a recorded allergy is not an
   * operational fact.
   */
  @Get(':id/board')
  @Roles(UserRole.NURSE, UserRole.DOCTOR)
  @AuditAction('WARD_BOARD_VIEW')
  board(@Param('id', ParseIntPipe) id: number) {
    return this.wards.board(id);
  }
}
