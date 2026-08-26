import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { DepartmentsService } from './departments.service';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';

class DepartmentDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
}

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  /** Reception books by department, so reading it is not admin-only. */
  @Get()
  @Roles(
    UserRole.ADMIN,
    UserRole.RECEPTIONIST,
    UserRole.DOCTOR,
    UserRole.NURSE,
    UserRole.PHARMACIST,
    UserRole.BILLING_STAFF,
  )
  findAll() {
    return this.departments.findAll();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @AuditAction('DEPARTMENT_CREATE')
  create(@Body() dto: DepartmentDto) {
    return this.departments.create(dto.name);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('DEPARTMENT_RENAME')
  rename(@Param('id', ParseIntPipe) id: number, @Body() dto: DepartmentDto) {
    return this.departments.rename(id, dto.name);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('DEPARTMENT_DELETE')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.departments.remove(id);
  }
}
