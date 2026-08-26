import { allNotificationTexts, buildPushMessage, NotificationKind } from './notification-payload';

/**
 * The lock-screen test.
 *
 * A push notification is the least controlled display in the system: it
 * renders on a locked phone lying on a ward desk, is copied into the OS
 * notification centre, and on some platforms syncs to a paired watch or
 * laptop. None of those surfaces are audited and none require authentication.
 *
 * So nothing patient-identifying may ever appear in one. This asserts that by
 * construction rather than by review.
 */

const KINDS: NotificationKind[] = [
  'PATIENT_CHECKED_IN',
  'QUEUE_WAITING',
  'PRESCRIPTION_QUERY',
  'CRITICAL_RESULT',
];

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';

describe('push notification payloads', () => {
  it('has a template for every kind', () => {
    for (const kind of KINDS) {
      const msg = buildPushMessage(TOKEN, kind);
      expect(msg.title).toBeTruthy();
      expect(msg.body).toBeTruthy();
    }
  });

  describe('no PHI on the lock screen', () => {
    // Names, conditions and values that must never surface. Drawn from the
    // seed data and from the vocabulary a real deployment would carry.
    const FORBIDDEN = [
      'Testpatient',
      'Alpha',
      'Anwar',
      'Khan',
      'penicillin',
      'hypertension',
      'diabetes',
      'troponin',
      'mg',
      'bp',
      'positive',
      'elevated',
      'diagnosis',
      'allergy',
    ];

    it.each(KINDS)('%s carries no patient-identifying words', (kind) => {
      const msg = buildPushMessage(TOKEN, kind, { appointmentId: 91, prescriptionId: 12 });
      const text = `${msg.title} ${msg.body}`.toLowerCase();

      for (const word of FORBIDDEN) {
        expect(text).not.toContain(word.toLowerCase());
      }
    });

    it('never lets a caller inject free text', () => {
      // buildPushMessage takes a kind and ids — there is no string parameter
      // for a message body. This is the property that makes the rule hold:
      // a future caller cannot pass `Patient ${name} is waiting`.
      const msg = buildPushMessage(TOKEN, 'PATIENT_CHECKED_IN', { appointmentId: 1 });
      expect(Object.keys(msg.data).sort()).toEqual(['appointmentId', 'kind']);
    });

    it('carries only numeric ids in the data payload', () => {
      const msg = buildPushMessage(TOKEN, 'PATIENT_CHECKED_IN', {
        appointmentId: 91,
        prescriptionId: 12,
      });
      for (const [key, value] of Object.entries(msg.data)) {
        if (key === 'kind') continue;
        expect(typeof value).toBe('number');
      }
    });

    it('keeps every possible text short enough not to be truncated into nonsense', () => {
      for (const text of allNotificationTexts()) {
        expect(text.length).toBeLessThan(80);
      }
    });
  });

  it('addresses the message to the given device token', () => {
    expect(buildPushMessage(TOKEN, 'QUEUE_WAITING').to).toBe(TOKEN);
  });

  it('groups alerts by kind so repeats collapse rather than stack', () => {
    // Five patients checking in should not produce five separate banners a
    // doctor has to dismiss one at a time.
    expect(buildPushMessage(TOKEN, 'PATIENT_CHECKED_IN').channelId).toBe('PATIENT_CHECKED_IN');
  });

  it('omits ids that were not supplied', () => {
    const msg = buildPushMessage(TOKEN, 'CRITICAL_RESULT');
    expect(msg.data).toEqual({ kind: 'CRITICAL_RESULT' });
  });
});
