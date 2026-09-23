import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { UserRole, TenantModule } from '@prisma/client';
import { LabService } from './lab.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

/**
 * Every investigation for one patient, in one place.
 *
 * Nested under the patient rather than filtered on `/lab-orders?patientId=`,
 * matching records, prescriptions, vitals and admissions — and for a reason
 * beyond consistency: `resolveAuditTarget` keys on the param *name*, so a
 * nested clinical route yields `targetType=patient, targetId=<id>` and a denial
 * says which patient was reached for. That was `target=-` on exactly these
 * routes for six phases, discovered only on a live run.
 *
 * NURSE is included and ADMIN is not. A nurse on a ward round needs to know
 * what is outstanding on the patient in front of them; an administrator has no
 * clinical business here at all, which `access-matrix.spec.ts` enforces.
 *
 * LAB_TECHNICIAN is deliberately absent too. The lab works from its own
 * worklist, which is scoped to the tests somebody actually ordered from them —
 * browsing one patient's whole diagnostic history is not part of running an
 * assay, and minimum-necessary is not suspended because a role is
 * clinical-adjacent.
 */
@Controller('patients/:patientId/lab-orders')
@RequiresModule(TenantModule.LABORATORY)
export class PatientLabOrdersController {
  constructor(private readonly lab: LabService) {}

  @Get()
  @Roles(UserRole.DOCTOR, UserRole.NURSE)
  @AuditAction('LAB_ORDER_LIST')
  list(@Param('patientId', ParseIntPipe) patientId: number, @CurrentUser() user: AuthUser) {
    return this.lab.forPatient(patientId, user);
  }
}
