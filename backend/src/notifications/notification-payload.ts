/**
 * Push notification payloads.
 *
 * THE RULE: notification text contains no patient data. None.
 *
 * Not the name, not the age, not the condition, not a result value, not the
 * reason for the visit. A push notification renders on a lock screen — a
 * surface visible to anyone standing near a phone left on a ward desk, and
 * one that is also copied into the OS notification centre and, on some
 * platforms, synced to a paired watch or laptop. It is the least controlled
 * display in the entire system.
 *
 * So the notification says only that something needs attention. The `data`
 * payload carries an id, and the app fetches the detail over the authenticated
 * API *after* the doctor has unlocked the phone and re-authenticated. That
 * fetch is audited; a lock-screen glance is not.
 *
 * This is enforced by construction — callers cannot pass free text. Every
 * notification the system can send is one of the constants below.
 */

export type NotificationKind =
  | 'PATIENT_CHECKED_IN'
  | 'QUEUE_WAITING'
  | 'PRESCRIPTION_QUERY'
  | 'CRITICAL_RESULT';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Deep-link target. Ids only — never names, never clinical values. */
  data: { kind: NotificationKind; appointmentId?: number; prescriptionId?: number };
  sound: 'default';
  /** Collapses repeat alerts of the same kind rather than stacking them. */
  channelId: string;
}

const TEMPLATES: Record<NotificationKind, { title: string; body: string }> = {
  PATIENT_CHECKED_IN: {
    title: 'Patient waiting',
    body: 'A patient has checked in for you.',
  },
  QUEUE_WAITING: {
    title: 'Queue update',
    body: 'You have patients waiting.',
  },
  PRESCRIPTION_QUERY: {
    title: 'Pharmacy query',
    body: 'A prescription needs your clarification.',
  },
  CRITICAL_RESULT: {
    title: 'Result needs review',
    body: 'A result requires your attention.',
  },
};

export function buildPushMessage(
  pushToken: string,
  kind: NotificationKind,
  ids: { appointmentId?: number; prescriptionId?: number } = {},
): PushMessage {
  const template = TEMPLATES[kind];
  return {
    to: pushToken,
    title: template.title,
    body: template.body,
    data: { kind, ...ids },
    sound: 'default',
    channelId: kind,
  };
}

/** Every phrase this system is capable of putting on a lock screen. */
export function allNotificationTexts(): string[] {
  return Object.values(TEMPLATES).flatMap((t) => [t.title, t.body]);
}
