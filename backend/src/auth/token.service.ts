import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessTokenPayload {
  sub: number;
  email: string;
  /** The role being acted as when this token was issued. */
  role: string;
  doctorId?: number;
  /**
   * Carried for diagnostics and as a tripwire only. Authorisation reads the
   * tenant from the user's row, never from here — a claim is whatever the
   * holder of a signing key says it is. JwtStrategy rejects the session if this
   * disagrees with the row.
   */
  tenantId?: number;
}

@Injectable()
export class TokenService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  /**
   * @param activeRole the role the session is acting as, when it differs from
   *   the user's default. Always re-validated against the user's assignments in
   *   JwtStrategy — a claim is only ever a request, never a grant.
   */
  async issueAccessToken(
    user: User & { doctorProfile?: { id: number } | null },
    activeRole?: string,
  ): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: activeRole ?? user.role,
      tenantId: user.tenantId,
      ...(user.doctorProfile ? { doctorId: user.doctorProfile.id } : {}),
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      // jsonwebtoken types this as a `ms` template literal ("15m", "7d"). The
      // value comes from env as a plain string, so it cannot be narrowed here.
      expiresIn: this.config.get<string>('jwt.accessTtl') as unknown as number,
    });
  }

  /**
   * Refresh tokens are opaque random strings, not JWTs — they need to be
   * revocable, and a self-contained token cannot be revoked.
   *
   * Only the SHA-256 hash is stored. SHA-256 rather than Argon2 is correct
   * here: the input is 64 bytes of CSPRNG output, so there is no low-entropy
   * guess to slow down, and this value is looked up on every refresh.
   */
  async issueRefreshToken(userId: number, familyId?: string): Promise<string> {
    const raw = randomBytes(64).toString('hex');
    const days = this.config.get<number>('jwt.refreshTtlDays') ?? 7;

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hash(raw),
        familyId: familyId ?? randomUUID(),
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      },
    });

    return raw;
  }

  /**
   * Consumes a refresh token and returns the family it belonged to.
   *
   * Reuse detection: if the presented token exists but is already revoked,
   * someone is replaying a token that was legitimately rotated away — either
   * the user's token was stolen, or a stolen one is being used alongside the
   * real session. There is no way to tell which, so the whole family is
   * revoked and both parties are forced to log in again. Annoying for a
   * legitimate user; correct when the alternative is an attacker holding a
   * valid session against patient records.
   */
  async consumeRefreshToken(raw: string): Promise<{ userId: number; familyId: string }> {
    const tokenHash = this.hash(raw);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!existing) throw new UnauthorizedException('Invalid session');

    if (existing.revokedAt) {
      await this.revokeFamily(existing.familyId);
      throw new UnauthorizedException('Session revoked. Please sign in again.');
    }

    if (existing.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    return { userId: existing.userId, familyId: existing.familyId };
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeToken(raw: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
