import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PlatformRoute } from '../common/decorators/platform-route.decorator';
import { CurrentPlatformUser, PlatformGuard, PlatformPrincipal } from './platform-auth';
import { PlatformService } from './platform.service';
import { OpenGrantDto, PlatformLoginDto } from './dto/platform.dto';

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
