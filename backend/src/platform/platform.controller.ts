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
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PlatformRoute } from '../common/decorators/platform-route.decorator';
import { CurrentPlatformUser, PlatformGuard, PlatformPrincipal } from './platform-auth';
import { PlatformService } from './platform.service';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PlatformPasswordResetService } from './platform-password-reset.service';
import {
  ChangePlatformPasswordDto,
  ForgotPlatformPasswordDto,
  OpenGrantDto,
  PlatformLoginDto,
  ResetPlatformPasswordDto,
} from './dto/platform.dto';
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
  constructor(
    private readonly platform: PlatformService,
    private readonly reset: PlatformPasswordResetService,
    private readonly config: ConfigService,
  ) {}

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

  /**
   * Forgotten console password, and setting a new one.
   *
   * WHY THESE ARE NOT `@Public()`
   * -----------------------------
   * They are unauthenticated, which is what `@Public()` means — so this looks
   * like an omission and is not. `@Public()` is the hospital API's key, and
   * `access-matrix.spec.ts` asserts the *exact set* of routes carrying it,
   * which is one of the most valuable lines in the suite precisely because it
   * is short enough to read. Platform routes have carried `@PlatformRoute()`
   * since the console was built, for the same reason: folding a dozen vendor
   * endpoints into the hospital's public list would turn "these seven are open
   * to the world" into a sentence nobody could trust.
   *
   * They sit on this controller rather than the guarded one because, like
   * login, they are what a person without a credential uses.
   *
   * WHY ASKING IS THROTTLED HARDER THAN LOGIN
   * -----------------------------------------
   * 2/min against login's 3. There are a handful of vendor accounts and no
   * shift change that could produce a burst, and the cost of abuse lands on
   * somebody else's inbox. Spending a token is 10/min: 32 random bytes are not
   * guessable, so the limit is not what stops an attack — it stops a broken
   * client retrying in a loop.
   */
  @Post('forgot-password')
  @HttpCode(202)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  forgotPassword(@Body() dto: ForgotPlatformPasswordDto, @Req() req: Request) {
    return this.reset.request(dto.email, req.ip ?? null);
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resetPassword(@Body() dto: ResetPlatformPasswordDto, @Req() req: Request) {
    return this.reset.consume(dto.token, dto.newPassword, req.ip ?? null);
  }

  /**
   * Whether the sign-in page should offer the link at all.
   *
   * Its own route rather than reading the hospital `GET /health`, because the
   * console must call nothing but `/platform` — `endpoint-coverage.spec.ts`
   * fails the build on a vendor screen touching a hospital route, and that
   * assertion is worth more than one saved endpoint.
   *
   * It reports a property of the installation and nothing about any person or
   * hospital, which is what makes it safe to answer unauthenticated. It is
   * *necessary* because a link into a form that says a link is on its way and
   * sends nothing is the failure this project keeps recording.
   */
  @Get('capabilities')
  capabilities() {
    return {
      passwordResetDelivery: this.reset.delivery,
      passwordResetAvailable:
        this.reset.delivery === 'smtp' ||
        (this.reset.delivery === 'log' &&
          (this.config.get<string>('nodeEnv') ?? 'development') !== 'production'),
    };
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

  /**
   * A vendor account changing its own password.
   *
   * On the guarded controller rather than beside `platform/auth/login`, even
   * though it is an auth action: login cannot be guarded because it is what
   * produces the credential, and this can be. Putting it here means it inherits
   * the class-level `PlatformGuard` instead of needing a decorator somebody
   * could forget — which is the property that controller exists for.
   */
  @Post('password')
  @HttpCode(200)
  changePassword(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Body() dto: ChangePlatformPasswordDto,
  ) {
    return this.platform.changeOwnPlatformPassword(actor, dto.currentPassword, dto.newPassword);
  }

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

  /**
   * The hospital's administrators, and the way to reset one.
   *
   * These two close the last case in the system with no route in: a hospital
   * whose only administrator has forgotten their password. Everybody else is
   * reset by that administrator; the administrator was reset by nobody, and the
   * hospital was locked out of the product permanently.
   *
   * Both sit behind a break-glass grant like `diagnostics`, and the reset is
   * the *only* write the platform API makes into a hospital's `users` table.
   * It is narrow on purpose — a temporary password and nothing else — and it is
   * written into that hospital's own audit log rather than a vendor-side one.
   */
  @Get('tenants/:id/administrators')
  administrators(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.platform.administrators(actor, id);
  }

  @Post('tenants/:id/users/:userId/reset-password')
  resetTenantUserPassword(
    @CurrentPlatformUser() actor: PlatformPrincipal,
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.platform.resetTenantUserPassword(actor, id, userId);
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
