import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AuditOutcome, UserRole } from '@prisma/client';
import { AuditService } from './audit.service';
import { Roles } from '../common/decorators/roles.decorator';

class AuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() userId?: number;
  @IsOptional() @IsEnum(AuditOutcome) outcome?: AuditOutcome;
  @IsOptional() @IsString() targetType?: string;
  @IsOptional() @Type(() => Number) @IsInt() targetId?: number;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 50;
}

@Controller('audit')
@Roles(UserRole.ADMIN)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  find(@Query() q: AuditQueryDto) {
    return this.audit.find({
      userId: q.userId,
      outcome: q.outcome,
      targetType: q.targetType,
      targetId: q.targetId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      page: q.page ?? 1,
      limit: q.limit ?? 50,
    });
  }
}
