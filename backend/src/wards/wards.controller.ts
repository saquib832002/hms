import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole, TenantModule } from '@prisma/client';
import { WardsService } from './wards.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AddBedsDto, CreateWardDto, UpdateBedDto, UpdateWardDto } from './dto/ward.dto';

/**
 * Ward and bed state.
 *
 * Reception is included on the ward list only — knowing which wards exist is
 * not clinical. The board itself shows patients, so it is clinical staff and
 * admin only.
 */
@Controller('wards')
@RequiresModule(TenantModule.WARDS)
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

  /**
   * WARD AND BED SETUP — ADMIN ONLY, AND IT DID NOT EXIST FOR SIX PHASES
   * ====================================================================
   * Wards and beds were created by `seed.ts` and by nothing else. Any hospital
   * that did not run the demo seed — which is every hospital provisioned
   * through the platform — had none, and there was no way to make one short of
   * a database console.
   *
   * The consequence landed on the nurse, whose landing screen is the ward
   * board. `GET /wards` returned `[]`, so no ward was selected, so the board
   * was never requested and the page sat on its loading skeleton forever. It
   * read as a hung backend. Nothing was slow and nothing was broken; the
   * hospital simply had no wards, and no screen said so.
   *
   * Exactly the failure `KNOWN_GAPS` already records for the medicine
   * catalogue — an empty table with no way to fill it and nothing on screen
   * explaining why. That one was found on a real deployment too.
   *
   * Operational, not clinical: a ward is a room and a bed is furniture. The
   * board that says who is *in* the bed stays closed to admin above.
   */
  @Get('setup')
  @Roles(UserRole.ADMIN)
  @AuditAction('WARD_SETUP_VIEW')
  setup() {
    return this.wards.findAllWithBeds();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @AuditAction('WARD_CREATE')
  create(@Body() dto: CreateWardDto) {
    return this.wards.createWard(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('WARD_UPDATE')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateWardDto) {
    return this.wards.updateWard(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('WARD_DELETE')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.wards.removeWard(id);
  }

  @Post(':id/beds')
  @Roles(UserRole.ADMIN)
  @AuditAction('BED_CREATE')
  addBeds(@Param('id', ParseIntPipe) id: number, @Body() dto: AddBedsDto) {
    return this.wards.addBeds(id, dto.count, dto.prefix);
  }

  @Patch('beds/:bedId')
  @Roles(UserRole.ADMIN)
  @AuditAction('BED_UPDATE')
  updateBed(@Param('bedId', ParseIntPipe) bedId: number, @Body() dto: UpdateBedDto) {
    return this.wards.updateBed(bedId, dto);
  }

  @Delete('beds/:bedId')
  @Roles(UserRole.ADMIN)
  @AuditAction('BED_DELETE')
  removeBed(@Param('bedId', ParseIntPipe) bedId: number) {
    return this.wards.removeBed(bedId);
  }
}
