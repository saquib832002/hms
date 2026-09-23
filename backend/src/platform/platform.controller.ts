import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PlatformRoute } from '../common/decorators/platform-route.decorator';
import { CurrentPlatformUser, PlatformGuard, PlatformPrincipal } from './platform-auth';
import { PlatformService } from './platform.service';
import { OpenGrantDto, PlatformLoginDto } from './dto/platform.dto';
import {
  ApplicationQueryDto,
  ApproveApplicationDto,
  CreateTenantDto,
  RejectApplicationDto,
  SetSubscriptionDto,
} from './dto/provisioning.dto';
import { SetModulesDto } from './dto/set-modules.dto';

/**
 * Vendor sign-in. Separate controller from the rest on purpose.
 *
 * PlatformGuard is applied at the CLASS level on PlatformController below, so
 * a route added there is guarded by default rather than by remembering. Login
 * cannot be guarded — it is what produces the credential — so it lives here,
 * alone, where the exception is visible instead of hidden among ten siblings.
 */
@Controller('platform/auth')
@PlatformRoute()
export class PlatformAuthController {
  constructor(private readonly platform: PlatformService) {}

  /**
   * Tighter than the hospital login (5/min): there are a handful of vendor
   * accounts and no shift change that could legitimately produce a burst.
   */
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  login(@Body() dto: PlatformLoginDto) {
    return this.platform.login(dto.email, dto.password);
  }
}

/**
 * Everything a vendor engineer can do, which is deliberately little.
 *
 * @UseGuards at the class level, not per handler. The failure this prevents is
 * mundane and fatal: someone adds a sixth endpoint here in a hurry and forgets
 * the decorator, and it is reachable by anyone who can reach the port.
 */
@Controller('platform')
@PlatformRoute()
@UseGuards(PlatformGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  /** The hospitals on this deployment, with row counts — no patient data. */
  @Get('tenants')
  tenants() {
    return this.platform.tenants();
  }

  // ── onboarding ────────────────────────────────────────────────────────────

  /**
   * The signup queue.
   *
   * Note what is *not* here: no break-glass grant is needed to read it. A
   * grant is what buys a look inside somebody's hospital, and an application is
   * the vendor's own record about a hospital that does not exist yet.
   */
  @Get('applications')
  applications(@Query() query: ApplicationQueryDto) {
    return this.platform.applications(query.status);
  }

  /**
   * Approve, and create the hospital.
   *
   * The response carries the administrator's temporary password, once. It is
   * stored only as a hash, so there is no second chance to read it — which is
   * why the console shows it on a screen the reviewer has to dismiss rather
   * than in a toast.
   */
  @Post('applications/:id/approve')
  approveApplication(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveApplicationDto,
  ) {
    return this.platform.approveApplication(actor, id, dto);
  }

  @Post('applications/:id/reject')
  rejectApplication(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectApplicationDto,
  ) {
    return this.platform.rejectApplication(actor, id, dto.reason);
  }

  /** Onboard a hospital directly, with no application behind it. */
  @Post('tenants')
  createTenant(@CurrentPlatformUser() actor: PlatformPrincipal, @Body() dto: CreateTenantDto) {
    return this.platform.provision(actor, dto);
  }

  /**
   * Where a hospital stands commercially.
   *
   * The only lever the vendor has over a running hospital, and a blunt one on
   * purpose: it stops writes and never stops reads. A clinician must not lose
   * access to a patient record because of a billing event — see
   * `common/subscription/subscription.ts`.
   */
  @Patch('tenants/:id/subscription')
  setSubscription(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetSubscriptionDto,
  ) {
    return this.platform.setSubscription(actor, id, dto);
  }

  /**
   * What a hospital has been sold.
   *
   * Separate from the subscription, and the separation is the point: one is
   * what they bought, the other is whether they have paid. An overdue invoice
   * must not silently take a module away, and a payment must not silently give
   * one back — different decisions, different people, different moments.
   *
   * Removing one blocks new work and leaves every existing record readable.
   * The response reports how much data is stranded behind anything removed, so
   * the console can say so rather than leaving the vendor to hear it from the
   * customer.
   */
  @Patch('tenants/:id/modules')
  setModules(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetModulesDto,
  ) {
    return this.platform.setModules(actor, id, dto.modules);
  }

  @Post('break-glass')
  openGrant(@CurrentPlatformUser() actor: PlatformPrincipal, @Body() dto: OpenGrantDto) {
    return this.platform.openGrant(actor, dto);
  }

  @Get('break-glass')
  listGrants(@CurrentPlatformUser() actor: PlatformPrincipal) {
    return this.platform.listGrants(actor);
  }

  @Delete('break-glass/:id')
  revokeGrant(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.platform.revokeGrant(actor, id);
  }

  /** Operational state of one hospital. Requires a live grant against it. */
  @Get('tenants/:id/diagnostics')
  diagnostics(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.platform.diagnostics(actor, id);
  }
}
