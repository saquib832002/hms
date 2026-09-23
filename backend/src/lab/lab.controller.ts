import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole, TenantModule } from '@prisma/client';
import { LabService, WorklistFilter } from './lab.service';
import { LabReferralService } from './lab-referral.service';
import {
  AddLabPartnerDto,
  UpdateLabPartnerDto,
  SettlePartnerChargeDto,
  SettlePartnerStatementDto,
  CancelLabOrderDto,
  CreateLabOrderDto,
  CreateLabTestDto,
  CriticalNotifiedDto,
  DeclineLabReferralDto,
  RecordResultDto,
  RejectSpecimenDto,
  AcceptLabReferralDto,
  ReturnReferralResultDto,
  UpdateLabTestDto,
  VerifyLabOrderDto,
} from './dto/lab.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiresModule } from '../common/decorators/requires-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';

/** `?status=` on every queue. An unknown value falls back to the open items. */
function pick<T extends string>(allowed: readonly T[], raw: string | undefined, fallback: T): T {
  // Falls back rather than erroring. A 400 on a stale bookmark helps nobody,
  // and an empty list would read as "no work" — which sends somebody away from
  // a queue that actually has some in it.
  return allowed.find((s) => s === raw) ?? fallback;
}

/**
 * The test catalogue.
 *
 * Readable by the roles that have to choose from it, writable by ADMIN — and by
 * LAB_TECHNICIAN, for one reason: pricing. A test showing "not priced" on the
 * worklist was a dead end that sent the technician to a settings screen they
 * cannot reach, and in practice the test goes out unbilled. The pharmacy hit
 * exactly this and the fix was the same: expose a capability ADMIN already had
 * at the point where the gap is discovered.
 */
@Controller('lab-tests')
@RequiresModule(TenantModule.LABORATORY)
export class LabTestsController {
  constructor(private readonly lab: LabService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.DOCTOR, UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_CATALOGUE_VIEW')
  list(@Query('includeInactive') includeInactive?: string) {
    return this.lab.tests(includeInactive === 'true');
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @AuditAction('LAB_TEST_CREATE')
  create(@Body() dto: CreateLabTestDto) {
    return this.lab.createTest(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_TEST_UPDATE')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLabTestDto) {
    return this.lab.updateTest(id, dto);
  }
}

/**
 * Ordering, and reading a report.
 *
 * ADMIN appears nowhere on this controller. These routes name a patient and
 * carry their results, which is clinical by the same reading that keeps admin
 * off the ward board, the dispensing queue and the drug round —
 * `access-matrix.spec.ts` classifies this as a clinical controller and would
 * fail the build on an admin GET.
 */
@Controller('lab-orders')
@RequiresModule(TenantModule.LABORATORY)
export class LabOrdersController {
  constructor(private readonly lab: LabService) {}

  @Post()
  @Roles(UserRole.DOCTOR)
  @AuditAction('LAB_ORDER_CREATE')
  create(@Body() dto: CreateLabOrderDto, @CurrentUser() user: AuthUser) {
    return this.lab.createOrder(dto, user);
  }

  /**
   * Find a specimen by the number on its label.
   *
   * Declared before `:id` so an accession is never parsed as a row id — Nest
   * matches in declaration order, and `26-000412-K` hitting a `ParseIntPipe`
   * produces a 400 that reads as the scanner being broken.
   *
   * This is the whole of the scanner integration on a desktop, and that is not
   * a shortcut: bench barcode scanners are keyboard-wedge devices. They type
   * the characters and press Enter, exactly as a person would. A screen with a
   * focused input is what a laboratory information system actually presents,
   * and building a camera pipeline for it would be solving a problem the
   * hardware already solved.
   */
  /**
   * Raise the charge for an order that never got one.
   *
   * ADMIN and LAB_TECHNICIAN, the same pair that may price the catalogue —
   * this only re-reads a price they were already allowed to set. A doctor
   * cannot, for the same reason they cannot price a test.
   */
  @Post(':id/charge')
  @Roles(UserRole.ADMIN, UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_ORDER_CHARGE')
  raiseCharge(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.lab.raiseCharge(id, user);
  }

  @Get('by-accession/:code')
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_ORDER_VIEW')
  byAccession(@Param('code') code: string, @CurrentUser() user: AuthUser) {
    return this.lab.byAccession(code, user);
  }

  @Get(':id')
  @Roles(UserRole.DOCTOR, UserRole.NURSE, UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_ORDER_VIEW')
  detail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.lab.orderDetail(id, user);
  }

  /**
   * Retract an order.
   *
   * Built with a caller on both clients in the same change, deliberately.
   * `PATCH /prescriptions/:id/cancel` has been correct, tested and unreachable
   * since Phase 4, and a screen that reasons about a state nobody can produce
   * is the worst of the endpoints with no caller.
   */
  @Patch(':id/cancel')
  @Roles(UserRole.DOCTOR)
  @AuditAction('LAB_ORDER_CANCEL')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelLabOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.lab.cancelOrder(id, dto, user);
  }
}

/**
 * The lab's own bench.
 *
 * PHARMACIST is absent and so is ADMIN. A pharmacist reading every blood result
 * in the hospital is the minimum-necessary failure that made LAB_TECHNICIAN its
 * own role rather than an extension of an existing one.
 */
@Controller('lab')
@RequiresModule(TenantModule.LABORATORY)
export class LabWorklistController {
  constructor(
    private readonly lab: LabService,
    private readonly referrals: LabReferralService,
  ) {}

  @Get('worklist')
  /*
   * NURSE reads it too, for the send-out case: a clinic with no bench draws
   * the blood itself, and the person doing that has to be able to see what is
   * waiting. Reading a worklist names patients and tests, which is why this is
   * two clinical roles and not a wider grant.
   */
  @Roles(UserRole.LAB_TECHNICIAN, UserRole.NURSE)
  @AuditAction('LAB_WORKLIST_VIEW')
  worklist(@Query('status') status?: string) {
    return this.lab.worklist(
      pick(
        ['sendout', 'pending', 'collected', 'resulted', 'completed', 'all'] as const,
        status,
        'pending',
      ),
    );
  }

  /**
   * The specimen has been taken.
   *
   * NURSE as well as LAB_TECHNICIAN, and the reason is the send-out scenario.
   * A clinic with a doctor and no bench draws the blood itself and couriers the
   * tube — there is no laboratory technician in that building to press this,
   * and requiring one would leave the commonest send-out arrangement unable to
   * record a collection at all. On a ward it is a nurse who draws, which was
   * already recorded as a gap.
   *
   * Both roles are clinical and both already read the worklist. This is the
   * same shape as the medication round moving off "the phone is for looking":
   * withholding the screen never made the draw safer, it made it unrecorded.
   */
  @Post('orders/:id/collect')
  @Roles(UserRole.LAB_TECHNICIAN, UserRole.NURSE)
  @AuditAction('LAB_SPECIMEN_COLLECT')
  collect(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.lab.collect(id, user);
  }

  /**
   * The specimen could not be used.
   *
   * Distinct from cancelling: it returns the order to a collectable state,
   * because what it actually means is "take another sample". The reason is
   * required — a bare rejection sends a ward to the telephone.
   */
  /**
   * The tube has left for the partner laboratory.
   *
   * The same two roles that may collect, because it is the same person putting
   * the tube in the bag.
   */
  @Post('orders/:id/dispatch')
  @Roles(UserRole.LAB_TECHNICIAN, UserRole.NURSE)
  @AuditAction('LAB_SPECIMEN_DISPATCH')
  dispatch(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.lab.dispatch(id, user);
  }

  @Post('orders/:id/reject')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_SPECIMEN_REJECT')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectSpecimenDto) {
    return this.lab.reject(id, dto);
  }

  @Post('items/:itemId/result')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_RESULT_RECORD')
  result(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: RecordResultDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.lab.recordResult(itemId, dto, user);
  }

  /** Records that a human made the telephone call. Nothing here makes it. */
  @Post('items/:itemId/critical-notified')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_CRITICAL_NOTIFIED')
  criticalNotified(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: CriticalNotifiedDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.lab.recordCriticalCall(itemId, dto, user);
  }

  /**
   * Send an authorised report to the referring hospital again.
   *
   * The transmission fires from `verify`, and `verify` refuses on an order that
   * is already authorised — so a report that failed to reach the other hospital
   * was stuck for good, with nothing anywhere in the product able to send it.
   * This is the route out.
   *
   * Deliberately **not** a caller for `POST /lab/referrals/:id/result`. That
   * route takes a body of values and exists only for `LabService.verify` to
   * invoke; giving a client a way to post results into it would step around the
   * authorisation gate that accessioning a referral exists to impose. This one
   * takes no body at all — it rebuilds the payload from the authorised order.
   */
  @Post('orders/:id/report-back')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_REFERRAL_RESULT')
  reportBack(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.lab.reportBack(id, user);
  }

  /** Authorise. The moment a set of numbers becomes a result. */
  @Post('orders/:id/verify')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_REPORT_VERIFY')
  verify(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VerifyLabOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.lab.verify(id, dto, user);
  }

  // ── work sent to us by another hospital ──────────────────────────────────

  @Get('referrals')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_REFERRAL_QUEUE_VIEW')
  referralQueue(@Query('status') status?: string) {
    return this.referrals.inbound(
      pick(['waiting', 'resulted', 'declined', 'all'] as const, status, 'waiting'),
    );
  }

  /**
   * Send the result back to the hospital that ordered it.
   *
   * The write enters their tenant's scope. See `lab-referral.service.ts` for
   * the three refusals that make that narrow enough to be safe.
   */
  @Post('referrals/:id/result')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_REFERRAL_RESULT')
  returnResult(@Param('id', ParseIntPipe) id: number, @Body() dto: ReturnReferralResultDto) {
    return this.referrals.returnResult(id, dto);
  }

  /**
   * Take the work on, raising this laboratory's own order for it.
   *
   * The referral then runs the identical state machine as local work —
   * collect, bench, result, verify — and the result is transmitted back on
   * verification rather than typed into a form and fired across.
   */
  @Post('referrals/:id/accept')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_REFERRAL_ACCEPT')
  accept(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AcceptLabReferralDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.referrals.accept(id, user, dto.mappings ?? []);
  }

  @Post('referrals/:id/decline')
  @Roles(UserRole.LAB_TECHNICIAN)
  @AuditAction('LAB_REFERRAL_DECLINE')
  decline(@Param('id', ParseIntPipe) id: number, @Body() dto: DeclineLabReferralDto) {
    return this.referrals.decline(id, dto.reason);
  }
}

/**
 * Labs at other hospitals this one may send work to.
 *
 * Configuration, so ADMIN only and web only — the same line as departments,
 * staff accounts and partner pharmacies. Reading the list is wider, because the
 * prescribing screens need it to offer the choice.
 */
@Controller('lab-partners')
@RequiresModule(TenantModule.LABORATORY)
export class LabPartnersController {
  constructor(
    private readonly referrals: LabReferralService,
    private readonly lab: LabService,
  ) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.DOCTOR, UserRole.LAB_TECHNICIAN)
  findAll() {
    return this.referrals.partners();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @AuditAction('LAB_PARTNER_ADD')
  add(@Body() dto: AddLabPartnerDto) {
    return this.referrals.addPartner(dto);
  }

  /**
   * What we owe partner laboratories.
   *
   * Declared before `:id` routes so `charges` is never swallowed as an id —
   * Nest matches in declaration order, and `/lab-partners/charges` hitting a
   * `ParseIntPipe` produces a 400 that reads as the feature being broken.
   *
   * ADMIN and BILLING_STAFF: this is a payable, and it names no patient and no
   * test. `access-matrix.spec.ts` keeps every `/billing` route at exactly
   * `[ADMIN, BILLING_STAFF]`, and this route lives here rather than there for
   * the same reason the pharmacy till does — the boundary is worth more than
   * the file location.
   */
  @Get('charges')
  @Roles(UserRole.ADMIN, UserRole.BILLING_STAFF)
  charges(@Query('status') status?: 'outstanding' | 'settled' | 'all') {
    return this.referrals.partnerCharges(status ?? 'outstanding');
  }

  /**
   * The same charges, grouped into the month the laboratory bills as one.
   *
   * A reference laboratory sends one statement a month, not one invoice per
   * referral — so an outstanding list of forty rows could not be checked
   * against the piece of paper that actually arrives without adding a column of
   * figures up by eye. Declared before `:id`, like `charges` above and for the
   * same reason.
   */
  @Get('statements')
  @Roles(UserRole.ADMIN, UserRole.BILLING_STAFF)
  statements(
    @Query('month') month?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.lab.partnerStatements({ month, from, to });
  }

  /**
   * Mark one laboratory's month dealt with.
   *
   * Still not a payment: no money moves through this system between two
   * companies, and it writes no `Payment` row, because takings are counted from
   * that table. It is the per-row action applied to a month, reversible for the
   * same reason the per-row one is — the commonest correction is the wrong
   * line, and at this size the wrong month.
   */
  @Post('statements/:partnerTenantId/settle')
  @Roles(UserRole.ADMIN, UserRole.BILLING_STAFF)
  @AuditAction('PARTNER_LAB_STATEMENT_SETTLE')
  settleStatement(
    @Param('partnerTenantId', ParseIntPipe) partnerTenantId: number,
    @Body() dto: SettlePartnerStatementDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.lab.settlePartnerMonth(
      partnerTenantId,
      { month: dto.month, from: dto.from, to: dto.to },
      user,
      dto.settled,
      dto.note,
    );
  }

  @Post('charges/:id/settle')
  @Roles(UserRole.ADMIN, UserRole.BILLING_STAFF)
  @AuditAction('PARTNER_LAB_CHARGE_SETTLE')
  settle(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SettlePartnerChargeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.referrals.settlePartnerCharge(id, user, dto.settled, dto.note);
  }

  /**
   * Their price list, so a doctor can see what a referral will cost us before
   * sending it — and an administrator can price our own catalogue against it.
   */
  @Get(':id/catalogue')
  @Roles(UserRole.ADMIN, UserRole.DOCTOR, UserRole.LAB_TECHNICIAN)
  catalogue(@Param('id', ParseIntPipe) id: number) {
    return this.referrals.partnerCatalogue(id);
  }

  /**
   * Change how a partnership is billed.
   *
   * Not a field on add, because the commercial term changes long after the
   * partnership exists, and the only alternative was removing the partner and
   * adding them back — which soft-deletes a row that every order already sent
   * points at.
   */
  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('LAB_PARTNER_BILLING_CHANGE')
  updateBilling(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLabPartnerDto) {
    return this.referrals.setPartnerBilling(id, dto.billing);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @AuditAction('LAB_PARTNER_REMOVE')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.referrals.removePartner(id);
  }
}
