import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The vendor's own staff, authenticated separately from every hospital user.
 *
 * WHY A SECOND TOKEN AUDIENCE AND NOT A CLAIM ON THE NORMAL ONE
 * ------------------------------------------------------------
 * A platform token is deliberately not a `UserRole`-bearing token with an extra
 * flag. `RolesGuard` decides clinical access by comparing `req.user.role`
 * against `@Roles(...)`, and a principal with no role can never satisfy it —
 * so a platform token cannot reach a clinical endpoint even if someone
 * mistakenly points it at one. That property comes from the shape of the token,
 * not from remembering to check a boolean.
 *
 * The `aud` claim is what keeps the two apart: a hospital access token is
 * rejected here, and a platform token is rejected by JwtStrategy because it
 * carries no `sub` that resolves to a User.
 */
export const PLATFORM_AUDIENCE = 'hms-platform';

export interface PlatformPrincipal {
  platformUserId: number;
  email: string;
  fullName: string;
}

export interface PlatformTokenPayload {
  sub: number;
  email: string;
  aud: typeof PLATFORM_AUDIENCE;
}

/**
 * Guards every /platform route.
 *
 * Re-reads the platform user on each request, for the same reason JwtStrategy
 * re-reads a hospital user: a deactivated vendor account must stop working now,
 * not when its token happens to expire.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) throw new UnauthorizedException('Platform token required');

    let payload: PlatformTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<PlatformTokenPayload>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
        audience: PLATFORM_AUDIENCE,
      });
    } catch {
      // Includes a perfectly valid *hospital* token — wrong audience, refused.
      throw new UnauthorizedException('Not a valid platform session');
    }

    const user = await this.prisma.unscoped.platformUser.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, fullName: true, isActive: true },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Platform account is not active');
    }

    (req as Request & { platform?: PlatformPrincipal }).platform = {
      platformUserId: user.id,
      email: user.email,
      fullName: user.fullName,
    };

    /*
     * Deliberately does NOT set req.user.
     *
     * req.user is what AuditInterceptor, TenantInterceptor and RolesGuard read.
     * Leaving it empty means a platform request opens no tenant transaction and
     * satisfies no @Roles() rule by construction — the platform controller does
     * its own tenant scoping, explicitly, per grant.
     */
    return true;
  }
}

/** The authenticated vendor staff member. */
export const CurrentPlatformUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PlatformPrincipal => {
    const req = ctx.switchToHttp().getRequest<Request & { platform?: PlatformPrincipal }>();
    if (!req.platform) throw new UnauthorizedException('No platform session');
    return req.platform;
  },
);
