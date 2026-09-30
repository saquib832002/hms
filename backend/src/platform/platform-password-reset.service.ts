import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash } from '@node-rs/argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { checkPasswordStrength } from '../users/account-rules';

/**
 * Self-service password reset for vendor console accounts.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS FILE USED TO NOT EXIST, ON PURPOSE. READ THIS BEFORE CHANGING IT.
 * ────────────────────────────────────────────────────────────────────────────
 * `create-platform-user.js` has said since it was written that there is no
 * "forgot password" for vendor staff **and there should not be one**, because a
 * reset link emailed to a vendor address is a way into every hospital on the
 * deployment guarded by a single mailbox. That argument was right and is not
 * repealed by this file; it is answered by the controls below.
 *
 * Asked for by the product owner, who wanted recovery reachable from the login
 * page rather than from a shell. That is a legitimate call — a recovery path
 * that needs somebody with database access is a recovery path that fails at
 * weekends — and it is *their* call, not mine. What is mine is making sure the
 * thing built is the defensible version rather than the hospital flow copied
 * across with a different table name.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE THINGS THAT MAKE IT DEFENSIBLE
 * ────────────────────────────────────────────────────────────────────────────
 *  1. **Break-glass waits an hour.** `PlatformUser.passwordResetAt` is stamped
 *     and `openGrant` refuses until the cooling-off lapses. The console still
 *     works; reaching *inside* a hospital does not. The realistic attack is a
 *     compromised mailbox followed immediately by a grant into patient data,
 *     and this is the only control here that actually interrupts it.
 *  2. **Every other vendor account is told**, on the request and again on the
 *     completion. A takeover through one mailbox cannot be silent, which is
 *     the next best thing to preventing it — and unlike detection built on
 *     logs, it needs nobody to be looking.
 *  3. **Fifteen minutes, not thirty.** Half the window in which a link sitting
 *     in a mailbox is a working credential.
 *
 * None of the three stops a determined attacker who owns the mailbox. Together
 * they mean the window is short, the reach is limited while it is open, and
 * other people find out. That is a real trade and not a claim of safety.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT HERE
 * ────────────────────────────────────────────────────────────────────────────
 * Any way to *retrieve* a password. Passwords exist only as Argon2 hashes, so
 * there is nothing to retrieve and never will be — a system that could email
 * somebody their existing password is one storing it in a form it must not.
 */
@Injectable()
export class PlatformPasswordResetService {
  private readonly log = new Logger(PlatformPasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /**
   * Ask for a link.
   *
   * One identical response whatever happened — a real account, an unknown
   * address, a deactivated one, a refused SMTP server. Anything else turns an
   * unauthenticated endpoint into a way to enumerate the vendor's own staff,
   * and the list of people who can reach every hospital on a deployment is the
   * single worst list here to be able to confirm from outside.
   */
  async request(rawEmail: string, ip: string | null) {
    const email = rawEmail.trim().toLowerCase();
    const same = {
      message:
        'If that address has a console account, a link to set a new password is on its way. It expires in 15 minutes.',
    };

    if (this.delivery === 'none') {
      this.log.error(
        `Console password reset requested for ${email} with no mail transport. Nothing was sent.`,
      );
      return same;
    }

    /*
     * `unscoped` throughout this service. Platform routes set no tenant, so
     * there is no request transaction to join — `connection-budget.spec.ts`
     * names `platform/` among the places that is correct.
     */
    const account = await this.prisma.unscoped.platformUser.findUnique({
      where: { email },
    });

    if (!account || !account.isActive) {
      this.log.warn(
        `Console password reset: ${email} is ${account ? 'deactivated' : 'not a console account'} (ip=${ip ?? '-'})`,
      );
      return same;
    }

    const ttl = this.config.get<number>('passwordReset.platformTtlMinutes') ?? 15;
    const raw = randomBytes(32).toString('hex');

    await this.prisma.unscoped.platformPasswordResetToken.create({
      data: {
        platformUserId: account.id,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + ttl * 60_000),
        requestedFor: email,
      },
    });

    const url = `${this.config.get<string>('webUrl')}/platform?reset=${raw}`;

    const sent = await this.mail.send({
      to: account.email,
      subject: 'Set a new console password',
      text: [
        `Somebody asked to set a new password for your ${BRAND} console account.`,
        '',
        url,
        '',
        `The link expires in ${ttl} minutes and can be used once.`,
        '',
        // Said here because this is the one place the person reading it can
        // still act, and because meeting the cooling-off afterwards with no
        // warning reads as the console being broken.
        'For one hour after a reset you will be able to use the console but not open',
        'break-glass access into a hospital. That is deliberate.',
        '',
        'If this was not you, tell the rest of your team now — this address can reach',
        'every hospital on this deployment. Doing nothing is safe: the link expires on',
        'its own and nothing has changed yet.',
      ].join('\n'),
    });

    this.reportSend(email, sent);

    await this.notifyOthers(
      account.id,
      'A console password reset was requested',
      [
        `A password reset was requested for the console account ${account.email}.`,
        '',
        'Nothing has changed yet. You are being told because a console account can open',
        'break-glass access against any hospital on this deployment, so a takeover',
        'through one mailbox should not be something only the attacker knows about.',
        '',
        'If that was not them, the fastest fix is to deactivate the account directly in',
        'the database, or reset it yourself with `npm run platform:user`, which',
        'invalidates every outstanding link.',
      ].join('\n'),
    );

    return same;
  }

  /**
   * Spend a link.
   *
   * The same three refusals the hospital flow uses, reported identically —
   * unknown, already used, expired — because telling somebody holding a guessed
   * token which of the three they hit tells them they were close.
   */
  async consume(rawToken: string, newPassword: string, ip: string | null) {
    const refusal = new BadRequestException(
      'That link is no longer valid. Ask for a new one from the sign-in page.',
    );

    const token = await this.prisma.unscoped.platformPasswordResetToken.findUnique({
      where: { tokenHash: sha256(rawToken.trim()) },
      include: { platformUser: true },
    });

    if (!token) {
      this.log.warn(`Console reset: unknown token presented (ip=${ip ?? '-'})`);
      throw refusal;
    }
    if (token.consumedAt) {
      this.log.warn(
        `Console reset: token for account ${token.platformUserId} presented again (ip=${ip ?? '-'})`,
      );
      throw refusal;
    }
    if (token.expiresAt <= new Date()) {
      this.log.warn(`Console reset: expired token for account ${token.platformUserId}`);
      throw refusal;
    }
    if (!token.platformUser.isActive) {
      // Deactivated between asking and following. The right way round: a link
      // must not reactivate an account somebody deliberately switched off.
      this.log.warn(`Console reset: account ${token.platformUserId} is deactivated`);
      throw refusal;
    }

    /*
     * Strength before the token is spent. Burning a fifteen-minute link over an
     * eleven-character password sends somebody back to the login page to start
     * again, which is how a recovery flow earns a reputation for not working.
     */
    const weakness = checkPasswordStrength(newPassword);
    if (weakness) throw new BadRequestException(weakness);

    // Outside any transaction: Argon2 is deliberately slow and holding a
    // connection for its duration is the self-deadlock this project shipped once.
    const passwordHash = await hash(newPassword);

    await this.prisma.unscoped.platformUser.update({
      where: { id: token.platformUserId },
      data: { passwordHash, passwordResetAt: new Date() },
    });

    /*
     * This one and every other live link for the same account. Somebody who
     * clicked twice has two working credentials in their mailbox, and leaving
     * the second alive after the password changed means whoever obtained the
     * earlier email takes the account straight back.
     */
    await this.prisma.unscoped.platformPasswordResetToken.updateMany({
      where: { platformUserId: token.platformUserId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    this.log.warn(
      `Console password reset completed for ${token.platformUser.email} (ip=${ip ?? '-'})`,
    );

    await this.notifyOthers(
      token.platformUserId,
      'A console password was reset',
      [
        `The password for the console account ${token.platformUser.email} has just been reset`,
        'through an emailed link.',
        '',
        'If that was not them, act now: that account can open break-glass access against',
        'any hospital on this deployment. Break-glass is refused for the next hour, which',
        'is the window you have.',
      ].join('\n'),
    );

    const cooldown = this.config.get<number>('passwordReset.platformGrantCooldownMinutes') ?? 60;

    return {
      changed: true,
      /*
       * Returned so the screen can say it before the person meets it. Being
       * refused a grant an hour later with no warning reads as the console
       * being broken, and somebody debugging a refusal they were never told
       * about is how a deliberate control gets removed by the next reader.
       */
      breakGlassBlockedForMinutes: cooldown > 0 ? cooldown : null,
    };
  }

  /** `smtp` | `log` | `none` — mirrors the hospital side. */
  get delivery(): 'smtp' | 'log' | 'none' {
    if (this.mail.canDeliver) return 'smtp';
    return this.mail.writesToLog ? 'log' : 'none';
  }

  /**
   * Say what happened to the message, at a level that matches what happened.
   *
   * This was `if (!delivered) log.error(...)`, which printed
   *
   *     ERROR Console reset link for … was not delivered: transport is log
   *
   * on a development machine that was configured to do exactly that. The flow
   * had worked; the link was in the log two lines above. An ERROR for
   * behaviour somebody deliberately asked for is worse than no log at all,
   * because it teaches people that this logger's errors are noise — and the
   * next one will be a real SMTP refusal on a hospital that cannot recover an
   * account.
   *
   * So the level follows the cause rather than the boolean:
   *
   *  - `log` transport — expected, and `MailService` has already printed the
   *    whole message. A DEBUG line pointing at it, and nothing louder.
   *  - `none` — a misconfiguration, but one the boot log already shouted
   *    about. WARN, naming the setting.
   *  - `smtp` that failed — the only genuine error here. Nobody is getting a
   *    link and nobody downstream will be told, because the response to the
   *    user is identical either way, so this line is the whole record.
   */
  private reportSend(email: string, sent: { delivered: boolean; reason?: string }) {
    if (sent.delivered) {
      /*
       * Say so. This returned silently at first, and silence-means-success is
       * unreadable in a log: the only line anybody saw after a successful
       * reset was the *warning* below about nobody else being notified, which
       * reads as the reason nothing arrived. It was reported twice as the
       * cause and is not related to it at all.
       *
       * A log that goes quiet on success cannot be used to answer "did it
       * send", which is the only question anybody brings to it.
       */
      this.log.log(`Console reset link for ${email} was accepted by the mail server.`);
      return;
    }

    if (this.delivery === 'log') {
      this.log.debug(
        `Console reset link for ${email} was written to this log rather than emailed (MAIL_TRANSPORT=log). The message, including the link, is logged by MailService just above.`,
      );
      return;
    }

    if (this.delivery === 'none') {
      this.log.warn(
        `Console reset link for ${email} was not sent: no mail transport is configured. Set MAIL_TRANSPORT.`,
      );
      return;
    }

    this.log.error(`Console reset link for ${email} was not delivered: ${sent.reason}`);
  }

  /**
   * Tell the rest of the vendor team.
   *
   * Best-effort and never awaited into the caller's outcome: a mail server
   * having a bad day must not fail a reset somebody is in the middle of. The
   * failure is logged, because a notification nobody received and nobody knows
   * was not received is worse than one that was never designed.
   *
   * Deactivated accounts are excluded — they are not people who will act on it.
   */
  private async notifyOthers(exceptId: number, subject: string, text: string) {
    try {
      const others = await this.prisma.unscoped.platformUser.findMany({
        where: { id: { not: exceptId }, isActive: true },
        select: { email: true },
      });

      if (others.length === 0) {
        /*
         * A one-person vendor, which is the commonest shape early on. Worth a
         * log line rather than silence: it means the "somebody else finds out"
         * control is not operating, and whoever set the deployment up should
         * know that the mailbox is the whole of the security.
         */
        /*
         * Worded so it cannot be mistaken for the outcome of the reset itself.
         *
         * The first version said only "nobody else was told", and on a
         * one-person vendor that is the single line printed after a reset —
         * so it read as the explanation for a link that had not arrived, and
         * was reported as such twice. It is about a *different* email.
         */
        this.log.warn(
          'Console reset notification: this deployment has only one console account, so no other ' +
            'vendor staff could be told. This does not affect the reset link itself — it means the ' +
            '"somebody else finds out" control is not operating, and the account is exactly as ' +
            'safe as its mailbox.',
        );
        return;
      }

      for (const o of others) {
        await this.mail.send({ to: o.email, subject, text });
      }
    } catch (err) {
      this.log.error(
        `Could not notify other console accounts: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
}

/**
 * The product name, for the one message this service sends.
 *
 * A fourth copy, and deliberately so. The clients share theirs through
 * `types.ts`, which is duplicated byte-for-byte between them with a drift test;
 * the backend cannot import from either client and should not — the dependency
 * would run the wrong way, from the boundary that enforces the rules to the one
 * that draws them.
 *
 * A rebrand therefore has to touch this line as well as `BRAND_PARTS`. Stated
 * rather than hidden, because the copy that gets missed in a rename is always
 * the one nobody reads on an ordinary day, and an email is exactly that.
 */
const BRAND = 'OneCare';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
