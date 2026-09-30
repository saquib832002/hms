import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The only thing in this system that sends a message to a person outside it.
 *
 * WHY IT REPORTS DELIVERY RATHER THAN RETURNING VOID
 * --------------------------------------------------
 * Every caller here is a flow that is worthless if the message does not arrive
 * — a reset link that was never sent is a user waiting forever for an email,
 * and the only thing worse than no self-service reset is one that silently does
 * nothing. So `send` answers whether it went, and the caller is expected to do
 * something with that answer even when it cannot tell the user (the reset flow
 * must give the same response either way; it logs the truth instead).
 *
 * WHY NODEMAILER IS LOADED DYNAMICALLY
 * ------------------------------------
 * A static import makes an uninstalled dependency a compile failure across the
 * whole API — the pharmacy screens and the ward board go down because nobody
 * ran `npm install` for a mail library. The same shape as `expo-notifications`
 * taking the entire phone app down from one top-level import in a screen
 * nobody had opened. Here the failure is contained to this method, names
 * itself, and leaves every other route working.
 *
 * It also means a deployment that does not want mail simply does not install
 * it, and gets a clear log line rather than a crash.
 *
 * WHY THERE IS A `log` TRANSPORT AND WHY IT IS NOT A LIE
 * -----------------------------------------------------
 * In development there is no SMTP server and there should not need to be. The
 * `log` transport writes the whole message to the server log, **including the
 * link**, so a developer can follow the flow end to end — and reports
 * `delivered: false`, because nothing was delivered. A transport that printed
 * to a console and returned success would make every caller believe mail works
 * here, which is precisely the class of false reassurance this codebase keeps
 * having to unpick.
 */
export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. Deliberately the only body format — see the note below. */
  text: string;
}

export interface MailResult {
  delivered: boolean;
  /** Why not, for the server log. Never shown to a user. */
  reason?: string;
}

type Transport = 'smtp' | 'log' | 'none';

@Injectable()
export class MailService implements OnModuleInit {
  private readonly log = new Logger(MailService.name);
  /** Resolved once; `undefined` means "not tried yet", `null` means "cannot". */
  /**
   * Both members are used: `sendMail` by `send`, `verify` by the boot check.
   * Declared together rather than casting at the call site — a cast there
   * would be asserting the shape twice and letting the two disagree.
   */
  private mailer:
    | {
        sendMail: (m: Record<string, unknown>) => Promise<unknown>;
        verify: () => Promise<boolean>;
      }
    | null
    | undefined;

  constructor(private readonly config: ConfigService) {}

  /**
   * Say at boot what will happen, rather than at the moment somebody needs it.
   *
   * A hospital discovers an unconfigured mail transport when a locked-out
   * administrator asks for a reset link that never comes — which is the worst
   * possible moment and the hardest to diagnose, because the form said the
   * right thing. This puts it in the startup log beside the pending-migration
   * warning, for the same reason that one exists: the cause and the symptom are
   * far apart, and only the cause is cheap to state.
   */
  onModuleInit() {
    switch (this.transport()) {
      case 'smtp':
        this.log.log(`Mail: SMTP via ${this.config.get<string>('mail.host')}`);
        /*
         * Prove it, rather than announcing it.
         *
         * "Mail: SMTP via host" only ever said what the config *claimed*. A
         * wrong password, a blocked port or a host that does not resolve all
         * produced that same reassuring line, and the first anybody heard of
         * the problem was a locked-out administrator whose link never came —
         * with the flow's own response identical either way, by design.
         *
         * So the boot log now carries the answer instead of the intention.
         *
         * Fire-and-forget, and never awaited into startup: a mail server
         * having a bad morning must not stop the API from booting, for the
         * same reason a pending migration is a warning rather than a refusal.
         * The whole ward board does not go down because nobody can be emailed.
         */
        void this.verifyAtBoot();
        break;
      case 'log':
        this.log.warn(
          'Mail: transport is "log" — messages are written to this log and NOT delivered. ' +
            'Self-service password reset will not reach anybody. Set MAIL_TRANSPORT=smtp for real delivery.',
        );
        break;
      default:
        this.log.warn(
          'Mail: no transport configured (MAIL_TRANSPORT unset). Nothing is sent. ' +
            'Self-service password reset is unavailable; an administrator resets staff from ' +
            'Admin → Users, and the vendor resets an administrator under a break-glass grant.',
        );
    }
  }

  /**
   * Authenticate against the configured server once, at boot, and say so.
   *
   * `verify()` opens a connection and completes the SMTP handshake including
   * AUTH, without sending anything. It is the difference between "this is
   * configured" and "this works", and the two have looked identical in the log
   * for as long as this service has existed.
   *
   * Deliberately not fatal and deliberately not retried. One line at startup
   * is the whole point: somebody restarting the API to test a reset sees
   * whether mail is going to work *before* they click anything, rather than
   * inferring it from an email that never arrives.
   */
  private async verifyAtBoot() {
    const mailer = await this.smtp();
    if (!mailer) return; // `smtp()` has already logged why.

    try {
      await mailer.verify();
      this.log.log('Mail: SMTP verified — the server accepted this API’s credentials.');
    } catch (err) {
      this.log.error(
        `Mail: SMTP is configured but verification FAILED — ${
          err instanceof Error ? err.message : 'unknown error'
        }. Nothing will be delivered. Diagnose with: npm run mail:test`,
      );
    }
  }

  /** Whether a message sent now would actually leave the building. */
  get canDeliver(): boolean {
    return this.transport() === 'smtp';
  }

  /**
   * Whether it would at least be written where a developer can read it.
   *
   * Distinct from `canDeliver` on purpose. Nothing may treat this as delivery —
   * `send` still reports `delivered: false` — but a caller deciding whether a
   * flow is *reachable* has a different question to ask, and collapsing the two
   * is what made the `log` transport a dead end for the one person who uses it.
   */
  get writesToLog(): boolean {
    return this.transport() === 'log';
  }

  private transport(): Transport {
    const t = (this.config.get<string>('mail.transport') ?? '').trim().toLowerCase();
    if (t === 'smtp') return 'smtp';
    if (t === 'log') return 'log';
    return 'none';
  }

  async send(message: MailMessage): Promise<MailResult> {
    const transport = this.transport();

    if (transport === 'none') {
      return { delivered: false, reason: 'no mail transport configured' };
    }

    if (transport === 'log') {
      /*
       * The whole message, framed so it can be found by eye in a busy dev log.
       *
       * This is the only place the reset link exists on a machine with no
       * relay, so somebody following the flow has to be able to spot it while
       * the ward board's fifteen-second refresh is also printing. The rule
       * separators are there to be scanned for, not for decoration.
       *
       * WARN rather than LOG because nothing was delivered — that stays true
       * and the level should keep saying so. What was wrong was the *caller*
       * additionally raising an ERROR about it, which is fixed at each caller.
       */
      this.log.warn(
        [
          '',
          '──────── EMAIL NOT SENT (MAIL_TRANSPORT=log) ────────',
          `to:      ${message.to}`,
          `subject: ${message.subject}`,
          '',
          message.text,
          '─────────────────────────────────────────────────────',
        ].join('\n'),
      );
      return { delivered: false, reason: 'transport is log' };
    }

    const mailer = await this.smtp();
    if (!mailer) {
      return { delivered: false, reason: 'SMTP transport could not be created' };
    }

    try {
      await mailer.sendMail({
        from: this.config.get<string>('mail.from'),
        to: message.to,
        subject: message.subject,
        /*
         * Text only, no HTML alternative, and that is a decision. Every message
         * this system sends is a short instruction with one link in it; an HTML
         * part buys nothing and costs the two things that matter here — it is
         * what makes a message look like the phishing it resembles, and it is
         * where an unescaped name would become an injection. Plain text cannot
         * carry either.
         */
        text: message.text,
      });
      return { delivered: true };
    } catch (err) {
      /*
       * Logged with the reason and swallowed. The caller decides what the user
       * is told, and for the reset flow that is the same sentence either way —
       * so the reason has to live here or it is lost entirely. A cross-tenant
       * write that fails at 4pm on a Friday taught this lesson once already.
       */
      const reason = err instanceof Error ? err.message : 'unknown SMTP failure';
      this.log.error(`Mail to ${message.to} failed: ${reason}`);
      return { delivered: false, reason };
    }
  }

  private async smtp() {
    if (this.mailer !== undefined) return this.mailer;

    try {
      /*
       * The specifier is a variable, not a literal, and that is deliberate.
       *
       * `await import('nodemailer')` with a literal makes TypeScript resolve
       * the module at compile time — so a tree without it installed fails
       * `tsc --noEmit` for the whole API, which is precisely the coupling the
       * dynamic import exists to avoid. Held in a constant, the compiler leaves
       * it alone and the only consequence of an uninstalled dependency is the
       * catch below, on the one code path that needs it.
       *
       * The shape is asserted rather than imported for the same reason: pulling
       * in `@types/nodemailer` would reintroduce a hard build-time dependency
       * to describe an optional runtime one. Only two members are used, and
       * both are pinned by the assertion.
       */
      const specifier = 'nodemailer';
      const nodemailer = (await import(specifier)) as unknown as {
        createTransport: (opts: Record<string, unknown>) => {
          sendMail: (m: Record<string, unknown>) => Promise<unknown>;
          verify: () => Promise<boolean>;
        };
      };

      const user = this.config.get<string>('mail.user');
      const pass = this.config.get<string>('mail.pass');

      this.mailer = nodemailer.createTransport({
        host: this.config.get<string>('mail.host'),
        port: this.config.get<number>('mail.port'),
        // `secure` means implicit TLS on 465. On 587 the connection starts
        // plain and upgrades with STARTTLS, which nodemailer does by default —
        // setting `secure: true` there produces a hang rather than an error,
        // which is the least diagnosable failure mode available.
        secure: this.config.get<boolean>('mail.secure'),
        auth: user ? { user, pass } : undefined,
      });
    } catch (err) {
      this.mailer = null;
      this.log.error(
        `Mail: could not load nodemailer (${err instanceof Error ? err.message : 'unknown'}). ` +
          'Run `npm install` in backend/. Nothing else is affected.',
      );
    }

    return this.mailer;
  }
}
