import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SwitchRoleDto } from './dto/switch-role.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditAction } from '../common/decorators/audit.decorator';
import { AuthUser } from '../common/types/auth-user';
import { ConfigService } from '@nestjs/config';

const REFRESH_COOKIE = 'hms_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  // Five attempts per account per minute. AppThrottlerGuard buckets this route
  // by IP *and* account — the default per-IP bucket locks out a shift change.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @AuditAction('AUTH_LOGIN')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken, user } = await this.auth.login(dto);
    this.setRefreshCookie(res, refreshToken);
    // Mobile has no usable cookie jar, so the token is returned in the body
    // too. Web clients should ignore it and rely on the httpOnly cookie.
    return { accessToken, refreshToken, user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @AuditAction('AUTH_REFRESH')
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = dto.refreshToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);
    const { accessToken, refreshToken } = await this.auth.refresh(raw ?? '');
    this.setRefreshCookie(res, refreshToken);
    return { accessToken, refreshToken };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @AuditAction('AUTH_LOGOUT')
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = dto.refreshToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);
    await this.auth.logout(raw);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  /**
   * Both clients call this on boot to build their navigation. The menu is
   * derived from the server's answer — never from a role constant compiled
   * into the client.
   */
  /**
   * Act as a different one of your own roles.
   *
   * Audited on purpose. "Why was the owner in the clinical records at 2am" is
   * a question a compliance review asks, and the switch is the moment that
   * answers it — AuditLog.actorRole records the hat worn for every action
   * after this point.
   */
  @Post('switch-role')
  @HttpCode(200)
  @AuditAction('AUTH_SWITCH_ROLE')
  switchRole(@CurrentUser() user: AuthUser, @Body() dto: SwitchRoleDto) {
    return this.auth.switchRole(user, dto.role);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  private setRefreshCookie(res: Response, token: string) {
    const isProd = this.config.get<string>('nodeEnv') === 'production';
    const days = this.config.get<number>('jwt.refreshTtlDays') ?? 7;
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: days * 24 * 60 * 60 * 1000,
    });
  }
}
