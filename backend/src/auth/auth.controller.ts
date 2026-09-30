import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SwitchRoleDto } from './dto/switch-role.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';
import { PasswordResetService } from './password-reset.service';
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
    private readonly reset: PasswordResetService,
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

  /**
   * Ask for a link, and spend one. The sixth and seventh `@Public()` routes.
   *
   * WHY THEY ARE PUBLIC, WHICH IS NOT A TAUTOLOGY
   * ---------------------------------------------
   * `@Public()` means unauthenticated, and the list of routes carrying it is
   * asserted as an exact set precisely so that adding one is a decision
   * somebody made rather than a decorator that drifted in. These two earn it
   * for the obvious reason — the person calling them cannot sign in — and they
   * are the first `@Public()` routes that *write to `users`*, which is why
   * everything about them is narrow: one address in, one identical sentence
   * out, and a single-use token in between.
   *
   * THE THROTTLES ARE DIFFERENT NUMBERS FOR DIFFERENT REASONS
   * ---------------------------------------------------------
   * Asking is 3/min, tighter than login's 5, because the cost of the abuse is
   * borne by somebody else: a script hammering this posts mail to a third
   * party's inbox, and a handful an hour is already a nuisance.
   *
   * Spending is 10/min. It is not guessable — 32 random bytes — so the limit is
   * not what stops an attack; it is there so that a broken client retrying in a
   * loop cannot turn one person's mistake into load.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @AuditAction('PASSWORD_RESET_REQUEST')
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.reset.request(dto.email, req.ip ?? null);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @AuditAction('PASSWORD_RESET_CONSUME')
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.reset.consume(dto.token, dto.newPassword, req.ip ?? null);
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
