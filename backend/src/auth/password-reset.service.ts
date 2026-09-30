import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditOutcome } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { TokenService } from './token.service';
import { checkPasswordStrength } from '../users/account-rules';

/**
 * Setting a new password without knowing the old one.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS CLOSES
 * ────────────────────────────────────────────────────────────────────────────
 * Staff are reset by their administrator, and an administrator is reset by the
 * vendor under a break-glass grant. Both work and both need somebody else to be
 * available. This is the path that needs nobody: it costs the person their own
 * mailbox and thirty minutes, which is what everybody actually expects from a
 * sign-in screen.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RESPONSE IS THE SAME WHATEVER HAPPENS, AND THAT IS THE WHOLE DESIGN
 * ────────────────────────────────────────────────────────────────────────────
 * `request()` returns one identical body for an address that has an account, an
 * address that does not, a deactivated account, a suspended hospital, and an
 * SMTP server that refused the message. Anything else turns a public endpoint
 * into a way to ask "does this person work at this hospital" — the same
 * enumeration concern that shapes the signup form and the partner-code lookup,
 * and a sharper one here because the answer is about a named individual.
 *
 * Timing is deliberately not equalised, and saying so is more honest than
 * pretending: a hit does an Argon2-free but real amount of work a miss does
 * not. Closing that properly means a constant-time path or a queue, and the
 * throttle in front of this (3/min) is what makes the remaining signal too
 * expensive to harvest.
 *
 * The *reason* is logged every time, exactly as `LoginRefusal` is, so a support
 * call is answerable without the endpoint being an oracle.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE EMAIL, EVEN WHEN THE ADDRESS IS AT TWO HOSPITALS
 * ────────────────────────────────────────────────────────────────────────────
 * Email is unique per hospital, so one address can hold two accounts, and login
 * refuses to guess between them — correctly, because naming the hospitals on a
 * sign-in screen tells an attacker where an address is registered.
 *
 * That constraint does not apply here, and the difference is worth stating
 * because it looks like an inconsistency. The sign-in form answers *whoever is
 * typing*; this answers *the mailbox*. Telling the owner of an address which
 * hospitals it is registered at reveals nothing they do not already know, so
 * the message lists both with a separate link for each. This is the only place
 * in the product where that ambiguity can be resolved without the person
 * already knowing the hospital code.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A TOKEN IS
 * ────────────────────────────────────────────────────────────────────────────
 * 32 random bytes, stored only as a sha256 hash, single-use, thirty minutes.
 * The same construction as `RefreshToken`, deliberately — that one was hard to
 * get right and a second scheme beside it would be the one nobody re-reads.
 */
@Injectable()
export class PasswordResetService {
  private readonly log = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Whether the login screens should offer this at all.
   *
   * WHY THIS IS NOT SIMPLY `mail.canDeliver`
   * ----------------------------------------
   * It was, and that made a dead end out of the `log` transport. The only
   * person who ever runs with `log` is a developer on a machine with no SMTP
   * relay; the flow works end to end for them — the link is written to the API
   * log — and hiding the entrance left it reachable only by typing
   * `/reset-password`, a URL nobody had been given. That is the exact shape
   * this file records nine times over, reintroduced by a guard meant to
   * prevent it.
   *
   * So the question is not "will a message leave the building" but **"can the
   * person who needs the link actually get it"**, and there are two ways that
   * is true:
   *
   *  - `smtp` — always, in any environment.
   *  - `log` — only outside production, where whoever asked can read the
   *    server log. In production that is a real dead end and stays hidden,
   *    because a patient-facing deployment must not tell somebody to go and
   *    read a log they cannot see.
   *
   * `delivery` travels beside it so the clients can *say* which, rather than
   * offering a link in development that behaves differently from the one in
   * production with nothing on screen admitting it.
   */
  get available(): boolean {
    return this.mail.canDeliver || (this.mail.writesToLog && !this.isProduction);
  }

  /** `smtp` | `log` | `none` — what would actually happen to the message. */
  get delivery(): 'smtp' | 'log' | 'none' {
    if (this.mail.canDeliver) return 'smtp';
    return this.mail.writesToLog ? 'log' : 'none';
  }

  private get isProduction(): boolean {
    return (this.config.get<string>('nodeEnv') ?? 'development') === 'production';
  }

  /**
   * Ask for a link.
   *
   * Returns the same thing always. Everything interesting is in the log.
   */
  async request(rawEmail: string, ip: string | null) {
    const email = rawEmail.trim().toLowerCase();
    const same = {
      /*
       * Worded so it is true whether or not an account exists, without being
       * evasive enough to read as a brush-off. "If there is an account" is
       * doing the work; people understand it and it commits to nothing.
       */
      message:
        'If that address has an account, a link to set a new password is on its way. It expires in 30 minutes.',
    };

    if (this.delivery === 'none') {
      /*
       * Still the same response. A different one here would tell an
       * unauthenticated caller about the deployment's mail configuration, and
       * the person typing cannot act on it either way — the fix is an
       * administrator's, and the boot log already says so loudly.
       *
       * Keyed on `delivery === 'none'` rather than on `canDeliver`, so the
       * `log` transport falls through and actually mints a token: the whole
       * point of that mode is that a developer can follow the link out of the
       * server log, and returning here would have made it print nothing.
       */
      this.log.error(
        `Password reset requested for ${email} with no mail transport configured. Nothing was sent.`,
      );
      return same;
    }

    /*
     * The same two-step resolution login uses, and for the same reason: `users`
     * is RLS-protected on tenantId and no tenant is in scope on an
     * unauthenticated request, so a direct read returns nothing. The SECURITY
     * DEFINER function returns two integers and no personal data.
     */
    const candidates = await this.prisma.unscoped.$queryRaw<
      { user_id: number; tenant_id: number }[]
    >`SELECT user_id, tenant_id FROM app_login_lookup(${email}::text)`;

    if (candidates.length === 0) {
      this.log.warn(`Password reset: no account for ${email} (ip=${ip ?? '-'})`);
      return same;
    }

    const ttlMinutes = this.config.get<number>('passwordReset.ttlMinutes') ?? 30;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const links: { hospital: string; url: string }[] = [];

    for (const c of candidates) {
      const user = await this.prisma.forTenant(c.tenant_id, () =>
        this.prisma.user.findUnique({
          where: { id: c.user_id },
          select: { id: true, isActive: true, tenant: { select: { name: true } } },
        }),
      );

      /*
       * A deactivated account gets no link and no distinguishable response.
       * Deactivation is a decision an administrator made, and a reset flow that
       * quietly worked around it would let somebody who has been removed from a
       * hospital walk back in through the sign-in screen.
       */
      if (!user || !user.isActive) {
        this.log.warn(
          `Password reset: ${email} at tenant ${c.tenant_id} is ${user ? 'deactivated' : 'not readable'}`,
        );
        continue;
      }

      const raw = randomBytes(32).toString('hex');
      await this.prisma.unscoped.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(raw),
          expiresAt,
          requestedFor: email,
        },
      });

      links.push({
        hospital: user.tenant.name,
        url: `${this.config.get<string>('webUrl')}/reset-password?token=${raw}`,
      });

      this.audit.record({
        tenantId: c.tenant_id,
        userId: user.id,
        actorEmail: email,
        actorRole: null,
        action: 'PASSWORD_RESET_REQUESTED',
        method: 'POST',
        path: '/api/v1/auth/forgot-password',
        targetType: 'User',
        targetId: user.id,
        outcome: AuditOutcome.SUCCESS,
        statusCode: 202,
      });
    }

    if (links.length === 0) return same;

    const result = await this.mail.send({
      to: email,
      subject: 'Set a new password',
      text: buildResetEmail(links, ttlMinutes),
    });

    this.reportSend(email, result);

    return same;
  }

  /**
   * Say what happened to the message, at a level that matches what happened.
   *
   * This was `if (!delivered) log.error(...)`, which on a machine deliberately
   * running `MAIL_TRANSPORT=log` printed an ERROR about a flow that had just
   * worked — the link was in the log two lines above. An ERROR for behaviour
   * somebody asked for is worse than no log, because it teaches people that
   * this logger's errors are noise, and the next one is a real SMTP refusal
   * against a locked-out administrator.
   *
   * The same reasoning and the same three cases as the console side. Two
   * copies rather than one shared helper, because they log under different
   * contexts and name different settings — and the duplication is four lines
   * against an import that would couple the hospital auth module to the
   * platform one, which is a boundary this project keeps deliberately.
   */
  private reportSend(email: string, sent: { delivered: boolean; reason?: string }) {
    if (sent.delivered) {
      // Success says so. See the note on the console side: a log that goes
      // quiet on success cannot answer "did it send", which is the only
      // question anybody brings to it.
      this.log.log(`Reset link for ${email} was accepted by the mail server.`);
      return;
    }

    if (this.mail.writesToLog) {
      this.log.debug(
        `Reset link for ${email} was written to this log rather than emailed (MAIL_TRANSPORT=log). The message, including the link, is logged by MailService just above.`,
      );
      return;
    }

    if (!this.mail.canDeliver) {
      this.log.warn(
        `Reset link for ${email} was not sent: no mail transport is configured. Set MAIL_TRANSPORT.`,
      );
      return;
    }

    this.log.error(`Reset link for ${email} was not delivered: ${sent.reason}`);
  }

  /**
   * Spend a link and set the password.
   *
   * Three refusals, and each is load-bearing:
   *
   *  - **Unknown hash.** Either a link that never existed or one that was
   *    tampered with. Same message as the two below, because distinguishing
   *    them tells somebody holding a guessed token that they were close.
   *  - **Already consumed.** Single use, and the row is kept rather than
   *    deleted so a second presentation is visible in the log as a replay
   *    rather than indistinguishable from a link that never existed.
   *  - **Expired.** Checked here rather than relying on a sweep, because a
   *    sweep that has not run must never mean a dead link still works.
   */
  async consume(rawToken: string, newPassword: string, ip: string | null) {
    const refusal = new BadRequestException(
      'That link is no longer valid. Ask for a new one from the sign-in screen.',
    );

    const token = await this.prisma.unscoped.passwordResetToken.findUnique({
      where: { tokenHash: sha256(rawToken.trim()) },
    });

    if (!token) {
      this.log.warn(`Password reset: unknown token presented (ip=${ip ?? '-'})`);
      throw refusal;
    }
    if (token.consumedAt) {
      this.log.warn(
        `Password reset: token for user ${token.userId} presented again (ip=${ip ?? '-'})`,
      );
      throw refusal;
    }
    if (token.expiresAt <= new Date()) {
      this.log.warn(`Password reset: expired token for user ${token.userId} (ip=${ip ?? '-'})`);
      throw refusal;
    }

    /*
     * Strength is checked *before* the token is spent. Getting it wrong is the
     * commonest thing that happens on this form, and burning the link over a
     * password that was eleven characters long would send somebody back to the
     * sign-in screen to start again — which is how a recovery flow ends up
     * with a reputation for not working.
     */
    const weakness = checkPasswordStrength(newPassword);
    if (weakness) throw new BadRequestException(weakness);

    /*
     * Which hospital, from the user's row. `app_user_tenant` is the function
     * that exists for exactly this and it refuses a deactivated user or a
     * deactivated hospital — so an account that was disabled between asking for
     * the link and following it cannot use it, which is the right way round.
     */
    const [scope] = await this.prisma.unscoped.$queryRaw<
      { app_user_tenant: number | null }[]
    >`SELECT app_user_tenant(${token.userId}::bigint)`;

    const tenantId = scope?.app_user_tenant ?? null;
    if (tenantId === null) {
      this.log.warn(
        `Password reset: user ${token.userId} is no longer active, or their hospital is not`,
      );
      throw refusal;
    }

    // Hashed outside the transaction. Argon2 is deliberately slow — that is the
    // entire point of it — and doing it inside `forTenant` would hold a pool
    // connection for the duration, which is the shape of the self-deadlock this
    // project already shipped once.
    const passwordHash = await hash(newPassword);

    await this.prisma.forTenant(tenantId, () =>
      this.prisma.user.update({
        where: { id: token.userId },
        data: {
          passwordHash,
          // They have just chosen it, so there is nothing to force.
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
    );

    /*
     * Spend this one and kill every other outstanding link for the same person
     * in the same statement. Somebody who clicked "forgot password" three times
     * has three live tokens in their mailbox; leaving two of them working after
     * the password has changed means an attacker who obtained an earlier email
     * can take the account straight back.
     */
    await this.prisma.unscoped.passwordResetToken.updateMany({
      where: { userId: token.userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    // Same reasoning as every other password change here: a reset may be a
    // response to a compromise, and an untouched session defeats it.
    await this.tokens.revokeAllForUser(token.userId);

    this.audit.record({
      tenantId,
      userId: token.userId,
      actorEmail: token.requestedFor,
      actorRole: null,
      action: 'PASSWORD_RESET_COMPLETED',
      method: 'POST',
      path: '/api/v1/auth/reset-password',
      targetType: 'User',
      targetId: token.userId,
      outcome: AuditOutcome.SUCCESS,
      statusCode: 200,
    });

    return { changed: true };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The message itself.
 *
 * Plain text, no branding and no hospital letterhead. Three reasons, and the
 * third is the one that is easy to miss:
 *
 *  - A reset email is the single most impersonated message in existence, and
 *    the more it looks like marketing the less a careful person trusts it.
 *  - Nothing here is interpolated from a database except a hospital's own name,
 *    so there is nothing to escape.
 *  - A message that named the *person* would leak who holds an account at a
 *    hospital to anybody who later reads that mailbox, which in a small clinic
 *    is frequently shared. The hospital name has to be there — it is what makes
 *    two links distinguishable — and a personal name buys nothing.
 */
function buildResetEmail(links: { hospital: string; url: string }[], ttlMinutes: number): string {
  const head =
    links.length === 1
      ? `Somebody asked to set a new password for your account at ${links[0].hospital}.`
      : `Somebody asked to set a new password for this address. It has an account at ${links.length} hospitals, so there is a link for each:`;

  const body =
    links.length === 1
      ? links[0].url
      : links.map((l) => `${l.hospital}\n${l.url}`).join('\n\n');

  return [
    head,
    '',
    body,
    '',
    `The link${links.length > 1 ? 's expire' : ' expires'} in ${ttlMinutes} minutes and can be used once.`,
    '',
    // Deliberately not "if this was not you, contact support" with a number
    // nobody staffs. What it tells them is the true and useful thing: doing
    // nothing is safe.
    'If this was not you, ignore this message. Nothing has changed and the link stops working on its own.',
  ].join('\n');
}
