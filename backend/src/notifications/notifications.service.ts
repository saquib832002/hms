import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { buildPushMessage, NotificationKind, PushMessage } from './notification-payload';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(private prisma: PrismaService) {}

  async registerDevice(userId: number, pushToken: string, platform?: string) {
    // A phone can change hands between staff. Upserting on the token rather
    // than (user, token) means re-registering moves it to the new user
    // instead of leaving the previous doctor's alerts going to it.
    return this.prisma.device.upsert({
      where: { pushToken },
      create: { userId, pushToken, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
  }

  async unregisterDevice(userId: number, pushToken: string) {
    await this.prisma.device.deleteMany({ where: { userId, pushToken } });
  }

  /**
   * Notify a doctor on every device they have registered.
   *
   * Fire-and-forget, like the audit writer and for the same reason: a push
   * service having a bad day must not fail or slow the clinical action that
   * triggered it. Reception checking a patient in has to succeed whether or
   * not Expo is reachable.
   */
  notifyDoctor(
    doctorUserId: number,
    kind: NotificationKind,
    ids: { appointmentId?: number; prescriptionId?: number } = {},
  ): void {
    void this.send(doctorUserId, kind, ids);
  }

  /**
   * WHY EVERY READ AND WRITE BELOW IS `unscoped`.
   *
   * THE BUG THIS FIXES
   * ------------------
   *     Push notification could not be delivered (PATIENT_CHECKED_IN):
   *     Transaction already closed: A query cannot be executed on a
   *     committed transaction.
   *
   * `notifyDoctor` is deliberately fire-and-forget — a push service having a
   * bad day must not fail a check-in — so `send` runs *after* the response has
   * gone out and after `TenantInterceptor`'s transaction has committed. But
   * `this.prisma.device` is proxied onto that transaction: `device` is a
   * global model, and `GLOBAL_MODELS` are routed through the request's own
   * transaction precisely so a request never asks the pool for a second
   * connection. Correct for anything that runs *inside* the request, and
   * exactly wrong for anything that outlives it.
   *
   * So this is the same class as the audit drain loop, which is already on the
   * `connection-budget.spec.ts` allow-list for the same reason: work scheduled
   * during a request and executed after it has to open its own connection,
   * because the one it was proxied onto is gone.
   *
   * IT IS ALSO SAFE, WHICH IS THE OTHER HALF
   * ----------------------------------------
   * `devices` carries no `tenantId` and no RLS policy — a push token belongs to
   * a *user*, and the lookup is already keyed on `userId`. So `unscoped`
   * returns exactly the rows the scoped client would have; nothing here reads
   * across a hospital boundary, and nothing here could.
   *
   * WHAT WAS REJECTED
   * -----------------
   * Awaiting the send inside the request would fix the error and destroy the
   * property the whole method exists for: reception's check-in would then wait
   * on Expo. Capturing the tenant and re-entering with `forTenant` would open a
   * transaction to read a table that has no policy — cost with no benefit.
   */
  private get db() {
    return this.prisma.unscoped;
  }

  private async send(
    userId: number,
    kind: NotificationKind,
    ids: { appointmentId?: number; prescriptionId?: number },
  ): Promise<void> {
    try {
      const devices = await this.db.device.findMany({
        where: { userId },
        select: { pushToken: true },
      });
      if (devices.length === 0) return;

      const messages: PushMessage[] = devices.map((d) => buildPushMessage(d.pushToken, kind, ids));

      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        this.logger.warn(`Push send failed: ${res.status}`);
        return;
      }

      const body = (await res.json()) as { data?: ExpoTicket[] };
      await this.pruneDeadTokens(messages, body.data ?? []);
    } catch (err) {
      // Deliberately swallowed — see notifyDoctor.
      this.logger.warn(
        `Push notification could not be delivered (${kind}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Expo reports DeviceNotRegistered for tokens belonging to uninstalled or
   * wiped devices. Leaving those rows in place means a phone that has left
   * the hospital keeps a live registration against a clinician's account.
   */
  private async pruneDeadTokens(messages: PushMessage[], tickets: ExpoTicket[]) {
    const dead = tickets
      .map((t, i) => (t.details?.error === 'DeviceNotRegistered' ? messages[i]?.to : null))
      .filter((t): t is string => Boolean(t));

    if (dead.length === 0) return;
    await this.db.device.deleteMany({ where: { pushToken: { in: dead } } });
    this.logger.log(`Removed ${dead.length} unregistered device token(s)`);
  }
}
