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

  private async send(
    userId: number,
    kind: NotificationKind,
    ids: { appointmentId?: number; prescriptionId?: number },
  ): Promise<void> {
    try {
      const devices = await this.prisma.device.findMany({
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
    await this.prisma.device.deleteMany({ where: { pushToken: { in: dead } } });
    this.logger.log(`Removed ${dead.length} unregistered device token(s)`);
  }
}
